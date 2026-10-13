"use strict";

const { createHash } = require('crypto');

function now()
{
    return Date.now();
}

function normalizeTtl(seconds)
{
    const value = Number(seconds);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 300;
}

function hashToken(token)
{
    return createHash('sha256').update(String(token)).digest('hex');
}

class MemoryAuthStorage
{
    constructor(options = {})
    {
        this.prefix = options.prefix || 'mcp_auth:';
        this.items = new Map();
    }

    key(type, id)
    {
        return this.prefix + type + ':' + id;
    }

    async set(type, id, value, ttlSeconds)
    {
        this.items.set(this.key(type, id), {
            value,
            expiresAt: now() + normalizeTtl(ttlSeconds) * 1000
        });
    }

    async get(type, id)
    {
        const key = this.key(type, id);
        const entry = this.items.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= now())
        {
            this.items.delete(key);
            return null;
        }
        return entry.value;
    }

    async delete(type, id)
    {
        this.items.delete(this.key(type, id));
    }

    async close() {}
}

class RedisAuthStorage
{
    constructor(options = {})
    {
        const Redis = require('ioredis');
        this.prefix = options.prefix || 'mcp_auth:';
        this.client = options.url ? new Redis(options.url) : new Redis({
            host: options.host || '127.0.0.1',
            port: Number(options.port || 6379),
            db: Number(options.db || 0),
            username: options.username || undefined,
            password: options.password || undefined,
            tls: options.tls ? {} : undefined,
            lazyConnect: true
        });
    }

    key(type, id)
    {
        return this.prefix + type + ':' + id;
    }

    async ensureConnected()
    {
        if (this.client.status === 'wait') await this.client.connect();
    }

    async set(type, id, value, ttlSeconds)
    {
        await this.ensureConnected();
        await this.client.set(this.key(type, id), JSON.stringify(value), 'EX', normalizeTtl(ttlSeconds));
    }

    async get(type, id)
    {
        await this.ensureConnected();
        const raw = await this.client.get(this.key(type, id));
        if (!raw) return null;
        try
        {
            return JSON.parse(raw);
        } catch (error)
        {
            return null;
        }
    }

    async delete(type, id)
    {
        await this.ensureConnected();
        await this.client.del(this.key(type, id));
    }

    async close()
    {
        if (this.client && this.client.status !== 'end') this.client.disconnect();
    }
}

function createStorage(config)
{
    const mode = config && config.mode ? String(config.mode) : 'memory';
    const prefix = config && config.keyPrefix ? String(config.keyPrefix) : 'mcp_auth:';
    if (mode === 'memory') return new MemoryAuthStorage({ prefix });
    if (mode === 'env')
    {
        const envName = config.redisUrlEnv || 'REDIS_URL';
        const url = process.env[envName];
        if (!url) throw new Error('Redis URL environment variable is not set: ' + envName);
        return new RedisAuthStorage({ prefix, url });
    }
    if (mode === 'manual')
    {
        return new RedisAuthStorage({
            prefix,
            host: config.host,
            port: config.port,
            db: config.db,
            tls: config.tls,
            username: config.username,
            password: config.password
        });
    }
    throw new Error('Unsupported auth storage mode: ' + mode);
}

module.exports = {
    MemoryAuthStorage,
    RedisAuthStorage,
    createStorage,
    hashToken,
    normalizeTtl
};
