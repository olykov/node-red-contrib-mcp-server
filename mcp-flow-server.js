module.exports = function (RED)
{
    "use strict";

    const http = require('http');
    const express = require('express');
    const { randomUUID: uuidv4 } = require('crypto');
    const { normalizeIp, parseCidr, ipInCidr } = require('./lib/cidr');
    const { createAdminTools } = require('./lib/admin-tools');
    const { auditLog } = require('./lib/audit');
    const { message } = require('./lib/messages');
    const statusText = (node, key, vars) => message(node, 'mcp-flow-server', 'mcp-flow-server.status.' + key, vars);
    const PACKAGE_VERSION = require('./package.json').version;
    const PROTOCOL_VERSION = '2026-07-28';
    const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION];
    const HEADER_MISMATCH = -32020;
    const UNSUPPORTED_PROTOCOL_VERSION = -32022;
    const LIST_TTL_MS = 60000;

    function decodeHeaderValue(value)
    {
        const match = /^=\?base64\?(.*)\?=$/.exec(String(value));
        return match ? Buffer.from(match[1], 'base64').toString('utf8') : value;
    }
    const { authRouteSlug, mcpEnvName } = require('./lib/auth-provider');
    const {
        absoluteUrl,
        authorizeMetadata,
        beginAuthorization,
        completeAuthorization,
        exchangeClientCode,
        oauthScopes,
        protectedResourceMetadata,
        parseGroupNames,
        validateRequest,
        writeAuthFailure
    } = require('./lib/mcp-auth');


    const serverInstances = new Map();
    const runtimes = new Set();
    const pendingExecutions = new Map();
    let legacyAdminTokenWarningShown = false;

    function origin(value)
    {
        try
        {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol) || url.origin === 'null' ||
                url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
            return url.origin;
        } catch
        {
            return '';
        }
    }

    function requestSize(req, error)
    {
        const size = Number(error && error.received || req.headers && req.headers['content-length']);
        return Number.isSafeInteger(size) && size >= 0 ? size : null;
    }

    function parseGroupList(value)
    {
        if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
        if (typeof value !== 'string') return [];
        return value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    }

    function withSecurityMeta(tool, scopes, extraMeta = {})
    {
        const schemes = [{ type: 'oauth2', scopes }];
        const meta = Object.assign({}, tool._meta || {}, extraMeta || {});
        meta.securitySchemes = schemes;
        return Object.assign({}, tool, { securitySchemes: schemes, _meta: meta });
    }

    function normalizePath(value)
    {
        const raw = typeof value === 'string' && value.trim() ? value.trim() : '/mcp';
        return raw.startsWith('/') ? raw : '/' + raw;
    }

    function runtimeFromConfig(RED, config)
    {
        const getNode = RED.nodes && typeof RED.nodes.getNode === 'function' ? RED.nodes.getNode.bind(RED.nodes) : null;
        return config.runtime && getNode ? getNode(config.runtime) : null;
    }

    function configNode(RED, id)
    {
        const getNode = RED.nodes && typeof RED.nodes.getNode === 'function' ? RED.nodes.getNode.bind(RED.nodes) : null;
        return id && getNode ? getNode(id) : null;
    }

    function runtimeAdminToken(runtime)
    {
        return runtime && runtime.adminToken ||
            (runtime && runtime.adminTokenEnv && process.env[runtime.adminTokenEnv]) ||
            process.env.NODE_RED_ADMIN_API_TOKEN || '';
    }

    function adminApiConfig(RED, runtime)
    {
        const settings = RED.settings || {};
        const configuredHost = typeof settings.uiHost === 'string' ? settings.uiHost.trim() : '';
        const hostname = !configuredHost || configuredHost === '0.0.0.0' || configuredHost === '::' ?
            '127.0.0.1' : configuredHost;
        const adminRoot = settings.httpAdminRoot;
        const root = typeof adminRoot === 'string' && adminRoot !== '/' ?
            normalizePath(adminRoot).replace(/\/+$/, '') : '';
        return {
            protocol: settings.https ? 'https:' : 'http:',
            hostname,
            port: Number(settings.uiPort) || runtime.adminPort,
            root,
            ca: runtime.adminCa || undefined,
            disabled: adminRoot === false
        };
    }

    function clientIp(req, trustedProxies)
    {
        const socketIp = req.socket && req.socket.remoteAddress || '';
        const address = normalizeIp(socketIp);
        if (!address) return socketIp;
        const proxies = trustedProxies || [];
        const isTrusted = ip => proxies.some(cidr => ipInCidr(ip, cidr));
        if (!isTrusted(address)) return address;

        const forwarded = typeof req.headers['x-forwarded-for'] === 'string' ?
            req.headers['x-forwarded-for'].split(',').map(value => value.trim()).filter(Boolean) : [];
        for (let index = forwarded.length - 1; index >= 0; index--)
        {
            const candidate = normalizeIp(forwarded[index]);
            if (!candidate) break;
            if (!isTrusted(candidate)) return candidate;
        }
        return address;
    }

    function hasAdminTools(runtime, serverPath)
    {
        return Boolean(
            runtime &&
            runtime.adminPort &&
            runtimeAdminToken(runtime) &&
            runtime.adminEndpointPath &&
            normalizePath(runtime.adminEndpointPath) === serverPath
        );
    }

    function toolKey(tool)
    {
        return tool.registeredBy || tool.name;
    }

    function createListener(port)
    {
        const key = Number(port);
        const state = {
            port: key,
            bindHost: '',
            app: express(),
            httpServer: null,
            routes: new Map(),
            nodes: new Set(),
            runtimeId: '',
            isListening: false
        };

        state.app.use((req, res, next) =>
        {
            const node = state.routes.get(req.path);
            if (!node || req.method !== 'POST' || !req.headers.origin) return next();
            const requestOrigin = origin(req.headers.origin);
            const baseOrigin = origin(node.publicBaseUrl);
            const allowedOrigins = node.runtime && node.runtime.allowedOrigins || [];
            if (!requestOrigin || (requestOrigin !== baseOrigin && !allowedOrigins.includes(requestOrigin)))
                return res.status(403).json({ error: 'origin_not_allowed' });
            return next();
        });
        state.app.use(express.json({ limit: '256kb' }));
        state.app.use(express.urlencoded({ extended: false, limit: '16kb' }));

        state.app.get(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/, (req, res) =>
        {
            const requestedPath = req.params && req.params[0] ? req.params[0] : req.query.resource || '';
            const serverPath = requestedPath ? normalizePath(requestedPath) : '';
            const node = serverPath ? state.routes.get(serverPath) : (() =>
            {
                const protectedNodes = Array.from(state.routes.values()).filter(candidate => candidate.authConfig);
                return protectedNodes.length === 1 ? protectedNodes[0] : null;
            })();
            if (!node || !node.authConfig) return res.status(404).json({ error: 'MCP protected resource not found' });
            res.json(protectedResourceMetadata(req, node));
        });

        state.app.get(/^\/\.well-known\/oauth-authorization-server(\/.*)?$/, (req, res) =>
        {
            let slug = req.params && req.params[0] ? String(req.params[0]).replace(/^\//, '') : '';
            if (slug.startsWith('oauth/')) slug = slug.slice('oauth/'.length);
            const matches = Array.from(state.routes.values()).filter(candidate =>
                candidate.authConfig && (!slug || candidate.authConfig.oauthSlug === slug));
            const node = new Set(matches.map(candidate => candidate.authConfig)).size === 1 ? matches[0] : null;
            if (!node) return res.status(404).json({ error: 'MCP authorization server not found' });
            res.json(authorizeMetadata(req, node));
        });

        state.app.get(/^\/oauth\/([^/]+)\/authorize$/, async (req, res) =>
        {
            const slug = req.params[0];
            const resource = req.query && req.query.resource;
            const node = Array.from(state.routes.values()).find(candidate =>
                candidate.authConfig && candidate.authConfig.oauthSlug === slug &&
                (!resource || resource === absoluteUrl(req, candidate.publicBaseUrl, candidate.serverPath)));
            if (!node) return res.status(404).json({ error: 'MCP authorization endpoint not found' });
            try
            {
                await beginAuthorization(req, res, node);
            } catch (error)
            {
                node.error('OAuth authorize failed: ' + error.message);
                res.status(400).json({ error: 'invalid_request', error_description: 'Authorization request failed' });
            }
        });

        state.app.get(/^\/oauth\/([^/]+)\/callback$/, async (req, res) =>
        {
            const slug = req.params[0];
            const owner = Array.from(state.routes.values())
                .find(candidate => candidate.authConfig && candidate.authConfig.oauthSlug === slug);
            const auth = owner && owner.authConfig;
            let node = null;
            try
            {
                const stateRecord = auth && req.query && req.query.state ? await auth.readState(req.query.state) : null;
                node = stateRecord ? Array.from(state.routes.values()).find(candidate =>
                    candidate.authConfig && candidate.authConfig === auth && candidate.endpointId === stateRecord.endpointId) : null;
            } catch (error)
            {
                owner.error('OAuth callback storage error: ' + error.message);
                return res.status(503).json({ error: 'temporarily_unavailable' });
            }
            if (!node) return res.status(400).json({ error: 'invalid_state' });
            try
            {
                await completeAuthorization(req, res, node);
            } catch (error)
            {
                node.error('OAuth callback failed: ' + error.message);
                res.status(400).json({ error: 'invalid_request', error_description: 'Authorization callback failed' });
            }
        });

        state.app.post(/^\/oauth\/([^/]+)\/token$/, async (req, res) =>
        {
            const slug = req.params[0];
            const body = req.body || {};
            res.set('Cache-Control', 'no-store');
            res.set('Pragma', 'no-cache');
            if (!['authorization_code', 'refresh_token'].includes(body.grant_type))
                return res.status(400).json({ error: 'unsupported_grant_type' });
            let owner = null;
            try
            {
                for (const candidate of state.routes.values())
                {
                    if (!candidate.authConfig || candidate.authConfig.oauthSlug !== slug) continue;
                    owner = owner || candidate;
                    const auth = candidate.authConfig;
                    const record = body.grant_type === 'refresh_token' ?
                        (auth.refreshStore && typeof body.refresh_token === 'string' && await auth.refreshStore.read(body.refresh_token)) :
                        (typeof body.code === 'string' && await auth.readCode(body.code));
                    const node = record && Array.from(state.routes.values()).find(item =>
                        item.authConfig && item.authConfig === auth && item.endpointId === record.endpointId);
                    if (node) return await exchangeClientCode(req, res, node);
                }
                if (owner && body.grant_type === 'refresh_token')
                    auditLog(owner, 'oauth.refresh', { outcome: 'unknown', client: body.client_id, endpoint: owner.serverName });
                res.status(400).json({ error: 'invalid_grant' });
            } catch (error)
            {
                if (owner) owner.error('OAuth token storage error: ' + error.message);
                if (!res.headersSent) res.status(503).json({ error: 'temporarily_unavailable' });
            }
        });

        state.app.post(/.*/, async (req, res) =>
        {
            const node = state.routes.get(req.path);
            if (!node) return res.status(404).json({ error: 'MCP path not found' });
            await node.handleMcpHttpRequest(req, res);
        });

        state.app.all(/.*/, (req, res) => state.routes.has(req.path) ?
            res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed', error_description: 'Use JSON-RPC POST for MCP requests' }) :
            res.status(404).json({ error: 'MCP path not found' }));

        state.app.use((error, req, res, next) =>
        {
            if (res.headersSent) return next(error);
            const node = state.routes.get(req.path) || Array.from(state.routes.values()).find(candidate =>
                candidate.authConfig && req.path.startsWith('/oauth/' + candidate.authConfig.oauthSlug + '/'));
            const isMcp = Boolean(state.routes.get(req.path) && req.method === 'POST');
            const isOAuth = req.path.startsWith('/oauth/');
            const requestId = uuidv4();
            const tooLarge = error && error.type === 'entity.too.large';
            const invalidJson = error instanceof SyntaxError && error.type === 'entity.parse.failed';
            const code = tooLarge ? 'request_too_large' : (invalidJson ? 'invalid_json' : 'internal_error');
            const logNode = node || state.nodes.values().next().value;
            if (logNode)
            {
                logNode.error('HTTP request failed ' + JSON.stringify({
                    requestId, code, method: req.method, path: req.path, bodySize: requestSize(req, error),
                    ...(code === 'internal_error' ? { error: error && error.message || String(error) } : {})
                }));
            }
            const status = tooLarge ? 413 : (invalidJson ? 400 : 500);
            if (isMcp)
            {
                const rpcCode = tooLarge ? -32600 : (invalidJson ? -32700 : -32603);
                const message = tooLarge ? 'Invalid request' : (invalidJson ? 'Parse error' : 'Internal error');
                return res.status(status).json({ jsonrpc: '2.0', id: null,
                    error: { code: rpcCode, message, ...(status === 500 ? { data: { requestId } } : {}) } });
            }
            if (isOAuth || tooLarge || invalidJson)
                return res.status(status).json(tooLarge || invalidJson ?
                    { error: 'invalid_request' } : { error: 'internal_error', requestId });
            return res.status(500).json({ error: 'internal_error', requestId });
        });

        state.httpServer = http.createServer(state.app);
        state.httpServer.on('error', error =>
        {
            if (!state.isListening)
            {
                state.listenRequested = false;
                return;
            }
            state.isListening = false;
            for (const node of state.nodes)
            {
                node.isRunning = false;
                node.status({ fill: 'red', shape: 'dot', text: statusText(node, 'error') });
                node.error('MCP HTTP server error: ' + error.message);
                const instance = serverInstances.get(node.serverId);
                if (instance) serverInstances.set(node.serverId, { ...instance, isRunning: false });
            }
        });
        return state;
    }

    function closeListener(state, callback)
    {
        state.isListening = false;
        const server = state.httpServer;
        const close = () =>
        {
            server.close(() => callback());
            if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        };
        if (server.listening) return close();
        if (!state.listenRequested) return callback();
        const onListening = () => { server.removeListener('error', onError); close(); };
        const onError = () => { server.removeListener('listening', onListening); callback(); };
        server.once('listening', onListening);
        server.once('error', onError);
    }

    function textResult(text, isError = false)
    {
        return { content: [{ type: 'text', text: String(text) }], ...(isError ? { isError: true } : {}) };
    }

    function isMcpResult(value)
    {
        return value && typeof value === 'object' && !Array.isArray(value) &&
            ['content', 'structuredContent', '_meta', 'isError'].some(key =>
                Object.prototype.hasOwnProperty.call(value, key));
    }

    function normalizeToolResult(result)
    {
        if (result === undefined || result === null) return { content: [] };
        if (Buffer.isBuffer(result)) return textResult(result.toString('utf8'));
        if (isMcpResult(result)) return result;
        if (Array.isArray(result)) return { content: result };
        if (typeof result === 'string') return textResult(result);
        return textResult(JSON.stringify(result));
    }

    function errorText(error)
    {
        if (typeof error === 'string') return error;
        if (error && typeof error.message === 'string') return error.message;
        return JSON.stringify(error);
    }

    // Bounded client label for metrics: the MCP client product, not its metadata URL.
    function clientLabel(clientId)
    {
        let url;
        try { url = new URL(String(clientId || '')); } catch { return 'unknown'; }
        if (url.hostname === 'claude.ai') return 'claude';
        if (url.hostname === 'chatgpt.com') return url.pathname.includes('/codex/') ? 'codex' : 'chatgpt';
        return url.hostname;
    }

    function responseBytes(res)
    {
        const length = res && typeof res.getHeader === 'function' ? Number(res.getHeader('content-length')) : NaN;
        return Number.isSafeInteger(length) && length >= 0 ? length : null;
    }

    function MCPRuntimeNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;
        node.name = config.name || '';
        node.runtimeName = config.runtimeName || node.name || 'mcp-runtime';
        node.serverPort = Number(config.serverPort || 8001);
        node.publicBaseUrl = config.publicBaseUrl || '';
        node.bindHost = typeof config.bindHost === 'string' ? config.bindHost.trim() : '';
        if (!node.bindHost) node.warn('MCP runtime bindHost is not set; listening on all interfaces for backward compatibility');
        node.allowedOrigins = parseGroupList(config.allowedOrigins || '').map(origin);
        if (node.allowedOrigins.some(value => !value))
        {
            node.configError = 'Allowed Origins must contain only valid HTTP(S) origins';
            node.error('MCP runtime configuration is invalid: ' + node.configError);
            node.allowedOrigins = [];
        }
        node.allowFunctionCode = config.allowFunctionCode === true || config.allowFunctionCode === 'true';
        node.codeGroups = parseGroupNames(config.codeGroups || '');
        node.adminPort = Number(config.adminPort || 1880);
        node.adminToken = (node.credentials && node.credentials.adminToken) || '';
        try
        {
            node.adminTokenEnv = mcpEnvName(config.adminTokenEnv, 'Admin Token Env');
        } catch (error)
        {
            node.configError = error.message;
            node.error('MCP runtime configuration is invalid: ' + node.configError);
            node.adminTokenEnv = '';
        }
        node.adminCa = typeof config.adminCa === 'string' ? config.adminCa.trim() : '';
        if (!node.adminToken && !(node.adminTokenEnv && process.env[node.adminTokenEnv]) &&
            process.env.NODE_RED_ADMIN_API_TOKEN &&
            !legacyAdminTokenWarningShown)
        {
            legacyAdminTokenWarningShown = true;
            node.warn('NODE_RED_ADMIN_API_TOKEN is deprecated; configure Admin Token or Admin Token Env');
        }
        node.trustedProxies = [];
        try
        {
            node.trustedProxies = parseGroupList(config.trustedProxies || '').map(cidr =>
            {
                parseCidr(cidr);
                return cidr;
            });
        } catch
        {
            node.configError = 'Trusted Proxies must contain valid IP addresses or CIDR ranges';
            node.error('MCP runtime configuration is invalid: ' + node.configError);
        }
        node.adminEndpointPath = config.adminEndpointPath ? normalizePath(config.adminEndpointPath) : '';
        node.listener = null;
        node.tools = new Map();
        node.endpoints = new Set();
        const loggedToolConflicts = new Set();
        runtimes.add(node);

        node.acquireListener = function (endpoint)
        {
            if (!node.listener) node.listener = createListener(node.serverPort);
            const state = node.listener;
            const existingRoute = state.routes.get(endpoint.serverPath);
            if (existingRoute && existingRoute !== endpoint)
                throw new Error('MCP server path already registered on this port: ' + endpoint.serverPath);
            state.runtimeId = node.id;
            state.bindHost = node.bindHost || '';
            state.routes.set(endpoint.serverPath, endpoint);
            state.nodes.add(endpoint);
            return state;
        };

        node.releaseListener = function (endpoint, callback)
        {
            const state = node.listener;
            if (!state) return callback();
            if (state.routes.get(endpoint.serverPath) === endpoint) state.routes.delete(endpoint.serverPath);
            state.nodes.delete(endpoint);
            if (state.nodes.size) return callback();
            node.listener = null;
            closeListener(state, callback);
        };

        node.addEndpoint = function (endpoint)
        {
            node.endpoints.add(endpoint);
            node.refreshTools();
        };

        node.removeEndpoint = function (endpoint)
        {
            if (node.endpoints.delete(endpoint)) node.refreshTools();
        };

        node.toolsByPath = function ()
        {
            const tools = Array.from(node.tools.values());
            const conflicted = new Set();
            const active = new Set();
            const selectedByPath = new Map();
            for (const path of new Set(Array.from(node.endpoints, endpoint => endpoint.serverPath)))
            {
                const bound = tools.filter(tool => tool.endpointPath === path);
                const shared = tools.filter(tool => !tool.endpointPath);
                const selected = [];
                for (const name of new Set([...bound, ...shared].map(tool => tool.name)))
                {
                    const endpointTools = bound.filter(tool => tool.name === name);
                    const effective = endpointTools.length ? endpointTools : shared.filter(tool => tool.name === name);
                    if (effective.length > 1)
                    {
                        effective.forEach(tool => conflicted.add(toolKey(tool)));
                        const conflictKey = path + ':' + name;
                        active.add(conflictKey);
                        if (!loggedToolConflicts.has(conflictKey))
                        {
                            loggedToolConflicts.add(conflictKey);
                            node.warn('Duplicate MCP tool name "' + name + '" on ' + path);
                        }
                    } else if (effective.length === 1) selected.push(effective[0]);
                }
                selectedByPath.set(path, selected.sort((a, b) => a.name.localeCompare(b.name)));
            }
            for (const key of loggedToolConflicts)
                if (!active.has(key)) loggedToolConflicts.delete(key);
            return { selectedByPath, conflicted, tools };
        };

        node.refreshTools = function ()
        {
            const { conflicted, tools } = node.toolsByPath();
            for (const tool of tools)
                if (typeof tool.setStatus === 'function') tool.setStatus(conflicted.has(toolKey(tool)));
        };

        node.publishedTools = function (path)
        {
            return node.toolsByPath().selectedByPath.get(path) || [];
        };

        node.registerTool = function (tool)
        {
            node.tools.set(toolKey(tool), tool);
            node.refreshTools();
        };

        node.unregisterTool = function (registeredBy)
        {
            if (!node.tools.delete(registeredBy)) return;
            node.refreshTools();
        };

        let toolTelemetryListener = null;
        let telemetryWarningShown = false;

        node.subscribeToolTelemetry = function (listener)
        {
            if (toolTelemetryListener) return null;
            toolTelemetryListener = listener;
            return function ()
            {
                if (toolTelemetryListener === listener) toolTelemetryListener = null;
            };
        };

        node.publishToolTelemetry = function (event)
        {
            if (!toolTelemetryListener) return;
            try
            {
                toolTelemetryListener(event);
            } catch
            {
                if (!telemetryWarningShown)
                {
                    telemetryWarningShown = true;
                    node.warn('MCP tool telemetry subscriber failed');
                }
            }
        };

        node.on('close', function (done)
        {
            toolTelemetryListener = null;
            runtimes.delete(node);
            node.tools.clear();
            node.endpoints.clear();
            const state = node.listener;
            node.listener = null;
            if (state) closeListener(state, () => done());
            else done();
        });
    }

    function MCPFlowServerNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;
        const runtime = runtimeFromConfig(RED, config);

        node.runtimeId = config.runtime || '';
        node.runtime = runtime;
        node.authConfig = configNode(RED, config.auth);
        node.endpointId = node.id;
        node.activeToolCalls = 0;
        node.toolTimeoutMs = config.toolTimeoutMs === undefined || config.toolTimeoutMs === '' ?
            30000 : Number(config.toolTimeoutMs);
        node.maxConcurrentCalls = config.maxConcurrentCalls === undefined || config.maxConcurrentCalls === '' ?
            32 : Number(config.maxConcurrentCalls);
        if (!Number.isInteger(node.toolTimeoutMs) || node.toolTimeoutMs < 1000 || node.toolTimeoutMs > 600000)
        {
            node.configError = 'Tool Timeout must be between 1000 and 600000 milliseconds';
            node.error('MCP endpoint configuration is invalid: ' + node.configError);
            node.toolTimeoutMs = 30000;
        }
        if (!Number.isInteger(node.maxConcurrentCalls) || node.maxConcurrentCalls < 1 || node.maxConcurrentCalls > 1024)
        {
            node.configError = 'Max Concurrent Calls must be between 1 and 1024';
            node.error('MCP endpoint configuration is invalid: ' + node.configError);
            node.maxConcurrentCalls = 32;
        }
        node.serverName = config.serverName || config.name || 'node-red-mcp-server';
        node.serverPath = normalizePath(config.serverPath);
        node.serverPort = runtime ? runtime.serverPort : 0;
        node.publicBaseUrl = runtime ? runtime.publicBaseUrl : '';
        node.allowedGroups = parseGroupNames(config.allowedGroups || '');
        node.adminToolsEnabled = hasAdminTools(runtime, node.serverPath);
        node.adminPort = runtime ? runtime.adminPort : 0;
        node.adminToken = runtimeAdminToken(runtime);
        node.adminTools = createAdminTools({
            adminPort: node.adminPort,
            getAdminToken: () => node.adminToken,
            getAdminConfig: () => adminApiConfig(RED, runtime),
            eachNode: RED.nodes.eachNode && RED.nodes.eachNode.bind(RED.nodes),
            events: RED.events,
            canIncludeCode: claims => node.canIncludeFunctionCode(claims)
        });

        node.httpServer = null;
        node.app = null;
        node.isRunning = false;
        node.serverId = uuidv4();
        node.canIncludeFunctionCode = function (claims = {})
        {
            const groups = Array.isArray(claims.groups) ? claims.groups.map(String) : [];
            return Boolean(runtime && runtime.allowFunctionCode &&
                runtime.codeGroups.some(group => groups.includes(group)));
        };

        node.status({ fill: "grey", shape: "ring", text: statusText(node, 'stopped') });

        node.publishToolTelemetry = function (event)
        {
            if (node.runtime && node.runtime.publishToolTelemetry)
            {
                node.runtime.publishToolTelemetry({ endpoint: node.serverName, ...event });
            }
        };

        node.initializeServer = function ()
        {
            if (!node.runtime)
            {
                throw new Error('MCP runtime is required');
            }
            if (node.configError)
                throw new Error('MCP endpoint configuration is invalid: ' + node.configError);
            if (node.runtime.configError)
                throw new Error('MCP runtime configuration is invalid: ' + node.runtime.configError);
            if (!node.authConfig)
                throw new Error('MCP auth configuration is required');
            if (node.authConfig.configError)
                throw new Error('MCP auth configuration is invalid: ' + node.authConfig.configError);
            // OAuth metadata must not be derived from request headers.
            if (!/^https?:\/\/[^/]+/.test(String(node.publicBaseUrl || '')))
                throw new Error('MCP runtime Base URL is required');
            // Deny by default: an endpoint without groups would admit every user of the identity provider.
            if (!node.allowedGroups.length)
                throw new Error('MCP endpoint Groups are required');
            const slug = authRouteSlug(node.authConfig);
            const base = String(node.publicBaseUrl || '').replace(/\/+$/, '');
            for (const runtime of runtimes)
            {
                if (!runtime.listener) continue;
                for (const candidate of runtime.listener.routes.values())
                {
                    if (candidate.authConfig === node.authConfig) continue;
                    const sameBase = base && base === String(candidate.publicBaseUrl || '').replace(/\/+$/, '');
                    if ((runtime === node.runtime || sameBase) && candidate.authConfig.oauthSlug === slug)
                    {
                        throw new Error('OAuth slug already registered by another auth configuration: ' + slug);
                    }
                }
            }
            const portState = node.runtime.acquireListener(node);
            node.portState = portState;
            node.app = portState.app;
            node.httpServer = portState.httpServer;
        };

        node.protocolError = function (req, request)
        {
            const headers = req.headers || {};
            const meta = request.params && request.params._meta;
            const bodyVersion = meta && meta['io.modelcontextprotocol/protocolVersion'];
            const headerVersion = headers['mcp-protocol-version'];
            const requested = headerVersion || bodyVersion || (request.params && request.params.protocolVersion) || null;
            if (request.method === 'initialize' || !SUPPORTED_PROTOCOL_VERSIONS.includes(requested))
                return { code: UNSUPPORTED_PROTOCOL_VERSION, message: 'Unsupported protocol version',
                    data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested } };
            if (!headerVersion || headerVersion !== bodyVersion)
                return { code: HEADER_MISMATCH, message: 'Header mismatch: MCP-Protocol-Version must match _meta protocolVersion' };
            if (headers['mcp-method'] !== request.method)
                return { code: HEADER_MISMATCH, message: 'Header mismatch: Mcp-Method must match method' };
            if (request.method === 'tools/call' &&
                decodeHeaderValue(headers['mcp-name']) !== (request.params && request.params.name))
                return { code: HEADER_MISMATCH, message: 'Header mismatch: Mcp-Name must match params.name' };
            return null;
        };

        node.result = function (res, id, result)
        {
            res.json({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result,
                _meta: { ...(result && result._meta), 'io.modelcontextprotocol/serverInfo': { name: node.serverName, version: PACKAGE_VERSION } } } });
        };

        node.handleMcpHttpRequest = async function (req, res)
        {
            const request = req.body || {};
            if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.method !== 'string')
                return node.rpcError(res, null, -32600, 'Invalid request', undefined, 400);
            const toolRequest = request.method === 'tools/call';
            const started = toolRequest ? process.hrtime.bigint() : null;
            let handledToolCall = false;
            try
            {
                const protocolError = node.protocolError(req, request);
                if (protocolError)
                    return node.rpcError(res, request.id, protocolError.code, protocolError.message, protocolError.data, 400);
                let authResult;
                try
                {
                    authResult = await validateRequest(node, req);
                } catch (error)
                {
                    const requestId = uuidv4();
                    node.error('MCP token validation storage failed ' + JSON.stringify({
                        requestId, error: error.message
                    }));
                    res.set('Retry-After', '1');
                    return node.rpcError(res, request.id, -32603, 'Service unavailable', { requestId }, 503);
                }
                if (!authResult.ok)
                {
                    node.auditDenied(req, authResult);
                    return writeAuthFailure(req, res, node, authResult);
                }
                if (request.id === undefined) return res.status(202).end();
                switch (request.method)
                {
                    case 'server/discover': return node.handleDiscover(request, res);
                    case 'tools/list': return node.handleToolsList(request, res, authResult.claims);
                    case 'tools/call': handledToolCall = true; await node.handleToolCall(request, res, authResult.claims, req); break;
                    default:
                        node.rpcError(res, request.id, -32601, 'Method not found: ' + request.method, undefined, 404);
                }
            } catch (error)
            {
                const requestId = uuidv4();
                node.error('MCP request failed ' + JSON.stringify({ requestId, error: error.message }));
                node.rpcError(res, request.id, -32603, 'Internal error', { requestId }, 500);
            } finally
            {
                if (toolRequest && !handledToolCall)
                {
                    node.publishToolTelemetry({
                        tool: 'unknown', mode: 'unknown', status: 'failed', user: 'unknown', client: 'unknown',
                        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
                        responseBytes: responseBytes(res), scannedNodes: null, cached: null
                    });
                }
            }
        };

        node.rpcError = function (res, id, code, message, data, httpStatus)
        {
            const body = { jsonrpc: '2.0', id: id === undefined ? null : id,
                error: { code, message, ...(data ? { data } : {}) } };
            if (httpStatus) res.status(httpStatus).json(body);
            else res.json(body);
        };

        node.registeredTools = function ()
        {
            return node.runtime ? node.runtime.publishedTools(node.serverPath) : [];
        };

        node.toolDescriptor = function (tool)
        {
            return withSecurityMeta({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
                ...(tool.annotations ? { annotations: tool.annotations } : {})
            }, oauthScopes(node.authConfig), tool._meta);
        };

        node.handleToolsList = function (request, res, claims = {})
        {
            const tools = node.registeredTools()
                .map(tool => node.toolDescriptor(tool));

            if (node.adminToolsEnabled)
            {
                node.adminTools.TOOLS.forEach(tool =>
                {
                    let descriptor = tool;
                    if (tool.name === 'get_flow' && !node.canIncludeFunctionCode(claims))
                    {
                        descriptor = { ...tool, inputSchema: { ...tool.inputSchema,
                            properties: { ...tool.inputSchema.properties } } };
                        delete descriptor.inputSchema.properties.includeCode;
                    }
                    tools.push(withSecurityMeta(descriptor, oauthScopes(node.authConfig)));
                });
            }

            tools.sort((a, b) => a.name.localeCompare(b.name));
            node.result(res, request.id, { tools, ttlMs: LIST_TTL_MS, cacheScope: 'private' });
        };

        // A missing token is the normal start of sign-in; only rejected credentials are audit events.
        node.auditDenied = function (req, result)
        {
            if (result.error === 'missing_token') return;
            const claims = result.claims || {};
            auditLog(node, 'mcp.auth', { outcome: 'denied', reason: result.error, subject: claims.subject,
                client: claims.client, session: claims.session, endpoint: node.serverName,
                ip: clientIp(req, node.runtime && node.runtime.trustedProxies) });
        };

        node.handleToolCall = async function (request, res, claims = {}, req)
        {
            const params = request.params || {};
            const name = params.name;
            const args = params.arguments || {};
            const adminTool = node.adminToolsEnabled && node.adminTools.TOOL_NAMES.has(name);
            const started = process.hrtime.bigint();
            let adminResult;
            let status = 'failed';
            let toolName = adminTool ? name : 'unknown';
            if (node.activeToolCalls >= node.maxConcurrentCalls)
            {
                auditLog(node, 'mcp.tool_call', { outcome: 'rejected', reason: 'too_many_calls', tool: name,
                    endpoint: node.serverName, subject: claims.subject, client: claims.client, session: claims.session }, 'warn');
                return node.rpcError(res, request.id, -32000, 'Too many concurrent tool calls');
            }
            node.activeToolCalls++;
            const cancel = new AbortController();
            try
            {
                if (adminTool)
                {
                    adminResult = await node.adminTools.callTool(name, args, claims);
                    const result = normalizeToolResult(adminResult);
                    node.result(res, request.id, result);
                    status = result.isError ? 'failed' : 'success';
                    return;
                }
                const tool = node.registeredTools().find(candidate => candidate.name === name);
                if (!tool) return node.rpcError(res, request.id, -32602, 'Tool not found: ' + name);
                if (typeof tool.validateArguments === 'function') tool.validateArguments(args);
                toolName = tool.name;
                const onClose = () => { if (!res.writableEnded) cancel.abort(); };
                if (req) req.on('close', onClose);
                let result;
                try
                {
                    result = await node.executeToolFlow(tool, args, claims, cancel.signal);
                } finally
                {
                    if (req) req.removeListener('close', onClose);
                }
                if (cancel.signal.aborted) return;
                const normalized = normalizeToolResult(result);
                node.result(res, request.id, normalized);
                status = normalized.isError ? 'failed' : 'success';
            } catch (error)
            {
                if (cancel.signal.aborted) status = 'failed';
                else if (error.rpcCode) node.rpcError(res, request.id, error.rpcCode, error.message);
                else
                {
                    node.result(res, request.id, textResult(error.message, true));
                    status = 'failed';
                }
            }
            finally
            {
                node.activeToolCalls--;
                const meta = adminResult && adminResult.structuredContent && adminResult.structuredContent.meta;
                auditLog(node, 'mcp.tool_call', { outcome: status, tool: toolName, endpoint: node.serverName,
                    subject: claims.subject, client: claims.client, session: claims.session,
                    durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6) });
                node.publishToolTelemetry({
                    tool: toolName,
                    user: claims.email || claims.subject || 'unknown',
                    client: clientLabel(claims.client),
                    mode: adminTool && adminResult && adminResult.structuredContent ? adminResult.structuredContent.mode : (adminTool ? 'unknown' : 'flow'),
                    status,
                    durationMs: Number(process.hrtime.bigint() - started) / 1e6,
                    responseBytes: responseBytes(res),
                    scannedNodes: meta && Number.isSafeInteger(meta.scannedNodes) ? meta.scannedNodes : null,
                    cached: meta && typeof meta.cached === 'boolean' ? meta.cached : null
                });
            }
        };

        node.handleDiscover = function (request, res)
        {
            node.result(res, request.id, { supportedVersions: SUPPORTED_PROTOCOL_VERSIONS, capabilities: { tools: {} },
                ttlMs: LIST_TTL_MS, cacheScope: 'private' });
        };

        node.executeToolFlow = function (tool, args, claims = {}, signal)
        {
            return new Promise((resolve, reject) =>
            {
                const executionId = uuidv4();
                const executionMsg = { topic: 'mcp-tool-execute', payload: { toolName: tool.name, arguments: args, executionId },
                    mcp: { subject: claims.subject || '', email: claims.email || '', groups: claims.groups || [], client: claims.client || '' } };
                const timeout = setTimeout(() =>
                {
                    pendingExecutions.delete(executionId);
                    reject(new Error('Tool execution timeout'));
                }, Math.min(tool.timeoutMs || node.toolTimeoutMs, node.toolTimeoutMs));
                pendingExecutions.set(executionId, {
                    resolve,
                    reject,
                    timeout,
                    endpointId: node.endpointId
                });
                if (signal) signal.addEventListener('abort', () =>
                {
                    if (!pendingExecutions.has(executionId)) return;
                    clearTimeout(timeout);
                    pendingExecutions.delete(executionId);
                    reject(new Error('Tool execution cancelled'));
                }, { once: true });
                try
                {
                    node.send(executionMsg);
                } catch (error)
                {
                    clearTimeout(timeout);
                    pendingExecutions.delete(executionId);
                    reject(error);
                }
            });
        };

        let closed = false;
        node.startServer = function (callback = () => { })
        {
            if (closed) return callback(null, { success: false, message: 'Server closed' });
            if (node.isRunning)
            {
                callback(null, { success: false, message: 'Server already running' });
                return;
            }
            node.status({ fill: 'yellow', shape: 'ring', text: statusText(node, 'starting') });
            try
            {
                node.initializeServer();
                const portState = node.portState;
                const markRunning = () =>
                {
                    portState.httpServer.removeListener('error', startError);
                    if (closed) return;
                    node.isRunning = true;
                    node.status({ fill: 'green', shape: 'dot', text: statusText(node, 'running', { port: node.serverPort }) });
                    serverInstances.set(node.serverId, {
                        nodeId: String(node.id),
                        runtimeId: String(node.runtimeId || ''),
                        endpointId: String(node.endpointId || ''),
                        serverName: String(node.serverName),
                        path: String(node.serverPath),
                        port: Number(node.serverPort),
                        startTime: new Date().toISOString(),
                        isRunning: true
                    });
                    node.log('MCP Flow Server started on port ' + node.serverPort + ' path ' + node.serverPath);
                    callback(null, { success: true, message: 'Server started' });
                };
                const startError = error =>
                {
                    portState.httpServer.removeListener('listening', startListening);
                    if (closed) return;
                    node.error('Server error: ' + error.message);
                    node.status({ fill: 'red', shape: 'dot', text: statusText(node, 'error') });
                    callback(error);
                };
                const startListening = () =>
                {
                    portState.isListening = true;
                    markRunning();
                };

                if (portState.isListening)
                {
                    markRunning();
                    return;
                }

                portState.httpServer.once('error', startError);
                portState.httpServer.once('listening', startListening);
                if (!portState.httpServer.listening && !portState.listenRequested)
                {
                    portState.listenRequested = true;
                    if (portState.bindHost) portState.httpServer.listen(portState.port, portState.bindHost);
                    else portState.httpServer.listen(portState.port);
                }
            } catch (error)
            {
                node.error('Failed to start server: ' + error.message);
                node.status({ fill: 'red', shape: 'dot', text: statusText(node, 'error') });
                callback(error);
            }
        };

        node.stopServer = function (callback = () => { })
        {
            if (!node.isRunning && !node.portState)
            {
                callback(null, { success: true, message: 'Server already stopped' });
                return;
            }
            if (!closed) node.status({ fill: 'yellow', shape: 'ring', text: statusText(node, 'stopping') });

            const portState = node.portState;
            node.portState = null;

            const finish = () =>
            {
                node.isRunning = false;
                serverInstances.delete(node.serverId);
                if (!closed) node.status({ fill: 'grey', shape: 'ring', text: statusText(node, 'stopped') });
                callback(null, { success: true, message: 'Server stopped' });
            };

            if (portState && node.runtime) node.runtime.releaseListener(node, finish);
            else finish();
        };

        let restartTimer = null;
        let pendingRestartDone = null;
        // The output carries only tool calls; commands produce no messages.
        node.on('input', function (msg, send, done)
        {
            const finished = error => done(error || undefined);

            if (msg.topic === 'mcp-tool-response' && msg.payload && msg.payload.executionId)
            {
                const pending = pendingExecutions.get(msg.payload.executionId);
                if (!pending)
                {
                    node.debug('Ignoring late or cancelled MCP tool response for executionId: ' + msg.payload.executionId);
                    return done();
                }
                clearTimeout(pending.timeout);
                pendingExecutions.delete(msg.payload.executionId);
                if (msg.payload.error) pending.reject(new Error(errorText(msg.payload.error)));
                else pending.resolve(msg.payload.result);
                return done();
            }

            const command = msg.topic || (msg.payload && msg.payload.command);
            if (['start', 'stop', 'restart'].includes(command)) auditLog(node, 'mcp.command', { command, endpoint: node.serverName });
            switch (command)
            {
                case 'start': return node.startServer(finished);
                case 'stop': return node.stopServer(finished);
                case 'restart':
                    return node.stopServer(error =>
                    {
                        if (error) return done(error);
                        clearTimeout(restartTimer);
                        pendingRestartDone = finished;
                        restartTimer = setTimeout(() =>
                        {
                            restartTimer = null;
                            pendingRestartDone = null;
                            node.startServer(finished);
                        }, 1000);
                    });
                default:
                    return done();
            }
        });

        if (node.runtime && typeof node.runtime.addEndpoint === 'function') node.runtime.addEndpoint(node);

        const startOnDeploy = () => node.startServer();
        RED.events.on('flows:started', startOnDeploy);

        node.on('close', function (done)
        {
            closed = true;
            clearTimeout(restartTimer);
            restartTimer = null;
            if (pendingRestartDone)
            {
                const restartDone = pendingRestartDone;
                pendingRestartDone = null;
                restartDone();
            }
            RED.events.removeListener('flows:started', startOnDeploy);
            if (node.runtime && typeof node.runtime.removeEndpoint === 'function') node.runtime.removeEndpoint(node);
            node.adminTools.dispose();
            for (const [executionId, pending] of pendingExecutions.entries())
            {
                if (pending.endpointId !== node.endpointId) continue;
                clearTimeout(pending.timeout);
                pendingExecutions.delete(executionId);
                pending.reject(new Error('MCP server stopped before tool execution completed'));
            }
            if (node.portState) node.stopServer(() => done());
            else done();
        });
    }

    RED.nodes.registerType('mcp-runtime', MCPRuntimeNode, {
        credentials: {
            adminToken: { type: 'password' }
        }
    });
    RED.nodes.registerType('mcp-flow-server', MCPFlowServerNode);

    const readPermission = RED.auth && typeof RED.auth.needsPermission === 'function' ?
        [RED.auth.needsPermission('mcp-flow-server.read')] : [];
    RED.httpAdmin.get('/mcp-flow-servers', ...readPermission, function (req, res)
    {
        const servers = [];
        for (const key of serverInstances.keys())
        {
            const server = serverInstances.get(key);
            if (server)
            {
                const runtime = configNode(RED, server.runtimeId);
                const toolCount = runtime && typeof runtime.publishedTools === 'function' ?
                    runtime.publishedTools(server.path).length : 0;
                servers.push({ serverId: key, runtimeId: server.runtimeId, endpointId: server.endpointId, serverName: server.serverName, path: server.path, isRunning: server.isRunning, port: server.port, startTime: server.startTime, toolCount });
            }
        }
        res.json({ servers });
    });
};
