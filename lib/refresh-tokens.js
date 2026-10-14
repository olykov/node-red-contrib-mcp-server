"use strict";

const { randomBytes, createCipheriv, createDecipheriv } = require('crypto');
const { hashToken } = require('./auth-storage');

const ACCESS_TTL = 900;
const REFRESH_IDLE_TTL = 604800;
const SESSION_TTL = 1814400;

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
    constructor(storage, namespace, key, idleTtl, sessionTtl)
    {
        this.storage = storage;
        this.namespace = namespace;
        this.key = key;
        this.idleTtl = idleTtl;
        this.sessionTtl = sessionTtl;
    }

    seal(token)
    {
        if (typeof token !== 'string' || !token) throw new Error('Provider refresh token is missing');
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(this.namespace));
        const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    }

    open(value)
    {
        const bytes = Buffer.from(value, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(this.namespace));
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
        if (session.state !== 'active' || session.tokenHash !== hashToken(token))
        {
            await this.revoke(session.id);
            return null;
        }
        const claimed = { ...session, state: 'refreshing' };
        const ttl = Math.ceil((Math.min(session.idleExpiresAt, session.expiresAt) - Date.now()) / 1000);
        if (ttl <= 0) return null;
        const success = await this.storage().compareAndSet('refresh-session:' + this.namespace,
            session.id, session, claimed, ttl);
        if (!success) { await this.revoke(session.id); return null; }
        return claimed;
    }

    async rotate(claimed, updates)
    {
        const now = Date.now();
        const ttl = Math.floor((claimed.expiresAt - now) / 1000);
        if (ttl <= 0) return null;
        const token = randomBytes(32).toString('base64url');
        const session = { ...claimed, ...updates, expiresAt: claimed.expiresAt, state: 'active', tokenHash: hashToken(token),
            idleExpiresAt: now + Math.min(this.idleTtl, ttl) * 1000 };
        await this.savePointer(token, session);
        const success = await this.storage().compareAndSet('refresh-session:' + this.namespace,
            session.id, claimed, session, Math.min(this.idleTtl, ttl));
        return success ? { token, session } : null;
    }
}

module.exports = { RefreshTokenStore, refreshEncryptionKey, boundedTtl, ACCESS_TTL, REFRESH_IDLE_TTL, SESSION_TTL };
