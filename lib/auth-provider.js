"use strict";

const { createHash } = require('crypto');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MCP_ENV_NAME = /^MCP_[A-Z0-9_]+$/;

// Editor-supplied variable names may read only MCP_* variables, never other process secrets.
function mcpEnvName(value, field)
{
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) return '';
    if (!MCP_ENV_NAME.test(name)) throw new Error(field + ' must be an environment variable name starting with MCP_');
    return name;
}

function authRouteSlug(auth)
{
    const slug = auth && auth.oauthSlug;
    if (typeof slug !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(slug))
    {
        throw new Error('OAuth slug must be 1-63 lowercase letters, digits or hyphens, starting with a letter');
    }
    return slug;
}

function providerSettings(config)
{
    if (config.provider === 'microsoft')
    {
        if (!GUID.test(config.microsoftTenantId || '') || !GUID.test(config.microsoftClientId || ''))
        {
            throw new Error('Microsoft tenant ID and client ID must be GUIDs');
        }
        return {
            provider: 'microsoft',
            tenantId: config.microsoftTenantId.toLowerCase(),
            issuerUrl: 'https://login.microsoftonline.com/' + config.microsoftTenantId.toLowerCase() + '/v2.0',
            clientId: config.microsoftClientId.toLowerCase(),
            clientSecretEnv: mcpEnvName(config.microsoftClientSecretEnv, 'Secret Env'),
            credentialName: 'microsoftClientSecret',
            baseScopes: 'openid profile email',
            groupClaim: 'roles',
            userClaim: 'email'
        };
    }
    if (config.provider !== 'oidc') throw new Error('Select an MCP identity provider');
    let issuer;
    try { issuer = new URL(config.issuerUrl); } catch (_) { throw new Error('OIDC issuer must be an HTTPS URL'); }
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash)
    {
        throw new Error('OIDC issuer must be an HTTPS URL');
    }
    if (typeof config.clientId !== 'string' || !config.clientId.trim()) throw new Error('OIDC client ID is required');
    return {
        provider: 'oidc',
        issuerUrl: issuer.toString().replace(/\/+$/, ''),
        clientId: config.clientId.trim(),
        clientSecretEnv: mcpEnvName(config.clientSecretEnv, 'Secret Env'),
        credentialName: 'clientSecret',
        baseScopes: 'openid profile email groups',
        groupClaim: config.groupClaim || 'groups',
        userClaim: config.userClaim || 'email'
    };
}

// Sessions belong to the provider identity and slug, not to the Node-RED node ID,
// so replacing an auth node with the same settings keeps users signed in.
function authStorageScope(settings)
{
    return createHash('sha256').update(JSON.stringify([
        settings.provider, settings.issuerUrl, settings.clientId,
        settings.groupClaim, settings.baseScopes, settings.oauthSlug
    ])).digest('hex');
}

module.exports = { providerSettings, authStorageScope, authRouteSlug, mcpEnvName };
