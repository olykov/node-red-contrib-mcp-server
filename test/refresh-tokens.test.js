'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const axios = require('axios');
const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = require('jose');
const { RefreshTokenStore, boundedTtl, ACCESS_TTL, REFRESH_IDLE_TTL, SESSION_TTL } = require('../lib/refresh-tokens');
const { MemoryAuthStorage, RedisAuthStorage } = require('../lib/auth-storage');
const { exchangeClientCode, exchangeRefreshToken, completeAuthorization, beginAuthorization,
    authorizeMetadata, validateRequest, sha256Base64Url } = require('../lib/mcp-auth');

const key = '12'.repeat(32);
const tenant = '00000000-0000-0000-0000-000000000001';
const client = '00000000-0000-0000-0000-000000000002';
const keys = generateKeyPair('RS256');
const url = 'https://mcp.example.test';

function response() {
    return { statusCode: 200, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }, redirect(location) { this.location = location; return this; } };
}

function authNode(options = {}, withRefreshKey = true) {
    const types = {};
    const nodes = {};
    const RED = { nodes: {
        createNode(node, config) {
            Object.setPrototypeOf(node, EventEmitter.prototype);
            EventEmitter.call(node);
            node.id = config.id;
            node.credentials = config.credentials || {};
        }, registerType(name, ctor) { types[name] = ctor; }, getNode(id) { return nodes[id]; }
    } };
    require('../mcp-auth')(RED);
    nodes.storage = new types['mcp-redis']({ id: 'storage', mode: 'memory' });
    return new types['mcp-auth']({ id: 'auth-test', redis: 'storage', provider: 'microsoft',
        oauthSlug: 'test-login', microsoftTenantId: tenant, microsoftClientId: client,
        credentials: { microsoftClientSecret: 'provider-test-secret', clientSecret: 'provider-test-secret',
            ...(withRefreshKey ? { microsoftRefreshKey: key, oidcRefreshKey: key } : {}) },
        allowedClientHosts: 'client.example.test', ...options });
}

async function setup(t, options = {}) {
    const auth = authNode(options);
    const { publicKey, privateKey } = await keys;
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-key';
    jwk.alg = 'RS256';
    auth.jwks = createLocalJWKSet({ keys: [jwk] });
    const discovery = { issuer: auth.issuerUrl, token_endpoint: 'https://idp.example.test/token',
        authorization_endpoint: 'https://idp.example.test/authorize',
        userinfo_endpoint: 'https://idp.example.test/userinfo', jwks_uri: 'https://idp.example.test/jwks' };
    auth.discovery = { value: discovery, expiresAt: Date.now() + 86400000 };
    const node = { authConfig: auth, endpointId: 'endpoint-1',
        serverPath: '/mcp/test', publicBaseUrl: url, allowedGroups: 'operators' };
    const state = { roles: ['operators'], groups: ['operators'], subject: 'user-1', posts: [], fail: false };
    const sign = async (nonce, claims = {}) => new SignJWT({ sub: state.subject, roles: state.roles,
        tid: tenant, ...(nonce ? { nonce } : {}), ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(auth.issuerUrl).setAudience(auth.clientId).setIssuedAt().setExpirationTime('1h').sign(privateKey);
    t.mock.method(axios, 'post', async (_, body) => {
        const params = new URLSearchParams(body);
        state.posts.push(params);
        if (state.fail) throw new Error('provider-test-secret must never appear in the response');
        return { data: { access_token: 'upstream-access', refresh_token: 'upstream-refresh-' + state.posts.length,
            id_token: state.missingIdToken ? undefined : (state.idToken ||
                await sign(params.get('grant_type') === 'authorization_code' ? 'initial-nonce' : undefined)) } };
    });
    t.mock.method(axios, 'get', async path => {
        if (path === discovery.userinfo_endpoint) return { data: { sub: state.subject, groups: state.groups } };
        return { data: { redirect_uris: ['http://localhost/callback'] } };
    });
    const code = async (scopes = ['offline_access']) => {
        await auth.writeState('test-state', { client_id: 'https://client.example.test/metadata',
            redirect_uri: 'http://localhost/callback', code_challenge: sha256Base64Url('verifier'),
            scope: scopes.join(' '), resource: url + node.serverPath, endpointId: node.endpointId,
            nonce: 'initial-nonce', client_state: 'client-state' });
        const callback = response();
        await completeAuthorization({ query: { code: 'provider-code', state: 'test-state' } }, callback, node);
        assert.equal(callback.statusCode, 200);
        const token = response();
        await exchangeClientCode({ body: { grant_type: 'authorization_code',
            code: new URL(callback.location).searchParams.get('code'), client_id: 'https://client.example.test/metadata',
            redirect_uri: 'http://localhost/callback', code_verifier: 'verifier' } }, token, node);
        return token;
    };
    const refresh = async (token, extra = {}) => {
        const res = response();
        await exchangeRefreshToken({ body: { grant_type: 'refresh_token', refresh_token: token,
            client_id: 'https://client.example.test/metadata', ...extra } }, res, node);
        return res;
    };
    return { auth, node, state, code, refresh, sign };
}

describe('rotating refresh tokens', () => {
    it('uses the agreed bounded lifetimes and advertises refresh only with a valid encryption key', () => {
        const auth = authNode();
        assert.equal(auth.accessTokenTtl, 900);
        assert.equal(auth.refreshTokenTtl, 604800);
        assert.equal(auth.sessionTtl, 1814400);
        for (const maximum of [ACCESS_TTL, REFRESH_IDLE_TTL, SESSION_TTL]) {
            assert.equal(boundedTtl(maximum * 2, maximum), maximum);
            assert.equal(boundedTtl(1, maximum), 1);
            assert.throws(() => boundedTtl(-1, maximum));
        }
        assert.deepEqual(authorizeMetadata({}, { authConfig: auth }).grant_types_supported,
            ['authorization_code', 'refresh_token']);
        assert.ok(authorizeMetadata({}, { authConfig: auth }).scopes_supported.includes('offline_access'));
        const disabled = authNode({}, false);
        assert.deepEqual(authorizeMetadata({}, { authConfig: disabled }).grant_types_supported, ['authorization_code']);
        assert.equal(authorizeMetadata({}, { authConfig: disabled }).scopes_supported.includes('offline_access'), false);
    });

    it('uses only the selected provider credential and rejects malformed keys', () => {
        const credentials = { microsoftRefreshKey: 'ab'.repeat(32), oidcRefreshKey: 'cd'.repeat(32) };
        const microsoft = authNode({ credentials });
        const oidc = authNode({ credentials, provider: 'oidc',
            issuerUrl: 'https://idp.example.test', clientId: 'provider-client' });
        assert.deepEqual(microsoft.refreshStore.key, Buffer.from(credentials.microsoftRefreshKey, 'hex'));
        assert.deepEqual(oidc.refreshStore.key, Buffer.from(credentials.oidcRefreshKey, 'hex'));
        assert.equal(authNode({ credentials: { oidcRefreshKey: key } }).refreshStore, null);
        assert.throws(() => authNode({ credentials: { microsoftRefreshKey: 'invalid' } }), /64 hex/);
        assert.throws(() => oidc.refreshStore.open(microsoft.refreshStore.seal('provider-refresh')));
    });

    it('expires state and authorization codes after exactly 300 seconds', async t => {
        let now = Date.now();
        t.mock.method(Date, 'now', () => now);
        const auth = authNode();
        await auth.writeState('state', { marker: 'state' });
        await auth.writeCode('code', { marker: 'code' });
        now += 299999;
        assert.deepEqual(await auth.readState('state'), { marker: 'state' });
        assert.deepEqual(await auth.readCode('code'), { marker: 'code' });
        now++;
        assert.equal(await auth.readState('state'), null);
        assert.equal(await auth.readCode('code'), null);
    });

    it('requests offline_access upstream only for a client asking for refresh', async t => {
        const context = await setup(t);
        for (const scope of ['openid', 'openid offline_access']) {
            const res = response();
            await beginAuthorization({ query: { response_type: 'code', client_id: 'https://client.example.test/metadata',
                redirect_uri: 'http://localhost/callback', code_challenge_method: 'S256', code_challenge: 'challenge',
                state: 'state', scope } }, res, context.node);
            const actual = new URL(res.location).searchParams.get('scope').split(' ');
            assert.equal(actual.includes('offline_access'), scope.includes('offline_access'));
        }
    });

    it('rejects unsupported OAuth scopes before contacting the provider', async t => {
        const context = await setup(t);
        const res = response();
        await beginAuthorization({ query: { response_type: 'code', client_id: 'https://client.example.test/metadata',
            redirect_uri: 'http://localhost/callback', code_challenge_method: 'S256', code_challenge: 'challenge',
            state: 'state', scope: 'custom:write' } }, res, context.node);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.error, 'invalid_scope');
        assert.equal(res.location, undefined);
        assert.equal(context.state.posts.length, 0);
    });

    it('issues an independent refresh token and rotates it using fresh verified provider identity', async t => {
        const context = await setup(t);
        const initial = await context.code();
        assert.equal(initial.body.expires_in, 900);
        assert.notEqual(initial.body.refresh_token, 'upstream-refresh-1');
        const session = await context.auth.refreshStore.read(initial.body.refresh_token);
        assert.equal(context.auth.refreshStore.open(session.upstreamRefresh), 'upstream-refresh-1');
        const stored = JSON.stringify([...context.auth.getStorage().items]);
        assert.equal(stored.includes('upstream-refresh-1'), false);
        assert.equal(stored.includes(initial.body.refresh_token), false);
        const refreshed = await context.refresh(initial.body.refresh_token);
        assert.equal(refreshed.statusCode, 200);
        assert.notEqual(refreshed.body.refresh_token, initial.body.refresh_token);
        assert.notEqual(refreshed.body.access_token, initial.body.access_token);
        assert.equal(context.state.posts[1].get('refresh_token'), 'upstream-refresh-1');
        assert.equal(context.state.posts[1].get('client_id'), client);
        const rotated = await context.auth.refreshStore.read(refreshed.body.refresh_token);
        assert.equal(rotated.expiresAt, session.expiresAt);
        assert.equal(context.auth.refreshStore.open(rotated.upstreamRefresh), 'upstream-refresh-2');
        const claims = await context.auth.readAccessToken(refreshed.body.access_token);
        assert.deepEqual(claims.groups, ['operators']);
    });

    it('does not issue refresh when offline access was not requested', async t => {
        const context = await setup(t);
        const result = await context.code(['openid']);
        assert.equal(result.body.refresh_token, undefined);
        assert.equal((await context.auth.readAccessToken(result.body.access_token)).sessionId, undefined);
    });

    it('rejects client/resource changes and scope escalation without consuming a valid token', async t => {
        const context = await setup(t);
        const initial = await context.code(['openid', 'offline_access']);
        for (const extra of [{ client_id: 'other-client' }, { resource: url + '/other' }, { scope: 'tool:write' }]) {
            const res = await context.refresh(initial.body.refresh_token, extra);
            assert.equal(res.statusCode, 400);
        }
        assert.equal(context.state.posts.length, 1);
        const res = await context.refresh(initial.body.refresh_token, { scope: 'openid' });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.scope, 'openid');
        assert.equal((await context.refresh(res.body.refresh_token, { scope: 'offline_access' })).body.error, 'invalid_scope');
    });

    it('revokes the session on reuse, including its replacement refresh and access tokens', async t => {
        const context = await setup(t);
        const initial = await context.code();
        const next = await context.refresh(initial.body.refresh_token);
        assert.equal((await context.refresh(initial.body.refresh_token)).body.error, 'invalid_grant');
        assert.equal((await context.refresh(next.body.refresh_token)).body.error, 'invalid_grant');
        const result = await validateRequest(context.node, { headers: { authorization: 'Bearer ' + next.body.access_token } });
        assert.equal(result.ok, false);
        assert.equal(context.state.posts.length, 2);
    });

    it('does not redeem one refresh twice under concurrent calls', async t => {
        const context = await setup(t);
        const initial = await context.code();
        const results = await Promise.all([context.refresh(initial.body.refresh_token), context.refresh(initial.body.refresh_token)]);
        assert.ok(results.filter(res => res.statusCode === 200).length <= 1);
        assert.ok(context.state.posts.length <= 2);
        assert.equal(await context.auth.refreshStore.read(initial.body.refresh_token), null);
    });

    it('refuses provider denial, removed roles and changed subject without cached privileges or secret leakage', async t => {
        const context = await setup(t);
        for (const failure of ['denied', 'roles', 'subject']) {
            context.state.fail = false;
            context.state.roles = ['operators'];
            context.state.subject = 'user-1';
            const initial = await context.code();
            if (failure === 'denied') context.state.fail = true;
            if (failure === 'roles') context.state.roles = [];
            if (failure === 'subject') context.state.subject = 'other-user';
            const res = await context.refresh(initial.body.refresh_token);
            assert.equal(res.body.error, 'invalid_grant');
            assert.equal(JSON.stringify(res.body).includes('provider-test-secret'), false);
            assert.equal(await context.auth.refreshStore.read(initial.body.refresh_token), null);
        }
    });

    it('reevaluates OIDC groups on refresh', async t => {
        const context = await setup(t, { provider: 'oidc', issuerUrl: 'https://idp.example.test', clientId: 'provider-client' });
        const initial = await context.code();
        const next = await context.refresh(initial.body.refresh_token);
        assert.equal(next.statusCode, 200);
        context.state.groups = [];
        assert.equal((await context.refresh(next.body.refresh_token)).body.error, 'invalid_grant');
    });

    it('requires a valid Microsoft ID token and rejects changed nonce or tenant on refresh', async t => {
        const context = await setup(t);
        for (const failure of ['missing', 'invalid', 'nonce', 'tenant']) {
            context.state.idToken = undefined;
            context.state.missingIdToken = false;
            const initial = await context.code();
            if (failure === 'missing') context.state.missingIdToken = true;
            if (failure === 'invalid') context.state.idToken = 'invalid-jwt';
            if (failure === 'nonce') context.state.idToken = await context.sign('wrong-nonce');
            if (failure === 'tenant') context.state.idToken = await context.sign(undefined, { tid: client });
            assert.equal((await context.refresh(initial.body.refresh_token)).body.error, 'invalid_grant');
        }
    });

    it('uses current OIDC UserInfo if refresh omits an optional ID token', async t => {
        const context = await setup(t, { provider: 'oidc', issuerUrl: 'https://idp.example.test', clientId: 'provider-client' });
        const initial = await context.code();
        context.state.missingIdToken = true;
        assert.equal((await context.refresh(initial.body.refresh_token)).statusCode, 200);
    });

    it('routes a refresh grant through the same HTTP token endpoint with no-store responses', async t => {
        const context = await setup(t);
        const initial = await context.code();
        const types = {};
        const nodes = { [context.auth.id]: context.auth };
        const RED = { events: new EventEmitter(), log: { debug() {} }, httpAdmin: { get() {} }, nodes: {
            createNode(node, config) {
                Object.setPrototypeOf(node, EventEmitter.prototype);
                EventEmitter.call(node);
                node.id = config.id;
                node.credentials = {};
                node.send = node.status = node.log = node.error = node.warn = () => {};
            }, registerType(name, ctor) { types[name] = ctor; }, getNode(id) { return nodes[id]; }
        } };
        require('../mcp-flow-server')(RED);
        nodes.runtime = new types['mcp-runtime']({ id: 'runtime', serverPort: 18115, publicBaseUrl: url });
        const server = new types['mcp-flow-server']({ id: 'endpoint-1', runtime: 'runtime',
            serverPath: '/mcp/test', auth: context.auth.id, allowedGroups: 'operators' });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try {
            const res = await fetch('http://127.0.0.1:18115/oauth/test-login/token', {
                method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', connection: 'close' },
                body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: initial.body.refresh_token,
                    client_id: 'https://client.example.test/metadata' }).toString()
            });
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('cache-control'), 'no-store');
            assert.equal((await res.json()).expires_in, 900);
        } finally { await new Promise(resolve => server.stopServer(() => resolve())); }
    });

    it('enforces seven-day idle and twenty-one-day absolute expiry without extending the session', async t => {
        const context = await setup(t);
        let now = Date.now();
        t.mock.method(Date, 'now', () => now);
        const storage = new MemoryAuthStorage();
        const store = new RefreshTokenStore(() => storage, 'time-test', Buffer.from(key, 'hex'), REFRESH_IDLE_TTL, SESSION_TTL);
        let current = await store.create({ client_id: 'client', upstreamRefresh: store.seal('provider-token') });
        const absolute = current.session.expiresAt;
        for (let day = 6; day <= 18; day += 6) {
            now += 6 * 86400000;
            const session = await store.read(current.token);
            current = await store.rotate(await store.claim(session, current.token), {});
            assert.equal(current.session.expiresAt, absolute);
        }
        now = absolute;
        assert.equal(await store.read(current.token), null);
        const idle = await store.create({ client_id: 'client', upstreamRefresh: store.seal('provider-token') });
        now += 7 * 86400000;
        assert.equal(await store.read(idle.token), null);
        assert.equal(context.state.posts.length, 0);
    });

    it('refreshes after access expiry but refuses refresh after seven idle days', async t => {
        const context = await setup(t);
        let now = Date.now();
        t.mock.method(Date, 'now', () => now);
        const initial = await context.code();
        now += ACCESS_TTL * 1000;
        assert.equal((await validateRequest(context.node, {
            headers: { authorization: 'Bearer ' + initial.body.access_token }
        })).ok, false);
        const next = await context.refresh(initial.body.refresh_token);
        assert.equal(next.statusCode, 200);
        const requests = context.state.posts.length;
        now += REFRESH_IDLE_TTL * 1000;
        assert.equal((await context.refresh(next.body.refresh_token)).body.error, 'invalid_grant');
        assert.equal(context.state.posts.length, requests);
    });

    it('preserves a provider refresh credential when a successful response omits its replacement', async t => {
        const context = await setup(t);
        const initial = await context.code();
        const previous = (await context.auth.refreshStore.read(initial.body.refresh_token)).upstreamRefresh;
        t.mock.method(axios, 'post', async () => ({ data: {
            access_token: 'upstream-access', id_token: await context.sign()
        } }));
        const next = await context.refresh(initial.body.refresh_token);
        assert.equal(next.statusCode, 200);
        assert.equal((await context.auth.refreshStore.read(next.body.refresh_token)).upstreamRefresh, previous);
    });

    it('rejects forged ciphertext and enforces provider namespace isolation', () => {
        const storage = new MemoryAuthStorage();
        const one = new RefreshTokenStore(() => storage, 'one', Buffer.from(key, 'hex'), 100, 200);
        const two = new RefreshTokenStore(() => storage, 'two', Buffer.from(key, 'hex'), 100, 200);
        const sealed = one.seal('provider-refresh');
        assert.equal(one.open(sealed), 'provider-refresh');
        assert.throws(() => two.open(sealed));
        const bytes = Buffer.from(sealed, 'base64');
        bytes[28] ^= 1;
        assert.throws(() => one.open(bytes.toString('base64')));
    });

    it('stores Redis sessions with an atomic CAS and can reload them through another store instance', async () => {
        const entries = new Map();
        const fake = { status: 'ready', async set(k, v) { entries.set(k, v); },
            async get(k) { return entries.get(k) || null; }, async del(k) { entries.delete(k); },
            async eval(script, count, k, expected, value) {
                assert.match(script, /redis.call\("GET"/);
                assert.equal(count, 1);
                if (entries.get(k) !== expected) return 0;
                entries.set(k, value);
                return 1;
            } };
        const build = () => {
            const storage = new RedisAuthStorage({ lazyConnect: true });
            storage.client = fake;
            return new RefreshTokenStore(() => storage, 'persist-test', Buffer.from(key, 'hex'), 100, 200);
        };
        const original = build();
        const issued = await original.create({ upstreamRefresh: original.seal('provider-refresh') });
        const restarted = build();
        const session = await restarted.read(issued.token);
        assert.equal(restarted.open(session.upstreamRefresh), 'provider-refresh');
        const claimed = await restarted.claim(session, issued.token);
        assert.equal(claimed.state, 'refreshing');
        assert.ok(await restarted.rotate(claimed, {}));
        assert.equal([...entries.values()].some(v => v.includes('provider-refresh')), false);
    });

    it('consumes an authorization code only once', async () => {
        const auth = authNode();
        await auth.writeCode('code', { marker: true });
        const consumed = await Promise.all([auth.consumeCode('code'), auth.consumeCode('code')]);
        assert.equal(consumed.filter(Boolean).length, 1);
    });
});
