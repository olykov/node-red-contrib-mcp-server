'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = require('jose');
const {
    authorizeMetadata,
    beginAuthorization,
    clientMetadata,
    completeAuthorization,
    exchangeClientCode,
    isPrivateHost,
    protectedResourceMetadata,
    sha256Base64Url,
    verifyIdToken
} = require('../lib/mcp-auth');

function mockRes() {
    return {
        statusCode: 200,
        body: undefined,
        location: '',
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        redirect(location) { this.location = location; return this; }
    };
}

function authNodeWithCode(record) {
    const state = { code: record, deleted: false, access: null };
    return {
        id: 'auth-1',
        accessTokenTtl: 3600,
        readCode: async code => code === 'valid-code' ? state.code : null,
        deleteCode: async code => {
            if (code === 'valid-code') state.deleted = true;
        },
        writeAccessToken: async (token, claims, ttl) => {
            state.access = { token, claims, ttl };
        },
        state
    };
}

describe('mcp auth token exchange', () => {
    it('rejects private client metadata hosts before network access', async () => {
        assert.strictEqual(isPrivateHost('127.0.0.1'), true);
        assert.strictEqual(isPrivateHost('192.168.1.10'), true);
        assert.strictEqual(isPrivateHost('client.example.test'), false);

        await assert.rejects(
            () => clientMetadata({ allowedClientHosts: 'localhost' }, 'https://localhost/metadata.json'),
            /host is not allowed/
        );
    });

    it('advertises OAuth metadata without a dynamic registration endpoint', () => {
        const req = { headers: { host: 'mcp.example.test', 'x-forwarded-proto': 'https' } };
        const node = {
            publicBaseUrl: 'https://mcp.example.test',
            serverPath: '/mcp/test',
            endpointRequiredScopes: 'resource:read',
            authConfig: { id: 'auth-1', baseScopes: 'openid profile email' }
        };

        const authorizationServer = authorizeMetadata(req, node);
        const protectedResource = protectedResourceMetadata(req, node);

        assert.strictEqual(authorizationServer.issuer, 'https://mcp.example.test');
        assert.deepStrictEqual(authorizationServer.code_challenge_methods_supported, ['S256']);
        assert.strictEqual(authorizationServer.client_id_metadata_document_supported, true);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(authorizationServer, ['registration', 'endpoint'].join('_')), false);
        assert.deepStrictEqual(protectedResource.authorization_servers, ['https://mcp.example.test']);
        assert.strictEqual(protectedResource.resource, 'https://mcp.example.test/mcp/test');
    });

    it('bridges authorize and callback through OIDC discovery and userinfo', async () => {
        const originalGet = axios.get;
        const originalPost = axios.post;
        const { publicKey, privateKey } = await generateKeyPair('RS256');
        const publicJwk = await exportJWK(publicKey);
        publicJwk.kid = 'test-key';
        publicJwk.alg = 'RS256';
        const signIdToken = nonce => new SignJWT({ sub: 'subject-1', email: 'user@example.test', nonce })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setIssuer('https://issuer.example.test/oidc')
            .setAudience('upstream-client')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);
        const store = { state: null, code: null };
        const auth = {
            id: 'auth-1',
            issuerUrl: 'https://issuer.example.test/oidc',
            clientId: 'upstream-client',
            baseScopes: 'openid profile email',
            allowedClientHosts: 'client.example.test',
            groupClaim: 'groups',
            userClaim: 'email',
            stateTtl: 300,
            authCodeTtl: 300,
            jwks: createLocalJWKSet({ keys: [publicJwk] }),
            clientSecret: () => 'placeholder-value',
            writeState: async (state, value) => { store.state = { state, value }; },
            readState: async state => state === store.state.state ? store.state.value : null,
            deleteState: async state => { if (state === store.state.state) store.state.deleted = true; },
            writeCode: async (code, value) => { store.code = { code, value }; }
        };
        const node = {
            endpointId: 'endpoint-1',
            publicBaseUrl: 'https://mcp.example.test',
            serverPath: '/mcp/test',
            endpointRequiredScopes: ['resource:read'],
            authConfig: auth
        };

        axios.get = async url => {
            if (url === 'https://client.example.test/metadata.json') {
                return { data: { redirect_uris: ['https://client.example.test/callback'] } };
            }
            if (url === 'https://issuer.example.test/oidc/.well-known/openid-configuration') {
                return { data: {
                    issuer: 'https://issuer.example.test/oidc',
                    authorization_endpoint: 'https://issuer.example.test/authorize',
                    token_endpoint: 'https://issuer.example.test/token',
                    userinfo_endpoint: 'https://issuer.example.test/userinfo',
                    jwks_uri: 'https://issuer.example.test/jwks'
                } };
            }
            if (url === 'https://issuer.example.test/userinfo') {
                return { data: { sub: 'subject-1', email: 'user@example.test', groups: ['team-a'] } };
            }
            throw new Error('Unexpected GET ' + url);
        };
        axios.post = async url => {
            assert.strictEqual(url, 'https://issuer.example.test/token');
            return { data: { access_token: 'placeholder-access-token', id_token: await signIdToken(store.state.value.nonce) } };
        };

        try {
            const authorizeRes = mockRes();
            await beginAuthorization({
                headers: { host: 'mcp.example.test', 'x-forwarded-proto': 'https' },
                query: {
                    response_type: 'code',
                    code_challenge_method: 'S256',
                    code_challenge: 'challenge',
                    client_id: 'https://client.example.test/metadata.json',
                    redirect_uri: 'https://client.example.test/callback',
                    state: 'client-state',
                    scope: 'openid profile'
                }
            }, authorizeRes, node);

            const upstreamRedirect = new URL(authorizeRes.location);
            assert.strictEqual(upstreamRedirect.origin + upstreamRedirect.pathname, 'https://issuer.example.test/authorize');
            assert.strictEqual(upstreamRedirect.searchParams.get('client_id'), 'upstream-client');
            assert.strictEqual(upstreamRedirect.searchParams.get('redirect_uri'), 'https://mcp.example.test/oauth/auth-1/callback');
            assert.strictEqual(store.state.value.client_state, 'client-state');
            assert.strictEqual(store.state.value.endpointId, 'endpoint-1');

            const callbackRes = mockRes();
            await completeAuthorization({
                headers: { host: 'mcp.example.test', 'x-forwarded-proto': 'https' },
                query: { code: 'upstream-code', state: store.state.state }
            }, callbackRes, node);

            const clientRedirect = new URL(callbackRes.location);
            assert.strictEqual(clientRedirect.origin + clientRedirect.pathname, 'https://client.example.test/callback');
            assert.strictEqual(clientRedirect.searchParams.get('state'), 'client-state');
            assert.strictEqual(clientRedirect.searchParams.get('code'), store.code.code);
            assert.strictEqual(store.state.deleted, true);
            assert.deepStrictEqual(store.code.value.groups, ['team-a']);
            assert.deepStrictEqual(store.code.value.scopes, ['openid', 'profile', 'resource:read']);
        } finally {
            axios.get = originalGet;
            axios.post = originalPost;
        }
    });

    it('rejects OIDC id_token nonce mismatches', async () => {
        const { publicKey, privateKey } = await generateKeyPair('RS256');
        const publicJwk = await exportJWK(publicKey);
        publicJwk.kid = 'test-key';
        publicJwk.alg = 'RS256';
        const idToken = await new SignJWT({ sub: 'subject-1', nonce: 'wrong-nonce' })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setIssuer('https://issuer.example.test/oidc')
            .setAudience('upstream-client')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);

        await assert.rejects(
            () => verifyIdToken({
                clientId: 'upstream-client',
                jwks: createLocalJWKSet({ keys: [publicJwk] })
            }, {
                issuer: 'https://issuer.example.test/oidc',
                jwks_uri: 'https://issuer.example.test/jwks'
            }, idToken, 'expected-nonce'),
            /nonce mismatch/
        );
    });

    it('exchanges an authorization code with PKCE S256 into an opaque access token', async () => {
        const verifier = 'correct horse battery staple';
        const auth = authNodeWithCode({
            client_id: 'https://client.example.test/metadata.json',
            redirect_uri: 'https://client.example.test/callback',
            code_challenge: sha256Base64Url(verifier),
            resource: 'https://mcp.example.test/mcp/test',
            scopes: ['resource:read'],
            groups: ['team-a'],
            subject: 'subject-1',
            email: 'user@example.test'
        });
        const res = mockRes();

        await exchangeClientCode({
            body: {
                grant_type: 'authorization_code',
                code: 'valid-code',
                client_id: 'https://client.example.test/metadata.json',
                redirect_uri: 'https://client.example.test/callback',
                code_verifier: verifier
            }
        }, res, { authConfig: auth });

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.token_type, 'Bearer');
        assert.strictEqual(res.body.expires_in, 3600);
        assert.strictEqual(res.body.scope, 'resource:read');
        assert.ok(res.body.access_token);
        assert.strictEqual(auth.state.deleted, true);
        assert.strictEqual(auth.state.access.claims.resource, 'https://mcp.example.test/mcp/test');
    });

    it('rejects an authorization code when PKCE verification fails', async () => {
        const auth = authNodeWithCode({
            client_id: 'https://client.example.test/metadata.json',
            redirect_uri: 'https://client.example.test/callback',
            code_challenge: sha256Base64Url('expected-verifier'),
            resource: 'https://mcp.example.test/mcp/test',
            scopes: ['resource:read']
        });
        const res = mockRes();

        await exchangeClientCode({
            body: {
                grant_type: 'authorization_code',
                code: 'valid-code',
                client_id: 'https://client.example.test/metadata.json',
                redirect_uri: 'https://client.example.test/callback',
                code_verifier: 'wrong-verifier'
            }
        }, res, { authConfig: auth });

        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error, 'invalid_grant');
        assert.strictEqual(auth.state.access, null);
    });
});
