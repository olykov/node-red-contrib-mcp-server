module.exports = function (RED)
{
    "use strict";

    const { createStorage, hashToken } = require('./lib/auth-storage');
    const { providerSettings, authStorageScope, authRouteSlug, mcpEnvName } = require('./lib/auth-provider');
    const { RefreshTokenStore, refreshEncryptionKey, boundedTtl, ACCESS_TTL, REFRESH_IDLE_TTL, SESSION_TTL } = require('./lib/refresh-tokens');
    const OAUTH_TRANSACTION_TTL = 300;

    function envOrCredential(node, envName, credentialName)
    {
        const fromEnv = envName ? process.env[mcpEnvName(envName, 'Environment variable')] : '';
        if (fromEnv) return fromEnv;
        return node.credentials && node.credentials[credentialName] ? node.credentials[credentialName] : '';
    }

    function MCPRedisConfigNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;
        node.name = config.name || '';
        node.mode = config.mode || 'memory';
        node.redisUrlEnv = config.redisUrlEnv || 'MCP_REDIS_URL';
        node.host = config.host || '127.0.0.1';
        node.port = Number(config.port || 6379);
        node.db = Number(config.db || 0);
        node.tls = config.tls || false;
        node.username = config.username || '';
        node.keyPrefix = config.keyPrefix || 'mcp_auth:';
        node.storage = null;
        try
        {
            if (node.mode === 'env') mcpEnvName(node.redisUrlEnv, 'URL Env');
            if (node.mode === 'manual') mcpEnvName(config.passwordEnv, 'Password Env');
        } catch (error)
        {
            node.configError = error.message;
            node.error('MCP auth storage configuration is invalid: ' + error.message);
        }
        let lastStorageError = 0;

        function reportStorageError(error)
        {
            const now = Date.now();
            if (now - lastStorageError < 60000) return;
            lastStorageError = now;
            node.warn('MCP auth storage connection error: ' + (error && error.message ? error.message : String(error)));
        }

        node.createStorage = function ()
        {
            if (node.configError) throw new Error('MCP auth storage configuration is invalid: ' + node.configError);
            if (!node.storage)
            {
                node.storage = createStorage({
                    mode: node.mode,
                    redisUrlEnv: node.redisUrlEnv,
                    host: node.host,
                    port: node.port,
                    db: node.db,
                    tls: node.tls,
                    username: node.username,
                    password: envOrCredential(node, config.passwordEnv || '', 'password'),
                    keyPrefix: node.keyPrefix,
                    onError: reportStorageError
                });
            }
            return node.storage;
        };

        node.on('close', function (done)
        {
            if (node.storage && typeof node.storage.close === 'function')
            {
                Promise.resolve(node.storage.close()).then(() => done()).catch(() => done());
            } else done();
        });
    }

    function MCPAuthConfigNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;
        const getNode = RED.nodes && typeof RED.nodes.getNode === 'function' ? RED.nodes.getNode.bind(RED.nodes) : null;
        node.name = config.name || '';
        let settings;
        try
        {
            settings = providerSettings(config);
            node.oauthSlug = authRouteSlug(config);
            node.accessTokenTtl = boundedTtl(config.accessTokenTtl, ACCESS_TTL);
            node.refreshTokenTtl = boundedTtl(config.refreshTokenTtl, REFRESH_IDLE_TTL);
            node.sessionTtl = boundedTtl(config.sessionTtl, SESSION_TTL);
        } catch (error)
        {
            // Endpoints refuse to start with an invalid auth node; report why instead of vanishing.
            node.configError = error.message;
            node.error('MCP auth configuration is invalid: ' + error.message);
            return;
        }
        Object.assign(node, settings);
        node.redisConfigId = config.redis || '';
        node.redisConfig = node.redisConfigId && getNode ? getNode(node.redisConfigId) : null;
        if (node.redisConfig && node.redisConfig.configError)
        {
            node.configError = 'storage: ' + node.redisConfig.configError;
            node.error('MCP auth configuration is invalid: ' + node.configError);
            return;
        }
        const storageScope = authStorageScope({ ...settings, oauthSlug: node.oauthSlug });
        node.allowedClientHosts = config.allowedClientHosts || '';
        node.storage = null;

        node.clientSecret = function ()
        {
            const secret = envOrCredential(node, node.clientSecretEnv, settings.credentialName);
            if (!secret) throw new Error('Active provider client secret is not configured');
            return secret;
        };

        node.getStorage = function ()
        {
            if (!node.storage)
            {
                if (!node.redisConfig || typeof node.redisConfig.createStorage !== 'function')
                {
                    throw new Error('MCP auth storage config is required');
                }
                node.storage = node.redisConfig.createStorage();
            }
            return node.storage;
        };

        node.refreshStore = null;
        try
        {
            const encryptionKey = refreshEncryptionKey(node.credentials && node.credentials[
                node.provider === 'microsoft' ? 'microsoftRefreshKey' : 'oidcRefreshKey']);
            node.refreshStore = encryptionKey ? new RefreshTokenStore(() => node.getStorage(),
                storageScope, encryptionKey, node.refreshTokenTtl, node.sessionTtl) : null;
        } catch (error)
        {
            node.configError = error.message;
            node.error('MCP auth configuration is invalid: ' + error.message);
            return;
        }

        node.writeAccessToken = async function (token, claims, ttlSeconds)
        {
            await node.getStorage().set('access:' + storageScope, hashToken(token), claims, ttlSeconds || node.accessTokenTtl);
        };

        node.readAccessToken = async function (token)
        {
            return node.getStorage().get('access:' + storageScope, hashToken(token));
        };

        node.writeState = async function (state, value)
        {
            await node.getStorage().set('state:' + storageScope, state, value, OAUTH_TRANSACTION_TTL);
        };

        node.readState = async function (state)
        {
            return node.getStorage().get('state:' + storageScope, state);
        };

        node.deleteState = async function (state)
        {
            await node.getStorage().delete('state:' + storageScope, state);
        };

        node.writeCode = async function (code, value)
        {
            await node.getStorage().set('code:' + storageScope, code, value, OAUTH_TRANSACTION_TTL);
        };

        node.readCode = async function (code)
        {
            return node.getStorage().get('code:' + storageScope, code);
        };

        node.deleteCode = async function (code)
        {
            await node.getStorage().delete('code:' + storageScope, code);
        };

        node.consumeCode = async function (code)
        {
            const record = await node.readCode(code);
            if (!record || record.consumed) return null;
            const consumed = await node.getStorage().compareAndSet('code:' + storageScope,
                code, record, { consumed: true }, OAUTH_TRANSACTION_TTL);
            if (!consumed) return null;
            await node.deleteCode(code);
            return record;
        };

        node.on('close', function (done)
        {
            done();
        });
    }

    RED.nodes.registerType('nr-mcp-auth-storage', MCPRedisConfigNode, {
        credentials: {
            password: { type: 'password' }
        }
    });
    RED.nodes.registerType('nr-mcp-auth', MCPAuthConfigNode, {
        credentials: {
            clientSecret: { type: 'password' },
            microsoftClientSecret: { type: 'password' },
            oidcRefreshKey: { type: 'password' },
            microsoftRefreshKey: { type: 'password' }
        }
    });
};
