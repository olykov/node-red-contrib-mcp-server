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
        this.writes = 0;
    }

    // Expired entries are otherwise removed only when read; unread OAuth states would accumulate.
    sweep()
    {
        const current = now();
        for (const [key, entry] of this.items) if (entry.expiresAt <= current) this.items.delete(key);
    }

    key(type, id)
    {
        return this.prefix + type + ':' + id;
    }

    async set(type, id, value, ttlSeconds)
    {
        if (++this.writes % 100 === 0) this.sweep();
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

    async compareAndSet(type, id, expected, value, ttlSeconds)
    {
        const key = this.key(type, id);
        const entry = this.items.get(key);
        if (!entry || entry.expiresAt <= now() || JSON.stringify(entry.value) !== JSON.stringify(expected)) return false;
        this.items.set(key, { value, expiresAt: now() + normalizeTtl(ttlSeconds) * 1000 });
        return true;
    }

    async close() {}
}

class RedisAuthStorage
{
    constructor(options = {})
    {
        const Redis = require('ioredis');
        this.prefix = options.prefix || 'mcp_auth:';
        this.onError = typeof options.onError === 'function' ? options.onError : () => {};
        this.client = options.url ? new Redis(options.url) : new Redis({
            host: options.host || '127.0.0.1',
            port: Number(options.port || 6379),
            db: Number(options.db || 0),
            username: options.username || undefined,
            password: options.password || undefined,
            tls: options.tls ? {} : undefined,
            lazyConnect: true
        });
        // Without a listener ioredis prints every reconnect failure as an unhandled error event.
        this.client.on('error', error => this.onError(error));
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
        } catch
        {
            return null;
        }
    }

    async delete(type, id)
    {
        await this.ensureConnected();
        await this.client.del(this.key(type, id));
    }

    async compareAndSet(type, id, expected, value, ttlSeconds)
    {
        await this.ensureConnected();
        // One-key CAS prevents two clients from redeeming the same rotating token.
        const script = 'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end ' +
            'redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3]); return 1';
        return (await this.client.eval(script, 1, this.key(type, id),
            JSON.stringify(expected), JSON.stringify(value), normalizeTtl(ttlSeconds))) === 1;
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
    const onError = config && config.onError;
    if (mode === 'memory') return new MemoryAuthStorage({ prefix });
    if (mode === 'env')
    {
        const envName = config.redisUrlEnv || 'MCP_REDIS_URL';
        const url = process.env[envName];
        if (!url) throw new Error('Redis URL environment variable is not set: ' + envName);
        return new RedisAuthStorage({ prefix, url, onError });
    }
    if (mode === 'manual')
    {
        return new RedisAuthStorage({
            prefix,
            onError,
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
