"use strict";

const { randomBytes, createCipheriv, createDecipheriv } = require('crypto');
const { hashToken } = require('./auth-storage');
const { performance } = require('perf_hooks');

const ACCESS_TTL = 900;
const REFRESH_IDLE_TTL = 604800;
const SESSION_TTL = 1814400;
const REFRESH_REUSE_GRACE = 30;

function reuseGrace(value = REFRESH_REUSE_GRACE)
{
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 120)
        throw new Error('Refresh reuse grace must be an integer from 0 to 120');
    return seconds;
}

function boundedTtl(value, maximum)
{
    const seconds = Number(value);
    if (value === undefined || value === '') return maximum;
    if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error('Token TTL must be a positive integer');
    return Math.min(seconds, maximum);
}

function refreshEncryptionKey(value)
{
    if (!value) return null;
    if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error('Refresh key must contain 64 hex characters');
    return Buffer.from(value, 'hex');
}

class RefreshTokenStore
{
    constructor(storage, namespace, key, idleTtl, sessionTtl, grace = REFRESH_REUSE_GRACE)
    {
        this.storage = storage;
        this.namespace = namespace;
        this.key = key;
        this.idleTtl = idleTtl;
        this.sessionTtl = sessionTtl;
        this.grace = reuseGrace(grace);
    }

    seal(token, purpose = '')
    {
        if (typeof token !== 'string' || !token) throw new Error('Provider refresh token is missing');
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(this.namespace + purpose));
        const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    }

    open(value, purpose = '')
    {
        const bytes = Buffer.from(value, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(this.namespace + purpose));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }

    async readSession(id)
    {
        return this.storage().get('refresh-session:' + this.namespace, id);
    }

    async read(token)
    {
        const pointer = await this.storage().get('refresh:' + this.namespace, hashToken(token));
        return pointer ? this.readSession(pointer.sessionId) : null;
    }

    async revoke(id)
    {
        await this.storage().delete('refresh-session:' + this.namespace, id);
    }

    async savePointer(token, session)
    {
        const ttl = Math.ceil((session.expiresAt - Date.now()) / 1000);
        if (ttl <= 0) throw new Error('Refresh session expired');
        await this.storage().set('refresh:' + this.namespace, hashToken(token), { sessionId: session.id }, ttl);
    }

    async create(data)
    {
        const now = Date.now();
        const token = randomBytes(32).toString('base64url');
        const session = { ...data, id: randomBytes(32).toString('base64url'), state: 'active',
            tokenHash: hashToken(token), expiresAt: Math.min(data.expiresAt || Infinity, now + this.sessionTtl * 1000),
            idleExpiresAt: now + Math.min(this.idleTtl, this.sessionTtl) * 1000 };
        session.idleExpiresAt = Math.min(session.idleExpiresAt, session.expiresAt);
        if (session.idleExpiresAt <= now) throw new Error('Refresh session expired');
        await this.storage().set('refresh-session:' + this.namespace, session.id, session,
            Math.ceil((session.idleExpiresAt - now) / 1000));
        await this.savePointer(token, session);
        return { token, session };
    }

    async claim(session, token)
    {
        const tokenHash = hashToken(token);
        const deadline = performance.now() + 5000;
        while (session)
        {
            if (session.tokenHash !== tokenHash)
            {
                const reuse = this.grace && await this.storage().get('refresh-reuse:' + this.namespace, tokenHash);
                if (reuse && reuse.sessionId === session.id && reuse.expiresAt > Date.now())
                    return { reuse: JSON.parse(this.open(reuse.result, ':reuse:' + session.id + ':' + tokenHash)),
                        accessExpiresAt: reuse.accessExpiresAt };
                await this.revoke(session.id);
                return null;
            }
            if (session.state === 'active')
            {
                const claimed = { ...session, state: 'refreshing', claimId: randomBytes(16).toString('hex'),
                    claimExpiresAt: Math.min(Date.now() + 60000, session.idleExpiresAt, session.expiresAt) };
                if (await this.replace(session, claimed)) return claimed;
            }
            if (!this.grace) { await this.revoke(session.id); return null; }
            if (session.state === 'refreshing' && session.claimExpiresAt <= Date.now())
            {
                const active = { ...session, state: 'active' };
                delete active.claimId;
                delete active.claimExpiresAt;
                if (await this.replace(session, active)) { session = active; continue; }
            }
            if (performance.now() >= deadline) return { busy: true };
            await new Promise(resolve => setTimeout(resolve, 25));
            session = await this.readSession(session.id);
        }
        return null;
    }

    async replace(expected, value)
    {
        const ttl = Math.ceil((Math.min(expected.idleExpiresAt, expected.expiresAt) - Date.now()) / 1000);
        return ttl > 0 && this.storage().compareAndSet('refresh-session:' + this.namespace,
            expected.id, expected, value, ttl);
    }

    async checkpoint(claimed, pending)
    {
        const saved = { ...claimed, upstreamRefresh: pending.updates.upstreamRefresh,
            pending: this.seal(JSON.stringify(pending), ':pending:' + claimed.id + ':' + claimed.tokenHash) };
        return await this.replace(claimed, saved) ? saved : null;
    }

    pendingResult(session)
    {
        return session.pending && JSON.parse(this.open(session.pending,
            ':pending:' + session.id + ':' + session.tokenHash));
    }

    async release(claimed, updates = {})
    {
        const active = { ...claimed, ...updates, state: 'active' };
        delete active.claimId;
        delete active.claimExpiresAt;
        return this.replace(claimed, active);
    }

    async rotate(claimed, updates, result)
    {
        const now = Date.now();
        const ttl = Math.floor((claimed.expiresAt - now) / 1000);
        if (ttl <= 0) return null;
        const token = result ? result.response.refresh_token : randomBytes(32).toString('base64url');
        const session = { ...claimed, ...updates, expiresAt: claimed.expiresAt, state: 'active', tokenHash: hashToken(token),
            idleExpiresAt: now + Math.min(this.idleTtl, ttl) * 1000 };
        delete session.pending;
        delete session.claimId;
        delete session.claimExpiresAt;
        await this.savePointer(token, session);
        if (result && this.grace)
        {
            const expiresAt = Math.min(now + this.grace * 1000, result.accessExpiresAt, session.expiresAt);
            if (expiresAt > now) await this.storage().set('refresh-reuse:' + this.namespace, claimed.tokenHash,
                { sessionId: session.id, expiresAt, accessExpiresAt: result.accessExpiresAt,
                    result: this.seal(JSON.stringify(result.response), ':reuse:' + session.id + ':' + claimed.tokenHash) },
                Math.ceil((expiresAt - now) / 1000));
        }
        const success = await this.storage().compareAndSet('refresh-session:' + this.namespace,
            session.id, claimed, session, Math.min(this.idleTtl, ttl));
        return success ? { token, session } : null;
    }
}

module.exports = { RefreshTokenStore, refreshEncryptionKey, boundedTtl, reuseGrace,
    ACCESS_TTL, REFRESH_IDLE_TTL, SESSION_TTL, REFRESH_REUSE_GRACE };
