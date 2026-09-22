module.exports = function (RED)
{
    "use strict";

    const http = require('http');
    const express = require('express');
    const { randomUUID: uuidv4 } = require('crypto');
    const NodeCache = require('node-cache');
    const { createAdminTools } = require('./lib/admin-tools');
    const {
        absoluteUrl,
        authorizeMetadata,
        beginAuthorization,
        completeAuthorization,
        exchangeClientCode,
        isAuthRequired,
        policyAllowsTool,
        protectedResourceMetadata,
        validateRequest,
        writeAuthFailure
    } = require('./lib/mcp-auth');


    const toolRegistry = new NodeCache({ stdTTL: 0 });
    const serverInstances = new NodeCache({ stdTTL: 0 });
    const portServers = new Map();
    const pendingExecutions = new Map();

    function parseList(value)
    {
        if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
        if (typeof value !== 'string') return [];
        return value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    }

    function parseCommaList(value)
    {
        if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
        if (typeof value !== 'string') return [];
        return value.split(',').map(s => s.trim()).filter(Boolean);
    }

    function uniqueList(values)
    {
        return Array.from(new Set(values.filter(Boolean)));
    }

    function securitySchemes(scopes)
    {
        const normalized = Array.isArray(scopes) ? scopes : [];
        return normalized.length ? [{ type: 'oauth2', scopes: normalized }] : [];
    }

    function withSecurityMeta(tool, scopes, extraMeta = {})
    {
        const schemes = securitySchemes(scopes);
        const meta = Object.assign({}, tool._meta || {}, extraMeta || {});
        if (schemes.length) meta.securitySchemes = schemes;
        return Object.assign({}, tool, Object.keys(meta).length ? { _meta: meta } : {});
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
        return process.env.NODE_RED_ADMIN_API_TOKEN || (runtime && runtime.adminToken) || '';
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

    function toolBelongsToEndpoint(tool, node)
    {
        if (!tool) return false;
        if (tool.endpointId) return tool.endpointId === node.endpointId;
        return true;
    }

    function registryKey(toolName, endpointId)
    {
        return (endpointId || '*') + ':' + toolName;
    }

    function getPortServer(port)
    {
        const key = Number(port);
        if (portServers.has(key)) return portServers.get(key);

        const state = {
            port: key,
            app: express(),
            httpServer: null,
            routes: new Map(),
            nodes: new Set(),
            runtimeId: '',
            isListening: false,
            enableCors: false
        };

        state.app.use((req, res, next) =>
        {
            if (state.enableCors)
            {
                res.header('Access-Control-Allow-Origin', '*');
                res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            }
            if (req.method === 'OPTIONS') res.sendStatus(200);
            else next();
        });

        state.app.use(express.json({ limit: '10mb' }));
        state.app.use(express.urlencoded({ extended: false, limit: '1mb' }));

        state.app.get('/health', (req, res) =>
        {
            const servers = Array.from(state.nodes).map(node => ({
                server: node.serverName,
                path: node.serverPath,
                running: node.isRunning,
                tools: node.registeredTools().length
            }));
            res.json({ status: 'healthy', port: state.port, servers });
        });

        state.app.get(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/, (req, res) =>
        {
            const requestedPath = req.params && req.params[0] ? req.params[0] : req.query.resource || '';
            const serverPath = requestedPath ? normalizePath(requestedPath) : '';
            const node = serverPath ? state.routes.get(serverPath) : (() =>
            {
                const protectedNodes = Array.from(state.routes.values()).filter(candidate => isAuthRequired(candidate));
                return protectedNodes.length === 1 ? protectedNodes[0] : null;
            })();
            if (!node || !isAuthRequired(node)) return res.status(404).json({ error: 'MCP protected resource not found' });
            res.json(protectedResourceMetadata(req, node));
        });

        state.app.get(/^\/\.well-known\/oauth-authorization-server(\/.*)?$/, (req, res) =>
        {
            let authId = req.params && req.params[0] ? decodeURIComponent(String(req.params[0]).replace(/^\//, '')) : '';
            if (authId.startsWith('oauth/')) authId = authId.slice('oauth/'.length);
            const node = Array.from(state.routes.values()).find(candidate =>
                isAuthRequired(candidate) && candidate.authConfig && (!authId || candidate.authConfig.id === authId));
            if (!node) return res.status(404).json({ error: 'MCP authorization server not found' });
            res.json(authorizeMetadata(req, node));
        });

        state.app.get(/^\/oauth\/([^/]+)\/authorize$/, async (req, res) =>
        {
            const authId = decodeURIComponent(req.params[0]);
            const resource = req.query && req.query.resource;
            const node = Array.from(state.routes.values()).find(candidate =>
                isAuthRequired(candidate) && candidate.authConfig && candidate.authConfig.id === authId &&
                (!resource || resource === absoluteUrl(req, candidate.publicBaseUrl, candidate.serverPath)));
            if (!node) return res.status(404).json({ error: 'MCP authorization endpoint not found' });
            try
            {
                await beginAuthorization(req, res, node);
            } catch (error)
            {
                res.status(400).json({ error: 'invalid_request', error_description: error.message });
            }
        });

        state.app.get(/^\/oauth\/([^/]+)\/callback$/, async (req, res) =>
        {
            const authId = decodeURIComponent(req.params[0]);
            const stateRecord = req.query && req.query.state ? await Array.from(state.routes.values())
                .find(candidate => isAuthRequired(candidate) && candidate.authConfig && candidate.authConfig.id === authId)
                ?.authConfig.readState(req.query.state) : null;
            const node = stateRecord ? Array.from(state.routes.values()).find(candidate => candidate.endpointId === stateRecord.endpointId) : null;
            if (!node) return res.status(400).json({ error: 'invalid_state' });
            try
            {
                await completeAuthorization(req, res, node);
            } catch (error)
            {
                res.status(400).json({ error: 'invalid_request', error_description: error.message });
            }
        });

        state.app.post(/^\/oauth\/([^/]+)\/token$/, async (req, res) =>
        {
            const authId = decodeURIComponent(req.params[0]);
            const code = req.body && req.body.code;
            const node = code ? await (async () =>
            {
                for (const candidate of state.routes.values())
                {
                    if (!isAuthRequired(candidate) || !candidate.authConfig || candidate.authConfig.id !== authId) continue;
                    const record = await candidate.authConfig.readCode(code);
                    if (record && record.endpointId) return Array.from(state.routes.values()).find(item => item.endpointId === record.endpointId) || candidate;
                    if (record) return candidate;
                }
                return null;
            })() : null;
            if (!node) return res.status(400).json({ error: 'invalid_grant' });
            try
            {
                await exchangeClientCode(req, res, node);
            } catch (error)
            {
                res.status(400).json({ error: 'invalid_request', error_description: error.message });
            }
        });

        state.app.post(/.*/, async (req, res) =>
        {
            const node = state.routes.get(req.path);
            if (!node) return res.status(404).json({ error: 'MCP path not found' });
            await node.handleMcpHttpRequest(req, res);
        });

        state.app.get(/.*/, async (req, res) =>
        {
            const directNode = state.routes.get(req.path);
            if (directNode)
            {
                const authResult = await validateRequest(directNode, req);
                if (!authResult.ok) return writeAuthFailure(req, res, directNode, authResult);
                return res.status(405).json({ error: 'method_not_allowed', error_description: 'Use JSON-RPC POST for MCP requests' });
            }
            const suffix = '/sse';
            if (!req.path.endsWith(suffix)) return res.status(404).json({ error: 'MCP path not found' });
            const serverPath = req.path.slice(0, -suffix.length) || '/';
            const node = state.routes.get(serverPath);
            if (!node) return res.status(404).json({ error: 'MCP path not found' });
            node.handleSseRequest(req, res);
        });

        state.httpServer = http.createServer(state.app);
        portServers.set(key, state);
        return state;
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
        if (isMcpResult(result)) return result;
        if (Array.isArray(result)) return { content: result };
        if (typeof result === 'string') return textResult(result);
        return textResult(JSON.stringify(result));
    }

    function MCPRuntimeNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;
        node.name = config.name || '';
        node.runtimeName = config.runtimeName || node.name || 'mcp-runtime';
        node.serverPort = Number(config.serverPort || 8001);
        node.publicBaseUrl = config.publicBaseUrl || '';
        node.autoStart = config.autoStart || false;
        node.enableCors = config.enableCors !== false;
        node.adminPort = Number(config.adminPort || 1880);
        node.adminToken = (node.credentials && node.credentials.adminToken) || '';
        node.adminEndpointPath = config.adminEndpointPath ? normalizePath(config.adminEndpointPath) : '';
    }

    function MCPFlowServerNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;
        const runtime = runtimeFromConfig(RED, config);

        node.runtimeId = config.runtime || '';
        node.runtime = runtime;
        node.authConfigId = config.auth || '';
        node.authConfig = configNode(RED, config.auth);
        node.endpointId = node.id;
        node.serverName = config.serverName || config.name || 'node-red-mcp-server';
        node.serverPath = normalizePath(config.serverPath);
        node.serverPort = runtime ? runtime.serverPort : 0;
        node.publicBaseUrl = runtime ? runtime.publicBaseUrl : '';
        node.autoStart = runtime ? runtime.autoStart : false;
        node.enableCors = runtime ? runtime.enableCors : false;
        node.advertisedScopes = parseList(config.advertisedScopes || '');
        node.authMode = config.authMode || 'inherit';
        node.allowedGroups = parseCommaList(config.allowedGroups || '');
        node.endpointRequiredScopes = parseList(config.requiredScopes || '');
        node.adminToolsEnabled = hasAdminTools(runtime, node.serverPath);
        node.adminPort = runtime ? runtime.adminPort : 0;
        node.adminToken = runtimeAdminToken(runtime);
        node.adminTools = createAdminTools({ adminPort: node.adminPort, getAdminToken: () => node.adminToken });

        node.httpServer = null;
        node.app = null;
        node.isRunning = false;
        node.serverId = uuidv4();

        node.status({ fill: "grey", shape: "ring", text: "stopped" });

        node.initializeServer = function ()
        {
            if (!node.runtime)
            {
                throw new Error('MCP runtime is required');
            }
            const portState = getPortServer(node.serverPort);
            if (portState.runtimeId && portState.runtimeId !== node.runtimeId)
            {
                throw new Error('MCP runtime port already registered by another runtime: ' + node.serverPort);
            }
            const existingRoute = portState.routes.get(node.serverPath);
            if (existingRoute && existingRoute !== node) throw new Error('MCP server path already registered on this port: ' + node.serverPath);
            portState.runtimeId = node.runtimeId;
            portState.enableCors = portState.enableCors || node.enableCors;
            portState.routes.set(node.serverPath, node);
            portState.nodes.add(node);
            node.portState = portState;
            node.app = portState.app;
            node.httpServer = portState.httpServer;
        };

        node.handleMcpHttpRequest = async function (req, res)
        {
            const request = req.body || {};
            try
            {
                const authResult = await validateRequest(node, req);
                if (!authResult.ok) return writeAuthFailure(req, res, node, authResult);
                req.mcpAuth = authResult.claims;
                switch (request.method)
                {
                    case 'tools/list': node.handleToolsList(request, res, req.mcpAuth); break;
                    case 'tools/call': await node.handleToolCall(request, req, res); break;
                    case 'initialize': node.handleInitialize(request, res); break;
                    default:
                        if (request.method && request.method.endsWith('_tool')) await node.handleDirectToolCall(request, res);
                        else node.rpcError(res, request.id, -32601, 'Method not found: ' + request.method);
                }
            } catch (error)
            {
                node.error('MCP request error: ' + error.message);
                node.rpcError(res, request.id, -32603, 'Internal error', error.message, 500);
            }
        };

        node.handleSseRequest = function (req, res)
        {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });
            res.write('data: {"type":"connected","server":"' + node.serverName + '"}\n\n');
            const keepAlive = setInterval(() =>
            {
                res.write('data: {"type":"heartbeat","timestamp":"' + new Date().toISOString() + '"}\n\n');
            }, 30000);
            req.on('close', () => clearInterval(keepAlive));
        };

        node.rpcError = function (res, id, code, message, data, httpStatus)
        {
            const body = { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
            if (httpStatus) res.status(httpStatus).json(body);
            else res.json(body);
        };

        node.registeredTools = function ()
        {
            const tools = toolRegistry.keys()
                .map(key => toolRegistry.get(key))
                .filter(tool => toolBelongsToEndpoint(tool, node));
            const byName = new Map();
            tools.filter(tool => !tool.endpointId).forEach(tool => byName.set(tool.name, tool));
            tools.filter(tool => tool.endpointId).forEach(tool => byName.set(tool.name, tool));
            return Array.from(byName.values());
        };

        node.toolScopes = function (tool)
        {
            return uniqueList([].concat(node.advertisedScopes, node.endpointRequiredScopes, tool.requiredScopes || []));
        };

        node.toolDescriptor = function (tool)
        {
            return withSecurityMeta({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }, node.toolScopes(tool), tool._meta);
        };

        node.handleToolsList = function (request, res, authClaims)
        {
            const tools = node.registeredTools()
                .filter(tool => !authClaims || policyAllowsTool(node, tool, authClaims))
                .map(tool => node.toolDescriptor(tool));

            if (node.adminToolsEnabled)
            {
                node.adminTools.TOOLS.forEach(tool => tools.push(withSecurityMeta(tool, node.advertisedScopes)));
            }

            res.json({ jsonrpc: '2.0', id: request.id, result: { tools } });
        };

        node.handleToolCall = async function (request, req, res)
        {
            if (!res)
            {
                res = req;
                req = {};
            }
            const params = request.params || {};
            const name = params.name;
            const args = params.arguments || {};
            try
            {
                if (node.adminToolsEnabled && node.adminTools.TOOL_NAMES.has(name))
                {
                    const adminResult = await node.adminTools.callTool(name, args);
                    return res.json({ jsonrpc: '2.0', id: request.id, result: textResult(adminResult) });
                }
                const tool = node.registeredTools().find(candidate => candidate.name === name);
                if (!tool) return node.rpcError(res, request.id, -32602, 'Tool not found: ' + name);
                if (req && req.mcpAuth && !policyAllowsTool(node, tool, req.mcpAuth))
                {
                    return node.rpcError(res, request.id, -32001, 'Forbidden', 'Insufficient tool scope', 403);
                }
                const result = await node.executeToolFlow(tool, args);
                res.json({ jsonrpc: '2.0', id: request.id, result: normalizeToolResult(result) });
            } catch (error)
            {
                node.rpcError(res, request.id, error.rpcCode || -32603, error.message);
            }
        };

        node.handleDirectToolCall = async function (request, res)
        {
            const toolName = request.method;
            const tool = node.registeredTools().find(candidate => candidate.name === toolName);
            if (!tool) return node.rpcError(res, request.id, -32602, 'Tool not found: ' + toolName);
            try
            {
                const result = await node.executeToolFlow(tool, request.params || {});
                res.json({ jsonrpc: '2.0', id: request.id, result: normalizeToolResult(result) });
            } catch (error)
            {
                node.rpcError(res, request.id, -32603, error.message);
            }
        };

        node.handleInitialize = function (request, res)
        {
            const capabilities = { tools: { listChanged: true } };
            res.json({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities,
                    serverInfo: { name: node.serverName, version: '1.0.0', description: 'Node-RED MCP Flow Server' }
                }
            });
        };

        node.executeToolFlow = function (tool, args)
        {
            return new Promise((resolve, reject) =>
            {
                const executionId = uuidv4();
                const executionMsg = { topic: 'mcp-tool-execute', payload: { toolName: tool.name, arguments: args, executionId } };
                const timeout = setTimeout(() =>
                {
                    pendingExecutions.delete(executionId);
                    reject(new Error('Tool execution timeout'));
                }, 30000);
                pendingExecutions.set(executionId, {
                    resolve,
                    reject,
                    timeout,
                    endpointId: node.endpointId
                });
                node.send(executionMsg);
            });
        };

        node.startServer = function (callback = () => { })
        {
            if (node.isRunning)
            {
                callback(null, { success: false, message: 'Server already running' });
                return;
            }
            node.status({ fill: 'yellow', shape: 'ring', text: 'starting...' });
            try
            {
                node.initializeServer();
                const portState = node.portState;
                const markRunning = () =>
                {
                    node.isRunning = true;
                    node.status({ fill: 'green', shape: 'dot', text: 'running :' + node.serverPort + node.serverPath });
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
                    node.send({ topic: 'mcp-server-started', payload: { serverId: node.serverId, endpointId: node.endpointId, serverName: node.serverName, path: node.serverPath, port: node.serverPort, startTime: new Date() } });
                    callback(null, { success: true, message: 'Server started' });
                };

                if (portState.isListening)
                {
                    markRunning();
                    return;
                }

                portState.httpServer.listen(portState.port, () =>
                {
                    portState.isListening = true;
                    markRunning();
                });
                portState.httpServer.on('error', (error) =>
                {
                    node.error('Server error: ' + error.message);
                    node.status({ fill: 'red', shape: 'dot', text: 'error' });
                    callback(error);
                });
            } catch (error)
            {
                node.error('Failed to start server: ' + error.message);
                node.status({ fill: 'red', shape: 'dot', text: 'error' });
                callback(error);
            }
        };

        node.stopServer = function (callback = () => { })
        {
            if (!node.isRunning)
            {
                callback(null, { success: true, message: 'Server already stopped' });
                return;
            }
            node.status({ fill: 'yellow', shape: 'ring', text: 'stopping...' });

            const portState = node.portState;
            if (portState)
            {
                portState.routes.delete(node.serverPath);
                portState.nodes.delete(node);
            }

            const finish = () =>
            {
                node.isRunning = false;
                node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
                serverInstances.del(node.serverId);
                node.send({ topic: 'mcp-server-stopped', payload: { serverId: node.serverId } });
                callback(null, { success: true, message: 'Server stopped' });
            };

            if (portState && portState.nodes.size === 0 && portState.httpServer)
            {
                portState.httpServer.close(() =>
                {
                    portState.isListening = false;
                    portServers.delete(portState.port);
                    finish();
                });
            } else
            {
                finish();
            }
        };

        node.on('input', function (msg)
        {
            if (msg.topic === 'mcp-tool-response' && msg.payload && msg.payload.executionId)
            {
                const pending = pendingExecutions.get(msg.payload.executionId);
                if (!pending)
                {
                    node.warn('Orphan MCP tool response for executionId: ' + msg.payload.executionId);
                    return;
                }
                clearTimeout(pending.timeout);
                pendingExecutions.delete(msg.payload.executionId);
                if (msg.payload.error) pending.reject(new Error(msg.payload.error));
                else pending.resolve(msg.payload.result);
                return;
            }

            const command = msg.topic || (msg.payload && msg.payload.command);
            switch (command)
            {
                case 'start': node.startServer(); break;
                case 'stop': node.stopServer(); break;
                case 'restart': node.stopServer(() => setTimeout(() => node.startServer(), 1000)); break;
                case 'status':
                    msg.payload = { serverId: node.serverId, runtimeId: node.runtimeId, endpointId: node.endpointId, serverName: node.serverName, path: node.serverPath, isRunning: node.isRunning, port: node.serverPort, toolCount: node.registeredTools().length, authRequired: isAuthRequired(node) };
                    node.send(msg);
                    break;
            }
        });

        if (node.autoStart) setTimeout(() => node.startServer(), 1000);

        node.on('close', function (done)
        {
            for (const [executionId, pending] of pendingExecutions.entries())
            {
                if (pending.endpointId !== node.endpointId) continue;
                clearTimeout(pending.timeout);
                pendingExecutions.delete(executionId);
                pending.reject(new Error('MCP server stopped before tool execution completed'));
            }
            if (node.isRunning) node.stopServer(() => done());
            else done();
        });
    }

    RED.nodes.registerType('mcp-runtime', MCPRuntimeNode);
    RED.nodes.registerType('mcp-flow-server', MCPFlowServerNode);

    RED.events.on('mcp-tool-register', (toolDef) =>
    {
        if (!toolDef || !toolDef.name) return;
        toolRegistry.set(registryKey(toolDef.name, toolDef.endpointId), toolDef);
    });
    RED.events.on('mcp-tool-unregister', (toolDef) =>
    {
        if (typeof toolDef === 'string')
        {
            toolRegistry.del(registryKey(toolDef, ''));
            return;
        }
        if (!toolDef || !toolDef.name) return;
        toolRegistry.del(registryKey(toolDef.name, toolDef.endpointId));
    });

    RED.httpAdmin.get('/mcp-flow-servers', function (req, res)
    {
        const servers = [];
        serverInstances.keys().forEach(key =>
        {
            const server = serverInstances.get(key);
            if (server)
            {
                const toolCount = toolRegistry.keys()
                    .map(toolKey => toolRegistry.get(toolKey))
                    .filter(tool => toolBelongsToEndpoint(tool, server)).length;
                servers.push({ serverId: key, runtimeId: server.runtimeId, endpointId: server.endpointId, serverName: server.serverName, path: server.path, isRunning: server.isRunning, port: server.port, startTime: server.startTime, toolCount });
            }
        });
        res.json({ servers });
    });
};
