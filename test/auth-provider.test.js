'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const axios = require('axios');
const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = require('jose');
const { providerSettings, authRouteSlug } = require('../lib/auth-provider');
const { beginAuthorization, completeAuthorization, exchangeClientCode, validateRequest, oidcDiscovery, sha256Base64Url, authorizeMetadata } = require('../lib/mcp-auth');

const tenant = '00000000-0000-0000-0000-000000000001';
const client = '00000000-0000-0000-0000-000000000002';
const microsoft = { provider: 'microsoft', oauthSlug: 'test-login', microsoftTenantId: tenant, microsoftClientId: client };
const oidc = { provider: 'oidc', oauthSlug: 'test-login', issuerUrl: 'https://idp.example.test/oidc', clientId: 'test-client' };

function runtime() {
    const types = {};
    const nodes = {};
    const RED = { nodes: {
        createNode(node, config) {
            Object.setPrototypeOf(node, EventEmitter.prototype);
            EventEmitter.call(node);
            node.id = config.id;
            node.credentials = config.credentials || {};
            node.error = message => (node.errorLog = node.errorLog || []).push(message);
        },
        registerType(name, ctor) { types[name] = ctor; },
        getNode(id) { return nodes[id]; }
    } };
    require('../mcp-auth')(RED);
    nodes.storage = new types['mcp-redis']({ id: 'storage', mode: 'memory' });
    return config => new types['mcp-auth']({ id: 'auth-test', redis: 'storage', ...config });
}

function response() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        redirect(url) { this.location = url; return this; }
    };
}

describe('provider configuration', () => {
    it('requires an explicit safe slug without node ID fallback', () => {
        for (const oauthSlug of [undefined, '', 'Uppercase', '../login', 'login/path', 'a%2fb', ' login', 'a'.repeat(64), '1login']) {
            assert.throws(() => authRouteSlug({ id: 'auth-test', oauthSlug }), /OAuth slug/);
            assert.match(runtime()({ ...oidc, oauthSlug }).configError, /OAuth slug/);
        }
        assert.equal(authRouteSlug({ oauthSlug: 'mcp-login-2' }), 'mcp-login-2');
    });
    it('selects only Microsoft settings and derives the single-tenant issuer', () => {
        const node = runtime()({ ...microsoft, issuerUrl: 'invalid', clientId: 'ignored',
            credentials: { clientSecret: 'unused-test-value', microsoftClientSecret: 'active-test-value' } });
        assert.equal(node.issuerUrl, 'https://login.microsoftonline.com/' + tenant + '/v2.0');
        assert.equal(node.clientId, client);
        assert.equal(node.baseScopes, 'openid profile email');
        assert.equal(node.groupClaim, 'roles');
        assert.equal(node.clientSecret(), 'active-test-value');
    });

    it('selects only OIDC settings and secret', () => {
        const node = runtime()({ ...oidc, microsoftTenantId: 'invalid', microsoftClientId: 'invalid',
            credentials: { clientSecret: 'active-test-value', microsoftClientSecret: 'unused-test-value' } });
        assert.equal(node.issuerUrl, oidc.issuerUrl);
        assert.equal(node.clientSecret(), 'active-test-value');
        assert.equal(node.groupClaim, 'groups');
        assert.equal(node.baseScopes, 'openid profile email groups');
    });

    it('reads the selected environment variable without falling back to another provider secret', () => {
        const env = 'MCP_TEST_SELECTED_SECRET';
        const previous = process.env[env];
        process.env[env] = 'environment-test-value';
        try {
            const node = runtime()({ ...microsoft, microsoftClientSecretEnv: env,
                credentials: { microsoftClientSecret: 'credential-test-value' } });
            assert.equal(node.clientSecret(), 'environment-test-value');
            assert.throws(() => runtime()({ ...microsoft, credentials: { clientSecret: 'unused-test-value' } }).clientSecret(), /not configured/);
        } finally {
            if (previous === undefined) delete process.env[env]; else process.env[env] = previous;
        }
    });

    it('rejects missing/unknown provider, non-GUID tenant/client and unsafe issuer', () => {
        for (const config of [{}, { provider: 'unknown' }, { ...microsoft, microsoftTenantId: 'common' },
            { ...microsoft, microsoftClientId: 'invalid' }, { ...oidc, issuerUrl: 'http://idp.example.test' },
            { ...oidc, issuerUrl: 'https://user:pass@idp.example.test' }, { ...oidc, clientId: '' }]) {
            assert.throws(() => providerSettings(config));
        }
    });

    it('isolates state, codes and tokens by provider, auth node, tenant and client', async () => {
        const build = runtime();
        const original = build(oidc);
        await original.writeState('state', { marker: true });
        await original.writeCode('code', { marker: true });
        await original.writeAccessToken('token', { marker: true });
        assert.deepEqual(await build(oidc).readAccessToken('token'), { marker: true });
        for (const config of [microsoft, { ...oidc, id: 'other-auth' }, { ...oidc, oauthSlug: 'other-login' },
            { ...oidc, clientId: 'other-client' }, { ...oidc, issuerUrl: 'https://other.example.test/oidc' }]) {
            const other = build(config);
            assert.equal(await other.readAccessToken('token'), null);
            assert.equal(await other.readState('state'), null);
            assert.equal(await other.readCode('code'), null);
            await other.deleteState('state');
            await other.deleteCode('code');
        }
        assert.deepEqual(await original.readState('state'), { marker: true });
        assert.deepEqual(await original.readCode('code'), { marker: true });
        const ms = build(microsoft);
        await ms.writeAccessToken('ms-token', { marker: true });
        assert.equal(await build({ ...microsoft, microsoftTenantId: client }).readAccessToken('ms-token'), null);
        assert.equal(await build({ ...microsoft, microsoftClientId: tenant }).readAccessToken('ms-token'), null);
    });

    it('keeps public URLs stable after node replacement without sharing old credentials', async () => {
        const build = runtime();
        for (const settings of [oidc, microsoft]) {
            const old = build({ ...settings, id: 'old-node' });
            const replacement = build({ ...settings, id: 'replacement-node' });
            const node = authConfig => ({ authConfig, publicBaseUrl: 'https://mcp.example.test' });
            assert.deepEqual(authorizeMetadata({}, node(old)), authorizeMetadata({}, node(replacement)));
            assert.equal(authorizeMetadata({}, node(replacement)).authorization_endpoint, 'https://mcp.example.test/oauth/test-login/authorize');
            await old.writeAccessToken('old-token', { marker: true });
            await old.writeState('old-state', { marker: true });
            await old.writeCode('old-code', { marker: true });
            assert.equal(await replacement.readAccessToken('old-token'), null);
            assert.equal(await replacement.readState('old-state'), null);
            assert.equal(await replacement.readCode('old-code'), null);
        }
    });
});

describe('Microsoft signed-token authorization', () => {
    const keys = generateKeyPair('RS256');

    async function callback(claims, options = {}) {
        const { publicKey, privateKey } = await keys;
        const jwk = await exportJWK(publicKey);
        jwk.kid = 'test-key';
        jwk.alg = 'RS256';
        const auth = runtime()({ ...microsoft, credentials: { microsoftClientSecret: 'test-secret' },
            allowedClientHosts: 'client.example.test' });
        auth.jwks = createLocalJWKSet({ keys: [jwk] });
        const node = { endpointId: 'endpoint-test', authConfig: auth,
            publicBaseUrl: 'https://mcp.example.test', serverPath: '/mcp/test', allowedGroups: options.allowedGroups || 'MCP.Reader' };
        const state = { client_id: 'https://client.example.test/metadata.json', redirect_uri: 'https://client.example.test/callback',
            client_state: 'client-state', code_challenge: sha256Base64Url('test-verifier'),
            resource: 'https://mcp.example.test/mcp/test', nonce: 'test-nonce' };
        await auth.writeState('state', state);
        const token = await new SignJWT({ sub: 'test-subject', tid: tenant, nonce: 'test-nonce', ...claims })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setIssuer(options.issuer || auth.issuerUrl).setAudience(options.audience || client)
            .setIssuedAt().setExpirationTime(options.expired ? -1 : '5m').sign(options.signingKey || privateKey);
        const get = axios.get;
        const post = axios.post;
        const calls = [];
        axios.get = async url => {
            calls.push(url);
            if (url.endsWith('/.well-known/openid-configuration')) return { data: {
                issuer: auth.issuerUrl, authorization_endpoint: auth.issuerUrl + '/authorize',
                token_endpoint: auth.issuerUrl + '/token', userinfo_endpoint: 'https://graph.microsoft.com/oidc/userinfo',
                jwks_uri: 'https://keys.example.test/jwks'
            } };
            throw new Error('Unexpected UserInfo request');
        };
        axios.post = async (url, body) => {
            assert.equal(url, auth.issuerUrl + '/token');
            const form = new URLSearchParams(body);
            assert.equal(form.get('client_id'), client);
            assert.equal(form.get('client_secret'), 'test-secret');
            assert.equal(form.get('redirect_uri'), 'https://mcp.example.test/oauth/test-login/callback');
            return { data: { access_token: 'unused-upstream-token', id_token: token } };
        };
        const res = response();
        try {
            await completeAuthorization({ headers: {}, query: { code: 'upstream-code', state: 'state' } }, res, node);
            assert.equal(await auth.readState('state'), null);
            return { res, auth, node, state, calls };
        } finally { axios.get = get; axios.post = post; }
    }

    it('round-trips verified roles through code/PKCE/token and enforces endpoint/resource policies', async () => {
        const { res, auth, node, state, calls } = await callback({ roles: ['MCP.Reader', 'MCP.Reader'] });
        assert.equal(calls.length, 1);
        const code = new URL(res.location).searchParams.get('code');
        const record = await auth.readCode(code);
        assert.deepEqual(record.groups, ['MCP.Reader']);
        assert.equal(record.subject, 'test-subject');
        assert.equal(record.email, '');
        const tokenRes = response();
        await exchangeClientCode({ body: { grant_type: 'authorization_code', code, client_id: state.client_id,
            redirect_uri: state.redirect_uri, code_verifier: 'test-verifier' } }, tokenRes, node);
        assert.equal(tokenRes.statusCode, 200);
        assert.equal(await auth.readCode(code), null);
        const req = { headers: { authorization: 'Bearer ' + tokenRes.body.access_token } };
        assert.equal((await validateRequest(node, req)).ok, true);
        assert.equal((await validateRequest({ ...node, allowedGroups: 'MCP.Other' }, req)).status, 403);
        assert.equal((await validateRequest({ ...node, serverPath: '/mcp/other' }, req)).error, 'wrong_resource');
    });

    it('denies missing/empty/wrong roles without treating email or groups as permissions', async () => {
        for (const claims of [{ email: 'admin@example.test', groups: ['MCP.Reader'] }, { roles: [] }, { roles: ['MCP.Other'] }]) {
            const { res, auth } = await callback(claims);
            assert.equal(res.statusCode, 403);
            assert.equal(res.body.error, 'insufficient_access');
            assert.equal(res.location, undefined);
            assert.equal(await auth.readCode('code'), null);
        }
    });

    it('rejects malformed role arrays', async () => {
        for (const roles of ['MCP.Reader', null, [17], [''], ['  ']]) {
            await assert.rejects(() => callback({ roles }), /roles claim/);
        }
    });

    it('rejects wrong tenant, nonce, issuer, audience, expired token and signature', async () => {
        await assert.rejects(() => callback({ roles: ['MCP.Reader'], tid: client }), /tenant claim mismatch/);
        await assert.rejects(() => callback({ roles: ['MCP.Reader'], nonce: 'wrong' }), /nonce mismatch/);
        await assert.rejects(() => callback({ roles: ['MCP.Reader'], sub: '' }), /identity claims/);
        await assert.rejects(() => callback({ roles: ['MCP.Reader'] }, { issuer: 'https://other.example.test' }));
        await assert.rejects(() => callback({ roles: ['MCP.Reader'] }, { audience: tenant }));
        await assert.rejects(() => callback({ roles: ['MCP.Reader'] }, { expired: true }));
        const other = await generateKeyPair('RS256');
        await assert.rejects(() => callback({ roles: ['MCP.Reader'] }, { signingKey: other.privateKey }));
    });

    it('rejects discovery for a different issuer', async () => {
        const get = axios.get;
        axios.get = async () => ({ data: { issuer: 'https://other.example.test', authorization_endpoint: 'https://other.example.test/authorize',
            token_endpoint: 'https://other.example.test/token', userinfo_endpoint: 'https://other.example.test/userinfo', jwks_uri: 'https://other.example.test/jwks' } });
        try { await assert.rejects(() => oidcDiscovery(providerSettings(microsoft)), /discovery issuer mismatch/); }
        finally { axios.get = get; }
    });

    it('uses Microsoft scopes and callback in the authorize request', async () => {
        const get = axios.get;
        const auth = runtime()({ ...microsoft, allowedClientHosts: 'client.example.test' });
        auth.discovery = { expiresAt: Date.now() + 10000, value: { authorization_endpoint: auth.issuerUrl + '/authorize' } };
        axios.get = async () => ({ data: { redirect_uris: ['https://client.example.test/callback'] } });
        const res = response();
        try {
            await beginAuthorization({ headers: {}, query: { response_type: 'code', code_challenge_method: 'S256',
                code_challenge: 'challenge', client_id: 'https://client.example.test/metadata.json',
                redirect_uri: 'https://client.example.test/callback', state: 'client-state', scope: 'openid profile email' }
            }, res, { endpointId: 'test', authConfig: auth, publicBaseUrl: 'https://mcp.example.test', serverPath: '/mcp/test' });
            const url = new URL(res.location);
            assert.equal(url.searchParams.get('scope'), 'openid profile email');
            assert.equal(url.searchParams.get('client_id'), client);
            assert.equal(url.searchParams.get('redirect_uri'), 'https://mcp.example.test/oauth/test-login/callback');
        } finally { axios.get = get; }
    });
});

describe('native loopback redirects', () => {
    async function authorize(metadata, redirectUri, overrides = {}) {
        const get = axios.get;
        const auth = runtime()({ ...microsoft, allowedClientHosts: 'client.example.test' });
        auth.discovery = { expiresAt: Date.now() + 10000, value: { authorization_endpoint: auth.issuerUrl + '/authorize' } };
        axios.get = async () => ({ data: metadata });
        const res = response();
        try {
            await beginAuthorization({ headers: {}, query: {
                response_type: 'code', code_challenge_method: 'S256', code_challenge: 'challenge',
                client_id: 'https://client.example.test/metadata.json', redirect_uri: redirectUri,
                state: 'client-state', ...overrides
            } }, res, { authConfig: auth, endpointId: 'test-endpoint', serverPath: '/mcp/test', publicBaseUrl: 'https://mcp.example.test' });
            return { res, auth };
        } finally { axios.get = get; }
    }

    it('allows only port changes for registered native loopback hosts and preserves the actual redirect', async () => {
        for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
            const base = 'http://' + host + '/callback/client';
            const requested = 'http://' + host + ':56429/callback/client';
            for (const registered of [base, 'http://' + host + ':12345/callback/client']) {
                const { res, auth } = await authorize({ application_type: 'native', redirect_uris: [registered] }, requested);
                assert.equal(res.statusCode, 200);
                const state = new URL(res.location).searchParams.get('state');
                assert.equal((await auth.readState(state)).redirect_uri, requested);
            }
        }
    });

    it('does not relax host, scheme, path, query, fragment, credentials or client type', async () => {
        const metadata = { application_type: 'native', redirect_uris: ['http://127.0.0.1/callback/client'] };
        for (const uri of ['http://localhost:56429/callback/client', 'http://[::1]:56429/callback/client',
            'http://127.0.0.2:56429/callback/client', 'http://127.0.0.1.example.test:56429/callback/client',
            'http://2130706433:56429/callback/client', 'http://127.1:56429/callback/client',
            'https://127.0.0.1:56429/callback/client', 'http://127.0.0.1:56429/callback/other',
            'http://127.0.0.1:56429/callback/client?extra=1', 'http://127.0.0.1:56429/callback/client#fragment',
            'http://user@127.0.0.1:56429/callback/client', 'http://127.0.0.1:56429/callback/../callback/client',
            'http://127.0.0.1:0/callback/client', 'http://127.0.0.1:65536/callback/client']) {
            const { res } = await authorize(metadata, uri);
            assert.equal(res.statusCode, 400, uri);
            assert.equal(res.body.error_description, 'redirect_uri is not registered for this client');
            assert.equal(res.location, undefined);
        }
        for (const application_type of ['web', null, 'other']) {
            const { res } = await authorize({ ...metadata, application_type }, 'http://127.0.0.1:56429/callback/client');
            assert.equal(res.statusCode, 400);
        }
        assert.equal((await authorize({ application_type: 'native', redirect_uris: ['https://client.example.test/callback'] },
            'https://client.example.test:12345/callback')).res.statusCode, 400);
        assert.equal((await authorize({ application_type: 'web', redirect_uris: ['https://client.example.test/callback'] },
            'https://client.example.test/callback')).res.statusCode, 200);
        assert.equal((await authorize(metadata, 'http://127.0.0.1:56429/callback/client',
            { code_challenge_method: 'plain' })).res.statusCode, 400);
    });

    it('accepts registered loopback ports when CIMD omits application_type', async () => {
        const metadata = {
            client_id: 'https://client.example.test/metadata.json', client_name: 'CLI client',
            redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
            grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
            token_endpoint_auth_method: 'none'
        };
        for (const host of ['localhost', '127.0.0.1']) {
            const uri = 'http://' + host + ':53682/callback';
            const { res, auth } = await authorize(metadata, uri);
            assert.equal(res.statusCode, 200);
            const state = new URL(res.location).searchParams.get('state');
            assert.equal((await auth.readState(state)).redirect_uri, uri);
        }
        for (const uri of ['http://localhost:53682/other', 'https://localhost:53682/callback',
            'http://localhost:53682/callback?extra=1', 'http://localhost:53682/callback#fragment',
            'http://user@localhost:53682/callback', 'http://localhost:0/callback', 'http://localhost:65536/callback']) {
            assert.equal((await authorize(metadata, uri)).res.statusCode, 400);
        }
        assert.equal((await authorize({ ...metadata, redirect_uris: ['http://localhost/callback'] },
            'http://127.0.0.1:53682/callback')).res.statusCode, 400);
    });

    it('does not relax the actual port at authorization-code exchange', async () => {
        const { res, auth } = await authorize({ application_type: 'native', redirect_uris: ['http://127.0.0.1/callback/client'] },
            'http://127.0.0.1:56429/callback/client');
        const state = await auth.readState(new URL(res.location).searchParams.get('state'));
        await auth.writeCode('test-code', state);
        const result = response();
        await exchangeClientCode({ body: { grant_type: 'authorization_code', code: 'test-code',
            client_id: state.client_id, redirect_uri: 'http://127.0.0.1:56430/callback/client', code_verifier: 'verifier' } },
        result, { authConfig: auth });
        assert.equal(result.statusCode, 400);
        assert.equal(result.body.error, 'invalid_grant');
    });
});

describe('auth provider editor', () => {
    const html = fs.readFileSync(require.resolve('../mcp-auth.html'), 'utf8');
    const definitions = {};
    const values = {};
    const visible = {};
    const handlers = {};
    let tabs;
    const $ = selector => ({
        get length() { return selector in values ? 1 : 0; },
        val(value) { if (value !== undefined) values[selector] = value; return values[selector]; },
        text(value) { values[selector] = value; },
        on(event, handler) { handlers[selector + ':' + event] = handler; },
        hide() { visible['#mcp-auth-oidc'] = false; visible['#mcp-auth-microsoft'] = false; },
        show() { visible[selector] = true; }
    });
    vm.runInNewContext(html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1], {
        URL, $, RED: { nodes: { registerType(name, definition) { definitions[name] = definition; } }, tabs: {
            create(options) { tabs = { definitions: [], addTab(tab) { this.definitions.push(tab); },
                activateTab(id) { options.onchange(this.definitions.find(tab => tab.id === id)); } }; return tabs; }
        } }
    });

    it('validates against the provider tab selected in the open dialog', () => {
        const definition = definitions['mcp-auth'];
        values['#node-config-input-provider'] = 'microsoft';
        assert.equal(definition.defaults.microsoftTenantId.validate.call({ provider: 'oidc' }, ''), false);
        assert.equal(definition.defaults.issuerUrl.validate.call({ provider: 'oidc' }, ''), true);
        values['#node-config-input-provider'] = 'oidc';
        assert.equal(definition.defaults.issuerUrl.validate.call({ provider: 'microsoft' }, ''), false);
        delete values['#node-config-input-provider'];
    });

    it('selects, persists and reopens either provider tab without losing inactive values', () => {
        const definition = definitions['mcp-auth'];
        values['#node-config-input-clientId'] = 'oidc-client';
        values['#node-config-input-microsoftClientId'] = client;
        definition.oneditprepare.call({ provider: 'microsoft' });
        assert.deepEqual(tabs.definitions.map(tab => tab.id), ['microsoft', 'oidc']);
        assert.equal(tabs.definitions[1].label, 'OIDC');
        assert.equal(values['#node-config-input-provider'], 'microsoft');
        assert.equal(visible['#mcp-auth-microsoft'], true);
        assert.equal(visible['#mcp-auth-oidc'], false);
        tabs.activateTab('oidc');
        assert.equal(values['#node-config-input-provider'], 'oidc');
        assert.equal(visible['#mcp-auth-oidc'], true);
        assert.equal(visible['#mcp-auth-microsoft'], false);
        assert.equal(values['#node-config-input-microsoftClientId'], client);
        definition.oneditprepare.call({ provider: values['#node-config-input-provider'] });
        assert.equal(visible['#mcp-auth-oidc'], true);
        assert.equal(values['#node-config-input-clientId'], 'oidc-client');
    });

    it('validates only active settings and declares both secrets as credentials', () => {
        const definition = definitions['mcp-auth'];
        delete values['#node-config-input-provider'];
        assert.equal(definition.defaults.issuerUrl.validate.call({ provider: 'microsoft' }, ''), true);
        assert.equal(definition.defaults.issuerUrl.validate.call({ provider: 'oidc' }, 'http://idp.example.test'), false);
        assert.equal(definition.defaults.microsoftTenantId.validate.call({ provider: 'oidc' }, ''), true);
        assert.equal(definition.defaults.microsoftTenantId.validate.call({ provider: 'microsoft' }, 'common'), false);
        assert.equal(definition.defaults.microsoftTenantId.validate.call({ provider: 'microsoft' }, tenant), true);
        assert.equal(definition.credentials.clientSecret.type, 'password');
        assert.equal(definition.credentials.microsoftClientSecret.type, 'password');
        for (const key of Object.keys(definition.defaults)) {
            assert.ok(html.includes('id="node-config-input-' + key + '"'), key);
        }
    });

    it('updates the redirect template from the typed slug without reading a runtime', () => {
        values['#node-config-input-oauthSlug'] = 'first-login';
        definitions['mcp-auth'].oneditprepare.call({ id: 'auth' });
        assert.equal(values['#mcp-auth-redirect-url'], 'Redirect URL: https://<nodered>/oauth/first-login/callback');
        values['#node-config-input-oauthSlug'] = 'second-login';
        handlers['#node-config-input-oauthSlug:input']();
        assert.equal(values['#mcp-auth-redirect-url'], 'Redirect URL: https://<nodered>/oauth/second-login/callback');
        values['#node-config-input-oauthSlug'] = '<script>';
        handlers['#node-config-input-oauthSlug:input']();
        assert.match(values['#mcp-auth-redirect-url'], /invalid slug/);
        values['#node-config-input-oauthSlug'] = 'login';
        handlers['#node-config-input-oauthSlug:input']();
        assert.equal(values['#mcp-auth-redirect-url'], 'Redirect URL: https://<nodered>/oauth/login/callback');
    });
});

describe('auth configuration reporting', () => {
    it('reports invalid auth settings and makes endpoints refuse to start', () => {
        const node = runtime()({ provider: 'oidc', oauthSlug: 'test-login', issuerUrl: 'http://insecure.example.test' });
        assert.match(node.configError, /HTTPS/);
        assert.match(node.errorLog[0], /MCP auth configuration is invalid/);
        const types = {};
        const RED = { events: new EventEmitter(), httpAdmin: { get() {} }, nodes: {
            createNode(target, config) { Object.setPrototypeOf(target, EventEmitter.prototype); EventEmitter.call(target);
                target.id = config.id; target.credentials = {}; target.status = () => {}; target.error = () => {}; },
            registerType(name, ctor) { types[name] = ctor; },
            getNode(id) { return id === 'auth' ? node : id === 'runtime' ? runtimeNode : null; } } };
        delete require.cache[require.resolve('../mcp-flow-server')];
        require('../mcp-flow-server')(RED);
        const runtimeNode = new types['mcp-runtime']({ id: 'runtime', serverPort: 18130 });
        const endpoint = new types['mcp-flow-server']({ id: 'endpoint', runtime: 'runtime', auth: 'auth', serverPath: '/mcp/x' });
        assert.throws(() => endpoint.initializeServer(), /MCP auth configuration is invalid: .*HTTPS/);
    });

    it('routes Redis client errors to the storage node instead of unhandled events', () => {
        const { createStorage } = require('../lib/auth-storage');
        const seen = [];
        const storage = createStorage({ mode: 'manual', host: '127.0.0.1', port: 1, onError: error => seen.push(error.message) });
        try {
            assert.ok(storage.client.listenerCount('error') >= 1);
            storage.client.emit('error', new Error('connection refused'));
            assert.deepStrictEqual(seen, ['connection refused']);
        } finally { storage.client.disconnect(); }
    });
});
