"use strict";

const { createHash } = require('crypto');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
            clientSecretEnv: config.microsoftClientSecretEnv || '',
            credentialName: 'microsoftClientSecret',
            baseScopes: 'openid profile email',
            groupClaim: 'roles',
            userClaim: 'email'
        };
    }
    if (config.provider !== 'authentik') throw new Error('Select an MCP identity provider');
    let issuer;
    try { issuer = new URL(config.issuerUrl); } catch (_) { throw new Error('Authentik issuer must be an HTTPS URL'); }
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash)
    {
        throw new Error('Authentik issuer must be an HTTPS URL');
    }
    if (typeof config.clientId !== 'string' || !config.clientId.trim()) throw new Error('Authentik client ID is required');
    return {
        provider: 'authentik',
        issuerUrl: issuer.toString().replace(/\/+$/, ''),
        clientId: config.clientId.trim(),
        clientSecretEnv: config.clientSecretEnv || '',
        credentialName: 'clientSecret',
        baseScopes: config.baseScopes || 'openid profile email groups',
        groupClaim: config.groupClaim || 'groups',
        userClaim: config.userClaim || 'email'
    };
}

function authStorageScope(id, settings)
{
    return createHash('sha256').update(JSON.stringify([
        id, settings.provider, settings.issuerUrl, settings.clientId,
        settings.groupClaim, settings.baseScopes
    ])).digest('hex');
}

module.exports = { providerSettings, authStorageScope };
