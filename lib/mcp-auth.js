"use strict";

const axios = require('axios');
const { createHash, randomBytes } = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { isIP } = require('net');
const { hashToken, normalizeTtl } = require('./auth-storage');

function parseList(value)
{
    if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
    if (typeof value !== 'string') return [];
    return value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

function uniqueList(values)
{
    return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizePath(value)
{
    const raw = typeof value === 'string' && value.trim() ? value.trim() : '/mcp';
    return raw.startsWith('/') ? raw : '/' + raw;
}

function trimTrailingSlash(value)
{
    return String(value || '').replace(/\/+$/, '');
}

function randomToken(bytes = 32)
{
    return randomBytes(bytes).toString('base64url');
}

function sha256Base64Url(value)
{
    return createHash('sha256').update(String(value)).digest('base64url');
}

function tokenFromRequest(req)
{
    const header = req && req.headers ? req.headers.authorization || req.headers.Authorization : '';
    const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null;
    return match ? match[1].trim() : '';
}

function hasAll(required, actual)
{
    const available = new Set(parseList(actual));
    return parseList(required).every(item => available.has(item));
}

function hasAny(required, actual)
{
    const values = parseList(required);
    if (!values.length) return true;
    const available = new Set(parseList(actual));
    return values.some(item => available.has(item));
}

function absoluteUrl(req, configuredBaseUrl, path)
{
    const normalizedPath = path.startsWith('/') ? path : '/' + path;
    const base = trimTrailingSlash(configuredBaseUrl);
    if (base) return base + normalizedPath;
    const proto = (req.headers && (req.headers['x-forwarded-proto'] || req.protocol)) || 'http';
    const host = req.headers && req.headers.host ? req.headers.host : 'localhost';
    return String(proto).split(',')[0].trim() + '://' + host + normalizedPath;
}

function metadataPath(serverPath)
{
    return '/.well-known/oauth-protected-resource' + normalizePath(serverPath);
}

function authServerMetadataPath(authId)
{
    return '/.well-known/oauth-authorization-server/' + encodeURIComponent(authId || 'default');
}

function authBasePath(authId)
{
    return '/oauth/' + encodeURIComponent(authId || 'default');
}

function authIssuerUrl(req, node)
{
    const auth = node.authConfig;
    return absoluteUrl(req, node.publicBaseUrl, authBasePath(auth && auth.id));
}

function authCallbackPath(authId)
{
    return authBasePath(authId) + '/callback';
}

function safeHttpsUrl(value)
{
    try
    {
        const url = new URL(String(value));
        if (url.protocol !== 'https:') return null;
        if (url.username || url.password) return null;
        return url;
    } catch (error)
    {
        return null;
    }
}

function isPrivateHost(hostname)
{
    const host = String(hostname || '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    const family = isIP(host);
    if (family === 4)
    {
        const parts = host.split('.').map(Number);
        return parts[0] === 10 ||
            parts[0] === 127 ||
            (parts[0] === 169 && parts[1] === 254) ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168);
    }
    if (family === 6)
    {
        return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
    }
    return false;
}

function hostAllowed(url, allowedHosts)
{
    const hosts = parseList(allowedHosts);
    if (!hosts.length) return false;
    return hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host));
}

function redirectAllowed(metadata, redirectUri)
{
    return Array.isArray(metadata && metadata.redirect_uris) && metadata.redirect_uris.includes(redirectUri);
}

async function fetchJson(url)
{
    const response = await axios.get(url, {
        timeout: 5000,
        responseType: 'json',
        maxContentLength: 65536,
        maxBodyLength: 65536,
        maxRedirects: 0,
        validateStatus: status => status >= 200 && status < 300
    });
    return response.data;
}

async function clientMetadata(auth, clientId)
{
    const url = safeHttpsUrl(clientId);
    if (!url) throw new Error('client_id must be an HTTPS metadata URL');
    if (isPrivateHost(url.hostname)) throw new Error('client_id host is not allowed');
    if (!hostAllowed(url, auth.allowedClientHosts)) throw new Error('client_id host is not allowed');
    return fetchJson(url.toString());
}

async function oidcDiscovery(auth)
{
    if (auth.discovery && auth.discovery.expiresAt > Date.now()) return auth.discovery.value;
    const issuer = safeHttpsUrl(auth.issuerUrl);
    if (!issuer) throw new Error('OIDC issuer URL must be HTTPS');
    const base = issuer.toString().replace(/\/+$/, '');
    const value = await fetchJson(base + '/.well-known/openid-configuration');
    if (!value.issuer || !value.authorization_endpoint || !value.token_endpoint || !value.userinfo_endpoint || !value.jwks_uri)
    {
        throw new Error('OIDC discovery document is missing required endpoints');
    }
    if (!safeHttpsUrl(value.jwks_uri)) throw new Error('OIDC JWKS URI must be HTTPS');
    auth.discovery = { value, expiresAt: Date.now() + 300000 };
    return value;
}

function jwksFor(auth, jwksUri)
{
    if (auth.jwks) return auth.jwks;
    if (!auth.remoteJwks || auth.remoteJwksUri !== jwksUri)
    {
        auth.remoteJwksUri = jwksUri;
        auth.remoteJwks = createRemoteJWKSet(new URL(jwksUri), {
            cooldownDuration: 30000,
            cacheMaxAge: 300000,
            timeoutDuration: 5000
        });
    }
    return auth.remoteJwks;
}

async function verifyIdToken(auth, discovery, idToken, expectedNonce)
{
    if (!idToken) throw new Error('OIDC token response is missing id_token');
    const issuer = discovery.issuer || trimTrailingSlash(auth.issuerUrl);
    const verified = await jwtVerify(idToken, jwksFor(auth, discovery.jwks_uri), {
        issuer,
        audience: auth.clientId
    });
    if (verified.payload.nonce !== expectedNonce)
    {
        throw new Error('OIDC id_token nonce mismatch');
    }
    return verified.payload;
}

function formUrlEncoded(data)
{
    const body = new URLSearchParams();
    Object.entries(data).forEach(([key, value]) =>
    {
        if (value !== undefined && value !== null && value !== '') body.set(key, String(value));
    });
    return body;
}

async function exchangeUpstreamCode(auth, discovery, code, redirectUri)
{
    const response = await axios.post(discovery.token_endpoint, formUrlEncoded({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: auth.clientId,
        client_secret: auth.clientSecret()
    }).toString(), {
        timeout: 10000,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        responseType: 'json',
        validateStatus: status => status >= 200 && status < 300
    });
    return response.data;
}

async function fetchUserInfo(discovery, accessToken)
{
    const response = await axios.get(discovery.userinfo_endpoint, {
        timeout: 10000,
        headers: { authorization: 'Bearer ' + accessToken },
        responseType: 'json',
        validateStatus: status => status >= 200 && status < 300
    });
    return response.data;
}

function bearerChallenge(req, node)
{
    const metadataUrl = absoluteUrl(req, node.publicBaseUrl, metadataPath(node.serverPath));
    return 'Bearer resource_metadata="' + metadataUrl.replace(/"/g, '%22') + '"';
}

function publicResourceUrl(req, node)
{
    return absoluteUrl(req, node.publicBaseUrl, node.serverPath);
}

function endpointRequiredScopes(node)
{
    return parseList(node.endpointRequiredScopes || '');
}

function endpointAllowedGroups(node)
{
    return parseList(node.allowedGroups || '');
}

function authorizeMetadata(req, node)
{
    const auth = node.authConfig;
    const authPath = authBasePath(auth && auth.id);
    return {
        issuer: authIssuerUrl(req, node),
        authorization_endpoint: absoluteUrl(req, node.publicBaseUrl, authPath + '/authorize'),
        token_endpoint: absoluteUrl(req, node.publicBaseUrl, authPath + '/token'),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: true,
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: parseList(auth && auth.baseScopes).concat(endpointRequiredScopes(node))
    };
}

function protectedResourceMetadata(req, node)
{
    const auth = node.authConfig;
    return {
        resource: publicResourceUrl(req, node),
        authorization_servers: [authIssuerUrl(req, node)],
        scopes_supported: endpointRequiredScopes(node),
        bearer_methods_supported: ['header']
    };
}

function isAuthRequired(node)
{
    if (!node.authConfig || node.authMode === 'public') return false;
    if (node.authMode === 'oauth') return true;
    return Boolean(node.authConfig.enabled);
}

function policyAllowsEndpoint(node, claims)
{
    if (!hasAny(endpointAllowedGroups(node), claims.groups || [])) return false;
    return hasAll(endpointRequiredScopes(node), claims.scopes || []);
}

function policyAllowsTool(node, tool, claims)
{
    return policyAllowsEndpoint(node, claims) && hasAll(tool && tool.requiredScopes || [], claims.scopes || []);
}

async function validateRequest(node, req)
{
    if (!isAuthRequired(node)) return { ok: true, claims: { scopes: [], groups: [] } };
    const token = tokenFromRequest(req);
    if (!token) return { ok: false, status: 401, error: 'missing_token' };
    const auth = node.authConfig;
    if (!auth || typeof auth.readAccessToken !== 'function') return { ok: false, status: 500, error: 'auth_not_configured' };
    const tokenRecord = await auth.readAccessToken(token);
    if (!tokenRecord) return { ok: false, status: 401, error: 'invalid_token' };
    const resource = publicResourceUrl(req, node);
    if (tokenRecord.resource && tokenRecord.resource !== resource) return { ok: false, status: 403, error: 'wrong_resource' };
    const claims = {
        subject: tokenRecord.subject || '',
        email: tokenRecord.email || '',
        groups: parseList(tokenRecord.groups || []),
        scopes: parseList(tokenRecord.scopes || [])
    };
    if (!policyAllowsEndpoint(node, claims)) return { ok: false, status: 403, error: 'insufficient_access' };
    return { ok: true, claims };
}

function writeAuthFailure(req, res, node, result)
{
    if (result.status === 401)
    {
        res.set('WWW-Authenticate', bearerChallenge(req, node));
        return res.status(401).json({ error: 'invalid_token', error_description: 'Authentication required' });
    }
    return res.status(result.status || 403).json({ error: result.error || 'forbidden', error_description: 'Access denied' });
}

function issueOpaqueAccessToken(authNode, claims, ttlSeconds)
{
    const token = randomToken(32);
    const ttl = normalizeTtl(ttlSeconds || authNode.accessTokenTtl);
    return authNode.writeAccessToken(token, claims, ttl).then(() => ({ token, ttl }));
}

async function beginAuthorization(req, res, node)
{
    const auth = node.authConfig;
    const query = req.query || {};
    if (query.response_type !== 'code') return res.status(400).json({ error: 'unsupported_response_type' });
    if (query.code_challenge_method !== 'S256') return res.status(400).json({ error: 'invalid_request', error_description: 'PKCE S256 is required' });
    if (!query.code_challenge || !query.client_id || !query.redirect_uri || !query.state)
    {
        return res.status(400).json({ error: 'invalid_request' });
    }
    const metadata = await clientMetadata(auth, query.client_id);
    if (!redirectAllowed(metadata, query.redirect_uri)) return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is not registered for this client' });
    const resource = query.resource || publicResourceUrl(req, node);
    if (resource !== publicResourceUrl(req, node)) return res.status(400).json({ error: 'invalid_target', error_description: 'resource does not match this MCP endpoint' });

    const discovery = await oidcDiscovery(auth);
    const serverState = randomToken(24);
    const nonce = randomToken(24);
    await auth.writeState(serverState, {
        client_id: query.client_id,
        redirect_uri: query.redirect_uri,
        client_state: query.state,
        code_challenge: query.code_challenge,
        resource,
        scope: query.scope || '',
        endpointId: node.endpointId,
        nonce
    }, auth.stateTtl);

    const upstream = new URL(discovery.authorization_endpoint);
    upstream.searchParams.set('response_type', 'code');
    upstream.searchParams.set('client_id', auth.clientId);
    upstream.searchParams.set('redirect_uri', absoluteUrl(req, node.publicBaseUrl, authCallbackPath(auth.id)));
    upstream.searchParams.set('scope', auth.baseScopes || 'openid profile email');
    upstream.searchParams.set('state', serverState);
    upstream.searchParams.set('nonce', nonce);
    res.redirect(upstream.toString());
}

async function completeAuthorization(req, res, node)
{
    const auth = node.authConfig;
    const query = req.query || {};
    if (!query.code || !query.state) return res.status(400).json({ error: 'invalid_request' });
    const state = await auth.readState(query.state);
    if (!state) return res.status(400).json({ error: 'invalid_state' });
    await auth.deleteState(query.state);

    const discovery = await oidcDiscovery(auth);
    const callback = absoluteUrl(req, node.publicBaseUrl, authCallbackPath(auth.id));
    const upstreamTokens = await exchangeUpstreamCode(auth, discovery, query.code, callback);
    if (!upstreamTokens.access_token) return res.status(502).json({ error: 'invalid_token_response' });
    const idClaims = await verifyIdToken(auth, discovery, upstreamTokens.id_token, state.nonce);
    const profile = await fetchUserInfo(discovery, upstreamTokens.access_token);
    const code = randomToken(32);
    const scopes = uniqueList([].concat(parseList(state.scope), endpointRequiredScopes(node)));
    await auth.writeCode(code, {
        client_id: state.client_id,
        redirect_uri: state.redirect_uri,
        code_challenge: state.code_challenge,
        resource: state.resource,
        endpointId: state.endpointId,
        scopes,
        groups: parseList(profile[auth.groupClaim] || []),
        subject: idClaims.sub || profile.sub || profile[auth.userClaim] || '',
        email: profile[auth.userClaim] || ''
    }, auth.authCodeTtl);

    const redirect = new URL(state.redirect_uri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', state.client_state);
    res.redirect(redirect.toString());
}

async function exchangeClientCode(req, res, node)
{
    const auth = node.authConfig;
    const body = req.body || {};
    if (body.grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
    if (!body.code || !body.redirect_uri || !body.client_id || !body.code_verifier)
    {
        return res.status(400).json({ error: 'invalid_request' });
    }
    const codeRecord = await auth.readCode(body.code);
    if (!codeRecord) return res.status(400).json({ error: 'invalid_grant' });
    await auth.deleteCode(body.code);
    if (codeRecord.client_id !== body.client_id || codeRecord.redirect_uri !== body.redirect_uri)
    {
        return res.status(400).json({ error: 'invalid_grant' });
    }
    if (sha256Base64Url(body.code_verifier) !== codeRecord.code_challenge)
    {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    const issued = await issueOpaqueAccessToken(auth, {
        resource: codeRecord.resource,
        scopes: codeRecord.scopes,
        groups: codeRecord.groups,
        subject: codeRecord.subject,
        email: codeRecord.email
    }, auth.accessTokenTtl);
    res.json({
        access_token: issued.token,
        token_type: 'Bearer',
        expires_in: issued.ttl,
        scope: parseList(codeRecord.scopes).join(' ')
    });
}

module.exports = {
    parseList,
    normalizePath,
    randomToken,
    hashToken,
    tokenFromRequest,
    absoluteUrl,
    metadataPath,
    authServerMetadataPath,
    authBasePath,
    authIssuerUrl,
    bearerChallenge,
    protectedResourceMetadata,
    authorizeMetadata,
    isAuthRequired,
    policyAllowsEndpoint,
    policyAllowsTool,
    validateRequest,
    writeAuthFailure,
    issueOpaqueAccessToken,
    beginAuthorization,
    completeAuthorization,
    exchangeClientCode,
    clientMetadata,
    oidcDiscovery,
    verifyIdToken,
    sha256Base64Url,
    isPrivateHost
};
