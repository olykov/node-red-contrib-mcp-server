"use strict";

const axios = require('axios');
const { createHash, randomBytes } = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { isIP } = require('net');
const { hashToken, normalizeTtl } = require('./auth-storage');
const { authRouteSlug } = require('./auth-provider');
const { ACCESS_TTL } = require('./refresh-tokens');

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

function authServerMetadataPath(slug)
{
    return '/.well-known/oauth-authorization-server/' + authRouteSlug({ oauthSlug: slug });
}

function authBasePath(slug)
{
    return '/oauth/' + authRouteSlug({ oauthSlug: slug });
}

function authIssuerUrl(req, node)
{
    const url = new URL(absoluteUrl(req, node.publicBaseUrl, '/'));
    return url.origin;
}

function authCallbackPath(slug)
{
    return authBasePath(slug) + '/callback';
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
    const registered = metadata && metadata.redirect_uris;
    if (!Array.isArray(registered) || typeof redirectUri !== 'string') return false;
    if (registered.includes(redirectUri)) return true;
    if (metadata.application_type !== 'native' && metadata.application_type !== undefined) return false;

    // RFC 8252: native loopback callbacks may use an OS-assigned port.
    const loopback = /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(?::([0-9]{1,5}))?(\/[^#]*)$/;
    const requested = loopback.exec(redirectUri);
    if (!requested || (requested[2] && (Number(requested[2]) < 1 || Number(requested[2]) > 65535))) return false;
    return registered.some(uri =>
    {
        if (typeof uri !== 'string') return false;
        const match = loopback.exec(uri);
        return Boolean(match && (!match[2] || (Number(match[2]) >= 1 && Number(match[2]) <= 65535)) &&
            match[1] === requested[1] && match[3] === requested[3]);
    });
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
    for (const field of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint'])
        if (!safeHttpsUrl(value[field])) throw new Error('OIDC endpoints must be HTTPS');
    if (trimTrailingSlash(value.issuer) !== base) throw new Error('OIDC discovery issuer mismatch');
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

async function verifyIdToken(auth, discovery, idToken, expectedNonce, refreshing = false)
{
    if (!idToken) throw new Error('OIDC token response is missing id_token');
    const issuer = discovery.issuer || trimTrailingSlash(auth.issuerUrl);
    const resolveKey = jwksFor(auth, discovery.jwks_uri);
    const verified = await jwtVerify(idToken, async (...args) => {
        try { return await resolveKey(...args); }
        catch (error)
        {
            if (['ERR_JOSE_GENERIC', 'ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID'].includes(error.code) ||
                transientProviderError(error)) error.providerUnavailable = true;
            throw error;
        }
    }, {
        issuer,
        audience: auth.clientId
    });
    if ((!refreshing || verified.payload.nonce !== undefined) && verified.payload.nonce !== expectedNonce)
    {
        throw new Error('OIDC id_token nonce mismatch');
    }
    if ((!refreshing && (typeof expectedNonce !== 'string' || !expectedNonce)) ||
        typeof verified.payload.sub !== 'string' || !verified.payload.sub)
    {
        throw new Error('OIDC identity claims are missing');
    }
    if (auth.provider === 'microsoft' && verified.payload.tid !== auth.tenantId)
    {
        throw new Error('Microsoft tenant claim mismatch');
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
        maxRedirects: 0,
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
        maxRedirects: 0,
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

function oauthScopes(auth)
{
    return parseList(auth && auth.baseScopes).concat(auth && auth.refreshStore ? ['offline_access'] : []);
}

function endpointAllowedGroups(node)
{
    return parseList(node.allowedGroups || '');
}

function authorizeMetadata(req, node)
{
    const auth = node.authConfig;
    const authPath = authBasePath(authRouteSlug(auth));
    return {
        issuer: authIssuerUrl(req, node),
        authorization_endpoint: absoluteUrl(req, node.publicBaseUrl, authPath + '/authorize'),
        token_endpoint: absoluteUrl(req, node.publicBaseUrl, authPath + '/token'),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', ...(auth.refreshStore ? ['refresh_token'] : [])],
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: true,
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: oauthScopes(auth)
    };
}

function protectedResourceMetadata(req, node)
{
    const auth = node.authConfig;
    return {
        resource: publicResourceUrl(req, node),
        authorization_servers: [authIssuerUrl(req, node)],
        scopes_supported: oauthScopes(auth),
        bearer_methods_supported: ['header']
    };
}

function policyAllowsEndpoint(node, claims)
{
    return hasAny(endpointAllowedGroups(node), claims.groups || []);
}

async function validateRequest(node, req)
{
    const auth = node.authConfig;
    if (!auth || typeof auth.readAccessToken !== 'function') return { ok: false, status: 503, error: 'auth_not_configured' };
    const token = tokenFromRequest(req);
    if (!token) return { ok: false, status: 401, error: 'missing_token' };
    const tokenRecord = await auth.readAccessToken(token);
    if (!tokenRecord) return { ok: false, status: 401, error: 'invalid_token' };
    if (tokenRecord.sessionId)
    {
        const session = auth.refreshStore && await auth.refreshStore.readSession(tokenRecord.sessionId);
        if (!session || session.expiresAt <= Date.now() || session.idleExpiresAt <= Date.now())
            return { ok: false, status: 401, error: 'invalid_token' };
    }
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

function writeToolAuthFailure(req, res, node, id)
{
    const description = 'Authentication required';
    res.json({
        jsonrpc: '2.0', id,
        result: {
            content: [{ type: 'text', text: description }],
            isError: true,
            _meta: { 'mcp/www_authenticate': [bearerChallenge(req, node) +
                ', error="invalid_token", error_description="' + description + '"'] }
        }
    });
}

function issueOpaqueAccessToken(authNode, claims, ttlSeconds)
{
    const token = randomToken(32);
    if (ttlSeconds !== undefined && ttlSeconds <= 0) throw new Error('Access token lifetime has expired');
    const ttl = Math.min(ACCESS_TTL, normalizeTtl(ttlSeconds || authNode.accessTokenTtl));
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
    const offline = parseList(query.scope).includes('offline_access');
    if (!hasAll(parseList(query.scope), oauthScopes(auth))) return res.status(400).json({ error: 'invalid_scope' });

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
    });

    const upstream = new URL(discovery.authorization_endpoint);
    upstream.searchParams.set('response_type', 'code');
    upstream.searchParams.set('client_id', auth.clientId);
    upstream.searchParams.set('redirect_uri', absoluteUrl(req, node.publicBaseUrl, authCallbackPath(authRouteSlug(auth))));
    const upstreamScopes = parseList(auth.baseScopes);
    upstream.searchParams.set('scope', uniqueList(upstreamScopes.concat(offline ? ['offline_access'] : [])).join(' '));
    upstream.searchParams.set('state', serverState);
    upstream.searchParams.set('nonce', nonce);
    res.redirect(upstream.toString());
}

async function upstreamIdentity(auth, discovery, tokens, nonce, refreshing = false)
{
    if (!tokens.access_token) throw new Error('OIDC token response is missing access_token');
    const idClaims = tokens.id_token || !refreshing || auth.provider === 'microsoft' ?
        await verifyIdToken(auth, discovery, tokens.id_token, nonce, refreshing) : null;
    let profile = idClaims;
    let groups;
    if (auth.provider === 'microsoft')
    {
        const roles = idClaims.roles;
        if (roles !== undefined && (!Array.isArray(roles) || roles.some(role => typeof role !== 'string' || !role.trim())))
            throw new Error('Microsoft roles claim must be an array of non-empty strings');
        groups = uniqueList(roles || []);
    }
    else if (auth.provider === 'oidc')
    {
        profile = await fetchUserInfo(discovery, tokens.access_token);
        if (typeof profile.sub !== 'string' || !profile.sub || (idClaims && profile.sub !== idClaims.sub))
            throw new Error('OIDC UserInfo subject mismatch');
        groups = parseList(profile[auth.groupClaim] || []);
    }
    else throw new Error('Select an MCP identity provider');
    return { subject: profile.sub, email: profile[auth.userClaim] || '', groups };
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
    const callback = absoluteUrl(req, node.publicBaseUrl, authCallbackPath(authRouteSlug(auth)));
    const upstreamTokens = await exchangeUpstreamCode(auth, discovery, query.code, callback);
    if (!upstreamTokens.access_token) return res.status(502).json({ error: 'invalid_token_response' });
    const identity = await upstreamIdentity(auth, discovery, upstreamTokens, state.nonce);
    if (auth.provider === 'microsoft' && !identity.groups.length)
        return res.status(403).json({ error: 'insufficient_access' });
    const code = randomToken(32);
    const scopes = uniqueList(parseList(state.scope));
    if (!policyAllowsEndpoint(node, identity)) return res.status(403).json({ error: 'insufficient_access' });
    const offline = scopes.includes('offline_access');
    if (offline && (!auth.refreshStore || typeof upstreamTokens.refresh_token !== 'string' || !upstreamTokens.refresh_token))
        return res.status(502).json({ error: 'invalid_token_response' });
    await auth.writeCode(code, {
        client_id: state.client_id,
        redirect_uri: state.redirect_uri,
        code_challenge: state.code_challenge,
        resource: state.resource,
        endpointId: state.endpointId,
        scopes,
        ...identity,
        ...(offline ? { upstreamRefresh: auth.refreshStore.seal(upstreamTokens.refresh_token), nonce: state.nonce,
            expiresAt: Date.now() + auth.sessionTtl * 1000 } : {})
    });

    const redirect = new URL(state.redirect_uri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', state.client_state);
    res.redirect(redirect.toString());
}

async function exchangeClientCode(req, res, node)
{
    const auth = node.authConfig;
    const body = req.body || {};
    if (body.grant_type === 'refresh_token') return exchangeRefreshToken(req, res, node);
    if (body.grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
    if (!body.code || !body.redirect_uri || !body.client_id || !body.code_verifier)
    {
        return res.status(400).json({ error: 'invalid_request' });
    }
    const codeRecord = await auth.consumeCode(body.code);
    if (!codeRecord) return res.status(400).json({ error: 'invalid_grant' });
    if (codeRecord.client_id !== body.client_id || codeRecord.redirect_uri !== body.redirect_uri)
    {
        return res.status(400).json({ error: 'invalid_grant' });
    }
    if (sha256Base64Url(body.code_verifier) !== codeRecord.code_challenge)
    {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    const refresh = codeRecord.scopes.includes('offline_access') && auth.refreshStore ?
        await auth.refreshStore.create({ client_id: codeRecord.client_id, resource: codeRecord.resource,
            endpointId: codeRecord.endpointId, subject: codeRecord.subject, scopes: codeRecord.scopes,
            upstreamRefresh: codeRecord.upstreamRefresh, nonce: codeRecord.nonce, expiresAt: codeRecord.expiresAt }) : null;
    const issued = await issueOpaqueAccessToken(auth, {
        resource: codeRecord.resource,
        scopes: codeRecord.scopes,
        groups: codeRecord.groups,
        subject: codeRecord.subject,
        email: codeRecord.email,
        ...(refresh ? { sessionId: refresh.session.id } : {})
    }, refresh ? Math.min(auth.accessTokenTtl, Math.floor((refresh.session.expiresAt - Date.now()) / 1000)) : auth.accessTokenTtl);
    res.json({
        access_token: issued.token,
        token_type: 'Bearer',
        expires_in: issued.ttl,
        scope: parseList(codeRecord.scopes).join(' '),
        ...(refresh ? { refresh_token: refresh.token } : {})
    });
}

function refreshLog(node, category)
{
    if (typeof node.log === 'function') node.log('OAuth refresh: ' + category);
}

function transientProviderError(error)
{
    const status = error.response && error.response.status;
    return error.providerUnavailable === true || status === 429 || status >= 500 || error.code === 'ERR_JWKS_TIMEOUT' ||
        error.code === 'ERR_JWKS_INVALID' || (axios.isAxiosError(error) && !error.response) ||
        ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code) ||
        (error instanceof TypeError && error.cause && error.cause.code);
}

function providerConfigError(error)
{
    const code = error && error.response && error.response.data && error.response.data.error;
    return code === 'invalid_client' || code === 'unauthorized_client';
}

function refreshUnavailable(res, error)
{
    const retry = error && error.response && error.response.headers && error.response.headers['retry-after'];
    if (typeof retry === 'string' && (/^\d{1,8}$/.test(retry) ||
        /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry))) res.set('Retry-After', retry);
    return res.status(503).json({ error: 'temporarily_unavailable',
        error_description: 'Identity provider unavailable; retry' });
}

function reuseResponse(res, result, accessExpiresAt, scopes)
{
    if (!hasAll(parseList(result.scope), scopes) || !hasAll(scopes, parseList(result.scope)))
        return res.status(400).json({ error: 'invalid_scope' });
    const remaining = Math.ceil((accessExpiresAt - Date.now()) / 1000);
    if (remaining <= 0) return refreshUnavailable(res);
    return res.json({ ...result, expires_in: Math.min(result.expires_in, remaining) });
}

async function exchangeRefreshToken(req, res, node)
{
    const auth = node.authConfig;
    const body = req.body || {};
    if (!auth.refreshStore) return res.status(400).json({ error: 'unsupported_grant_type' });
    if (typeof body.refresh_token !== 'string' || !body.refresh_token || typeof body.client_id !== 'string' || !body.client_id)
        return res.status(400).json({ error: 'invalid_request' });
    let claimed;
    let session;
    let phase = 'storage';
    let recovered = {};
    try
    {
        session = await auth.refreshStore.read(body.refresh_token);
        if (!session) return res.status(400).json({ error: 'invalid_grant' });
        if (session.client_id !== body.client_id || session.endpointId !== node.endpointId ||
            session.resource !== publicResourceUrl(req, node) || (body.resource && body.resource !== session.resource))
        {
            await auth.refreshStore.revoke(session.id);
            refreshLog(node, 'replay');
            return res.status(400).json({ error: 'invalid_grant' });
        }
        const scopes = body.scope === undefined ? session.scopes : parseList(body.scope);
        if (!hasAll(scopes, session.scopes)) return res.status(400).json({ error: 'invalid_scope' });
        claimed = await auth.refreshStore.claim(session, body.refresh_token);
        if (!claimed) { refreshLog(node, 'replay'); return res.status(400).json({ error: 'invalid_grant' }); }
        if (claimed.busy) { refreshLog(node, 'transient'); return refreshUnavailable(res); }
        if (claimed.reuse)
        {
            refreshLog(node, 'grace_reuse');
            return reuseResponse(res, claimed.reuse, claimed.accessExpiresAt, scopes);
        }
        let pending = auth.refreshStore.pendingResult(claimed);
        if (!pending || pending.accessExpiresAt <= Date.now())
        {
            phase = 'discovery';
            const discovery = await oidcDiscovery(auth);
            phase = 'provider';
            const response = await axios.post(discovery.token_endpoint, formUrlEncoded({
                grant_type: 'refresh_token', refresh_token: auth.refreshStore.open(claimed.upstreamRefresh),
                client_id: auth.clientId, client_secret: auth.clientSecret(), scope: uniqueList(
                    parseList(auth.baseScopes).concat(['openid', 'offline_access'])).join(' ')
            }).toString(), {
                timeout: 10000, maxRedirects: 0, headers: { 'content-type': 'application/x-www-form-urlencoded' },
                responseType: 'json', maxContentLength: 65536, maxBodyLength: 65536,
                validateStatus: status => status >= 200 && status < 300
            });
            const tokens = response.data;
            if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token)
            {
                phase = 'discovery';
                throw new Error('Invalid provider response');
            }
            phase = 'identity';
            recovered = { upstreamRefresh: tokens.refresh_token === undefined ? claimed.upstreamRefresh :
                auth.refreshStore.seal(tokens.refresh_token), pending: undefined };
            const identity = await upstreamIdentity(auth, discovery, tokens, claimed.nonce, true);
            if (identity.subject !== claimed.subject || (auth.provider === 'microsoft' && !identity.groups.length) ||
                !policyAllowsEndpoint(node, identity)) throw new Error('Access denied');
            const ttl = Math.min(auth.accessTokenTtl, Math.floor((claimed.expiresAt - Date.now()) / 1000));
            if (ttl <= 0) throw new Error('Refresh session expired');
            pending = { response: { access_token: randomToken(), refresh_token: randomToken(),
                token_type: 'Bearer', expires_in: ttl, scope: scopes.join(' ') },
                claims: { ...identity, resource: session.resource, scopes, sessionId: session.id },
                updates: { scopes, upstreamRefresh: recovered.upstreamRefresh }, accessExpiresAt: Date.now() + ttl * 1000 };
            phase = 'storage';
            const saved = await auth.refreshStore.checkpoint(claimed, pending);
            if (!saved) throw new Error('Refresh claim changed');
            claimed = saved;
            recovered = {};
        }
        if (!hasAll(scopes, pending.updates.scopes) || !hasAll(pending.updates.scopes, scopes))
        {
            await auth.refreshStore.release(claimed);
            return res.status(400).json({ error: 'invalid_scope' });
        }
        phase = 'identity';
        if (!policyAllowsEndpoint(node, pending.claims)) throw new Error('Access denied');
        phase = 'storage';
        const ttl = Math.floor((pending.accessExpiresAt - Date.now()) / 1000);
        if (ttl <= 0) throw new Error('Pending access token expired');
        await auth.writeAccessToken(pending.response.access_token,
            { ...pending.claims, expiresAt: pending.accessExpiresAt }, ttl);
        const rotated = await auth.refreshStore.rotate(claimed, pending.updates, pending);
        if (!rotated) throw new Error('Refresh claim changed');
        return reuseResponse(res, pending.response, pending.accessExpiresAt, scopes);
    } catch (error)
    {
        const configError = phase === 'provider' && providerConfigError(error);
        if (phase === 'storage' || phase === 'discovery' || configError || transientProviderError(error))
        {
            if (claimed && claimed.state === 'refreshing')
            {
                try
                {
                    const current = await auth.refreshStore.readSession(claimed.id);
                    if (current && current.claimId === claimed.claimId)
                        await auth.refreshStore.release(current,
                            current.pending && current.pending !== claimed.pending ? {} : recovered);
                } catch (_) { /* Storage is still unavailable. */ }
            }
            if (configError)
            {
                if (typeof node.error === 'function') node.error('OAuth refresh: provider_config');
                else refreshLog(node, 'provider_config');
            }
            else refreshLog(node, 'transient');
            return refreshUnavailable(res, error);
        }
        try
        {
            const current = claimed && await auth.refreshStore.readSession(claimed.id);
            if (claimed && current && current.claimId !== claimed.claimId) return refreshUnavailable(res);
            if (session) await auth.refreshStore.revoke(session.id);
        }
        catch (_)
        {
            refreshLog(node, 'transient');
            return refreshUnavailable(res);
        }
        refreshLog(node, 'revoked');
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh failed; sign in again' });
    }
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
    oauthScopes,
    policyAllowsEndpoint,
    validateRequest,
    writeAuthFailure,
    writeToolAuthFailure,
    issueOpaqueAccessToken,
    beginAuthorization,
    completeAuthorization,
    exchangeClientCode,
    exchangeRefreshToken,
    clientMetadata,
    oidcDiscovery,
    verifyIdToken,
    sha256Base64Url,
    isPrivateHost
};
