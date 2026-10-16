'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const httpMock = require('./helpers/fetch-mock');
const { MemoryAuthStorage } = require('../lib/auth-storage');
const { isPrivateHost, clientMetadata, beginAuthorization, completeAuthorization, bindingCookieName,
    exchangeClientCode, hashToken } = require('../lib/mcp-auth');

const node = { publicBaseUrl: 'https://mcp.example.test', serverPath: '/mcp/test', serverName: 'test' };

describe('OAuth hardening', () => {
    it('treats bracketed, mapped, unspecified and shared addresses as private', () => {
        for (const host of ['[::1]', '[fd00::1]', '[::ffff:7f00:1]', '[::ffff:10.0.0.1]', '0.0.0.0', '100.64.0.1',
            'localhost.', '[fe80::1]'])
            assert.equal(isPrivateHost(host), true, host);
        for (const host of ['claude.ai', '8.8.8.8', '[2001:4860::8888]']) assert.equal(isPrivateHost(host), false, host);
    });

    // MCP-KEEP-2
    it('matches client hosts exactly and requires client_id to equal the metadata URL', async () => {
        const get = httpMock.get;
        try {
            httpMock.get = async url => ({ data: { client_id: url, redirect_uris: ['http://localhost/callback'] } });
            const auth = { allowedClientHosts: 'claude.ai, *.example.test' };
            await clientMetadata(auth, 'https://claude.ai/oauth/meta');
            await clientMetadata(auth, 'https://cdn.example.test/meta');
            await assert.rejects(clientMetadata(auth, 'https://evil.claude.ai/meta'), /host is not allowed/);
            httpMock.get = async () => ({ data: { client_id: 'https://claude.ai/other', redirect_uris: [] } });
            await assert.rejects(clientMetadata(auth, 'https://claude.ai/oauth/meta'), /does not match/);
        } finally { httpMock.get = get; }
    });

    // MCP-KEEP-2
    it('rejects malformed PKCE values', async () => {
        const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await beginAuthorization({ headers: {}, query: { response_type: 'code', code_challenge_method: 'S256',
            code_challenge: 'short', client_id: 'https://claude.ai/meta', redirect_uri: 'http://localhost/cb', state: 's' } },
            res, { ...node, authConfig: {} });
        assert.equal(res.statusCode, 400);
        const logs = [];
        const record = { client_id: 'c', redirect_uri: 'r', code_challenge: 'x'.repeat(43), scopes: [], subject: 'u' };
        const auth = { consumeCode: async () => record };
        const tokenRes = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await exchangeClientCode({ body: { grant_type: 'authorization_code', code: 'k', client_id: 'c', redirect_uri: 'r',
            code_verifier: 'too short' } }, tokenRes, { ...node, authConfig: auth, log: line => logs.push(line) });
        assert.equal(tokenRes.body.error, 'invalid_grant');
        assert.equal(JSON.parse(logs[0]).reason, 'pkce');
    });

    // MCP-KEEP-2
    it('rejects a callback that lacks the browser binding cookie and audits it', async () => {
        const logs = [];
        let state = { client_id: 'https://claude.ai/meta', redirect_uri: 'http://localhost/cb', client_state: 'c',
            browserBinding: hashToken('bound') };
        const auth = { readState: async () => state, deleteState: async () => {} };
        const target = { ...node, authConfig: auth, log: line => logs.push(line) };
        const res = () => ({ status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
        const missing = res();
        await completeAuthorization({ headers: {}, query: { code: 'x', state: 'server-state' } }, missing, target);
        assert.equal(missing.body.error, 'invalid_state');
        const wrong = res();
        await completeAuthorization({ headers: { cookie: bindingCookieName({ headers: {} }, target, 'server-state') + '=other' },
            query: { code: 'x', state: 'server-state' } }, wrong, target);
        assert.equal(wrong.body.error, 'invalid_state');
        assert.ok(logs.every(line => JSON.parse(line).reason === 'browser_binding'));
        assert.match(bindingCookieName({ headers: {} }, target, 'server-state'), /^__Host-mcp-oauth-[0-9a-f]{12}$/);
    });
});

describe('memory storage', () => {
    it('removes expired entries without reads', async () => {
        const storage = new MemoryAuthStorage();
        await storage.set('state', 'old', { v: 1 }, 1);
        storage.items.get(storage.key('state', 'old')).expiresAt = Date.now() - 1;
        for (let i = 0; i < 99; i++) await storage.set('state', 'n' + i, { v: i }, 300);
        assert.equal(storage.items.has(storage.key('state', 'old')), false);
        assert.equal(storage.items.size, 99);
    });
});
