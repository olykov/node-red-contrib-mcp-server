'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

// MCP-STO-1
describe('redis auth storage connection options', () => {
    it('configures ioredis with bounded timeouts, a single retry, and no offline queue', () => {
        const ioredisPath = require.resolve('ioredis');
        const original = require.cache[ioredisPath];
        const calls = [];

        class FakeRedis extends EventEmitter
        {
            constructor(...args) { super(); calls.push(args); this.status = 'wait'; }
            async connect() { this.status = 'ready'; }
        }

        require.cache[ioredisPath] = { id: ioredisPath, filename: ioredisPath, loaded: true, exports: FakeRedis };
        delete require.cache[require.resolve('../lib/auth-storage')];

        try {
            const { RedisAuthStorage } = require('../lib/auth-storage');
            new RedisAuthStorage({ url: 'redis://redis.example.test:6379/0' });
            new RedisAuthStorage({ host: 'redis.example.test', port: 6380 });

            assert.strictEqual(calls.length, 2);
            assert.strictEqual(calls[0][0], 'redis://redis.example.test:6379/0');
            const expectedOptions = {
                connectTimeout: 5000,
                commandTimeout: 2000,
                maxRetriesPerRequest: 1,
                enableOfflineQueue: false,
                lazyConnect: true
            };
            for (const key of Object.keys(expectedOptions)) {
                assert.strictEqual(calls[0][1][key], expectedOptions[key], 'url form option ' + key);
                assert.strictEqual(calls[1][0][key], expectedOptions[key], 'host/port form option ' + key);
            }
        } finally {
            if (original) require.cache[ioredisPath] = original;
            else delete require.cache[ioredisPath];
            delete require.cache[require.resolve('../lib/auth-storage')];
        }
    });
});
