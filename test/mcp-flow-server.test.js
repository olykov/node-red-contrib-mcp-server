'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

function createRuntime(config = {}) {
    const types = {};
    const events = new EventEmitter();
    const nodeMap = config.__nodes || {};
    const flowNodes = config.__flowNodes || [];
    const RED = {
        events,
        log: { debug() {} },
        nodes: {
            createNode(node, nodeConfig) {
                Object.setPrototypeOf(node, EventEmitter.prototype);
                EventEmitter.call(node);
                node.id = nodeConfig && nodeConfig.id;
                node.sent = [];
                node.statuses = [];
                node.logs = [];
                node.errors = [];
                node.warnings = [];
                node.credentials = (nodeConfig && nodeConfig.credentials) || {};
                node.send = msg => node.sent.push(msg);
                node.status = s => node.statuses.push(s);
                node.log = s => node.logs.push(s);
                node.error = e => node.errors.push(e);
                node.warn = w => node.warnings.push(w);
            },
            registerType(name, ctor) { types[name] = ctor; },
            getNode(id) { return nodeMap[id]; },
            eachNode(callback) { for (const node of flowNodes) callback(node); }
        },
        httpAdmin: { get() {} }
    };
    delete require.cache[require.resolve('../mcp-flow-server')];
    require('../mcp-flow-server')(RED);
    require('../mcp-server-metrics')(RED);
    const runtimeConfig = Object.assign({
        id: 'runtime-1',
        runtimeName: 'test-runtime',
        serverPort: 18001,
        autoStart: false,
        enableCors: true
    }, config.__runtime || {});
    const runtimeNode = new types['mcp-runtime'](runtimeConfig);
    nodeMap[runtimeConfig.id] = runtimeNode;
    const nodeConfig = Object.assign({
        id: 'endpoint-1',
        runtime: runtimeConfig.id,
        serverName: 'test',
        serverPath: '/mcp/test',
    }, config);
    const server = new types['mcp-flow-server'](nodeConfig);
    return { RED, types, server, nodeMap, runtimeNode };
}

function buildServer(config = {}) {
    return createRuntime(config);
}

function mockRes() {
    return {
        statusCode: 200,
        body: undefined,
        headers: {},
        set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
        getHeader(name) { return this.headers[name.toLowerCase()]; },
        status(code) { this.statusCode = code; return this; },
        json(body) {
            this.body = body;
            this.headers['content-length'] = String(Buffer.byteLength(JSON.stringify(body)));
            return this;
        }
    };
}

function mockReq(body, headers = {}) {
    return {
        body,
        headers: Object.assign({ host: 'mcp.example.test' }, headers),
        path: '/mcp/test'
    };
}

describe('upstream mcp-flow-server local extensions', () => {
    it('keeps upstream registry tools and advertises _meta.securitySchemes', () => {
        const { RED, server } = buildServer({ advertisedScopes: 'openid profile email' });
        RED.events.emit('mcp-tool-register', {
            name: 'sample_ping',
            description: 'Sample ping',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
        });
        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        const tool = res.body.result.tools.find(t => t.name === 'sample_ping');
        assert.deepStrictEqual(tool._meta.securitySchemes, [{ type: 'oauth2', scopes: ['openid', 'profile', 'email'] }]);
    });



    it('advertises registered tool output schemas', () => {
        const { RED, server } = buildServer();
        RED.events.emit('mcp-tool-register', {
            name: 'sample_summary',
            description: 'Sample summary',
            inputSchema: { type: 'object', properties: { date: { type: 'string' } } },
            outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
        });

        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        const tool = res.body.result.tools.find(t => t.name === 'sample_summary');
        assert.deepStrictEqual(tool.outputSchema, { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] });
    });

    it('requires an explicit runtime config node before starting', () => {
        const runtime = createRuntime({ runtime: '' });

        assert.strictEqual(runtime.server.runtime, null);
        assert.strictEqual(runtime.server.serverPort, 0);
        assert.throws(() => runtime.server.initializeServer(), /MCP runtime is required/);
    });

    it('uses endpoint fields with runtime transport config', () => {
        const { RED, server, runtimeNode } = buildServer({
            serverName: 'ops',
            serverPath: '/internal/mcp/ops',
            advertisedScopes: 'openid profile',
            __runtime: { serverPort: 18002, enableCors: false }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'read_status',
            description: 'Read status',
            endpointId: 'endpoint-1',
            requiredScopes: ['status:read'],
            inputSchema: { type: 'object', properties: {} }
        });

        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        assert.strictEqual(server.serverName, 'ops');
        assert.strictEqual(server.serverPath, '/internal/mcp/ops');
        assert.strictEqual(server.serverPort, 18002);
        assert.strictEqual(server.enableCors, false);
        assert.strictEqual(runtimeNode.serverPort, 18002);
        assert.deepStrictEqual(res.body.result.tools[0]._meta.securitySchemes, [{ type: 'oauth2', scopes: ['openid', 'profile', 'status:read'] }]);
    });

    it('filters registered tools by endpoint id when a binding is configured', () => {
        const { RED, server } = buildServer({ id: 'alpha-endpoint', serverName: 'alpha' });
        RED.events.emit('mcp-tool-register', {
            name: 'shared_tool',
            description: 'Shared',
            inputSchema: { type: 'object', properties: {} }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'alpha_tool',
            description: 'Alpha',
            endpointId: 'alpha-endpoint',
            inputSchema: { type: 'object', properties: {} }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'beta_tool',
            description: 'Beta',
            endpointId: 'beta-endpoint',
            inputSchema: { type: 'object', properties: {} }
        });

        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        const names = res.body.result.tools.map(tool => tool.name).sort();
        assert.deepStrictEqual(names, ['alpha_tool', 'shared_tool']);
    });

    it('uses configured MCP server path', async () => {
        const { server } = buildServer({ serverPath: '/custom/mcp' });
        server.initializeServer();
        assert.strictEqual(server.serverPath, '/custom/mcp');
        assert.ok(server.portState.routes.has('/custom/mcp'));
    });

    it('allows multiple endpoints on one runtime port', () => {
        const runtime = createRuntime({
            id: 'endpoint-a',
            serverPath: '/mcp/a',
            __runtime: { id: 'runtime-shared', serverPort: 18005 }
        });
        const serverB = new runtime.types['mcp-flow-server']({
            id: 'endpoint-b',
            runtime: 'runtime-shared',
            serverName: 'b',
            serverPath: '/mcp/b'
        });

        runtime.server.initializeServer();
        serverB.initializeServer();

        assert.strictEqual(runtime.server.portState, serverB.portState);
        assert.ok(runtime.server.portState.routes.has('/mcp/a'));
        assert.ok(runtime.server.portState.routes.has('/mcp/b'));
    });

    it('rejects different runtimes on the same port', () => {
        const runtime = createRuntime({
            id: 'endpoint-a',
            serverPath: '/mcp/a',
            __runtime: { id: 'runtime-a', serverPort: 18006 }
        });
        const runtimeB = new runtime.types['mcp-runtime']({
            id: 'runtime-b',
            runtimeName: 'runtime-b',
            serverPort: 18006,
            autoStart: false,
            enableCors: true
        });
        runtime.nodeMap['runtime-b'] = runtimeB;
        const serverB = new runtime.types['mcp-flow-server']({
            id: 'endpoint-b',
            runtime: 'runtime-b',
            serverName: 'b',
            serverPath: '/mcp/b'
        });

        runtime.server.initializeServer();

        assert.throws(() => serverB.initializeServer(), /port already registered by another runtime/);
    });

    it('exposes admin tools only on the runtime admin endpoint path', () => {
        const adminRuntime = {
            serverPort: 18003,
            adminPort: 1881,
            adminEndpointPath: '/internal/mcp/ops',
            credentials: { adminToken: 'configured-value' }
        };
        const adminServer = buildServer({
            id: 'admin-endpoint',
            serverName: 'ops',
            serverPath: '/internal/mcp/ops',
            __runtime: adminRuntime
        }).server;
        const otherServer = buildServer({
            id: 'other-endpoint',
            serverName: 'other',
            serverPath: '/internal/mcp/other',
            __runtime: Object.assign({ id: 'runtime-2' }, adminRuntime)
        }).server;

        const adminRes = mockRes();
        adminServer.handleToolsList({ id: 1 }, adminRes);
        const otherRes = mockRes();
        otherServer.handleToolsList({ id: 2 }, otherRes);

        const getFlow = adminRes.body.result.tools.find(tool => tool.name === 'get_flow');
        assert.ok(getFlow);
        assert.strictEqual(getFlow.outputSchema.type, 'object');
        assert.deepStrictEqual(getFlow.outputSchema.required, ['mode', 'source', 'meta']);
        assert.ok(!otherRes.body.result.tools.some(tool => tool.name === 'get_flow'));
    });

    it('passes the in-process tab iterator to the admin tool and releases its listener', async () => {
        const flowNodes = [
            { id: 'tab1', type: 'tab', label: 'Operations' },
            { id: 'n1', type: 'function', z: 'tab1', func: 'private code' }
        ];
        const { RED, server } = buildServer({
            id: 'admin-endpoint',
            serverPath: '/internal/mcp/ops',
            __flowNodes: flowNodes,
            __runtime: {
                adminPort: 1881,
                adminEndpointPath: '/internal/mcp/ops',
                credentials: { adminToken: 'configured-value' }
            }
        });
        const tabs = (await server.adminTools.callTool('get_flow', {})).structuredContent;
        assert.deepStrictEqual(tabs.tabs, [
            { id: 'tab1', label: 'Operations', disabled: false, nodeCount: 1 }
        ]);
        assert.equal(RED.events.listenerCount('runtime-event'), 1);
        await new Promise(resolve => server.emit('close', resolve));
        assert.equal(RED.events.listenerCount('runtime-event'), 0);
    });

    it('emits bounded get_flow telemetry only on the second output', async () => {
        const { server } = buildServer({
            serverPath: '/internal/mcp/ops',
            __flowNodes: [
                { id: 'tab1', type: 'tab', label: 'Operations' },
                { id: 'n1', type: 'function', z: 'tab1', func: 'private code' }
            ],
            __runtime: {
                adminPort: 1881,
                adminEndpointPath: '/internal/mcp/ops',
                credentials: { adminToken: 'configured-value' }
            }
        });
        const request = { id: 1, params: { name: 'get_flow', arguments: {} } };
        const first = mockRes();
        await server.handleToolCall(request, first);
        const second = mockRes();
        await server.handleToolCall(request, second);

        assert.equal(first.body.result.structuredContent.totalTabs, 1);
        assert.equal(server.sent.length, 2);
        for (const [index, response] of [first, second].entries()) {
            const [regular, metric] = server.sent[index];
            assert.equal(regular, null);
            assert.equal(metric.topic, 'mcp-admin-telemetry');
            assert.deepStrictEqual(Object.keys(metric.payload).sort(), [
                'cached', 'durationMs', 'mode', 'responseBytes', 'scannedNodes', 'status', 'tool'
            ]);
            assert.equal(metric.payload.tool, 'get_flow');
            assert.equal(metric.payload.mode, 'tabs');
            assert.equal(metric.payload.status, 'success');
            assert.equal(metric.payload.scannedNodes, 2);
            assert.equal(metric.payload.cached, index === 1);
            assert.equal(metric.payload.responseBytes, Buffer.byteLength(JSON.stringify(response.body)));
            assert.ok(metric.payload.durationMs >= 0);
            assert.ok(!JSON.stringify(metric).includes('private code'));
            assert.ok(!JSON.stringify(metric).includes('configured-value'));
        }
    });

    it('publishes admin telemetry through a metrics source without changing the MCP response', async () => {
        const { server, runtimeNode, types } = buildServer({
            serverName: 'ops',
            serverPath: '/internal/mcp/ops',
            __flowNodes: [{ id: 'tab1', type: 'tab', label: 'Operations' }],
            __runtime: {
                adminPort: 1881,
                adminEndpointPath: '/internal/mcp/ops',
                credentials: { adminToken: 'configured-value' }
            }
        });
        const metrics = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        const response = mockRes();
        await server.handleToolCall({ id: 1, params: { name: 'get_flow', arguments: {} } }, response);

        assert.equal(response.body.result.structuredContent.totalTabs, 1);
        assert.equal(metrics.sent.length, 1);
        assert.equal(metrics.sent[0].topic, 'mcp-admin-telemetry');
        assert.deepStrictEqual(Object.keys(metrics.sent[0].payload).sort(), [
            'cached', 'durationMs', 'endpoint', 'mode', 'responseBytes', 'scannedNodes', 'status', 'tool'
        ]);
        assert.equal(metrics.sent[0].payload.endpoint, 'ops');
        assert.equal(metrics.sent[0].payload.tool, 'get_flow');
        assert.equal(metrics.sent[0].payload.status, 'success');
        assert.equal(server.sent[0][0], null);
        assert.equal(server.sent[0][1].topic, 'mcp-admin-telemetry');
        assert.ok(!JSON.stringify(metrics.sent[0]).includes('configured-value'));
    });

    it('forwards failed admin telemetry without request arguments', async () => {
        const { server, runtimeNode, types } = buildServer({
            serverPath: '/internal/mcp/ops',
            __runtime: {
                adminPort: 1881,
                adminEndpointPath: '/internal/mcp/ops',
                credentials: { adminToken: 'configured-value' }
            }
        });
        const metrics = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        const response = mockRes();
        await server.handleToolCall({
            id: 1,
            params: { name: 'get_flow', arguments: { mode: 'private-request-value' } }
        }, response);

        assert.equal(response.body.error.code, -32602);
        assert.equal(metrics.sent.length, 1);
        assert.equal(metrics.sent[0].payload.status, 'failed');
        assert.equal(metrics.sent[0].payload.mode, 'unknown');
        assert.ok(!JSON.stringify(metrics.sent[0]).includes('private-request-value'));
    });

    it('allows only one metrics source per runtime and releases its subscription on close', () => {
        const { runtimeNode, types } = buildServer();
        const first = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        const duplicate = new types['mcp-server-metrics']({ id: 'metrics-2', runtime: runtimeNode.id });
        assert.deepStrictEqual(duplicate.errors, ['Only one MCP Server Metrics node is allowed per runtime']);

        runtimeNode.publishAdminTelemetry({ tool: 'get_flow' });
        assert.equal(first.sent.length, 1);
        assert.equal(duplicate.sent.length, 0);

        first.emit('close');
        const replacement = new types['mcp-server-metrics']({ id: 'metrics-3', runtime: runtimeNode.id });
        runtimeNode.publishAdminTelemetry({ tool: 'get_flow' });
        assert.equal(first.sent.length, 1);
        assert.equal(replacement.sent.length, 1);

        runtimeNode.emit('close');
        runtimeNode.publishAdminTelemetry({ tool: 'get_flow' });
        assert.equal(replacement.sent.length, 1);
    });

    it('reports a missing metrics runtime without subscribing', () => {
        const { types } = buildServer();
        const metrics = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: 'missing' });
        assert.deepStrictEqual(metrics.errors, ['MCP runtime is required for metrics']);
        assert.equal(metrics.sent.length, 0);
    });

    it('keeps MCP responses available if the metrics source fails', async () => {
        const { server, runtimeNode, types } = buildServer({
            serverPath: '/internal/mcp/ops',
            __flowNodes: [{ id: 'tab1', type: 'tab', label: 'Operations' }],
            __runtime: {
                adminPort: 1881,
                adminEndpointPath: '/internal/mcp/ops',
                credentials: { adminToken: 'configured-value' }
            }
        });
        const metrics = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        metrics.send = () => { throw new Error('metrics unavailable'); };
        const response = mockRes();
        await server.handleToolCall({ id: 1, params: { name: 'get_flow', arguments: {} } }, response);
        await server.handleToolCall({ id: 2, params: { name: 'get_flow', arguments: {} } }, mockRes());

        assert.equal(response.body.result.structuredContent.totalTabs, 1);
        assert.deepStrictEqual(runtimeNode.warnings, ['MCP admin telemetry subscriber failed']);
    });

    it('emits failed admin telemetry without changing the error response', async () => {
        const { server } = buildServer({
            serverPath: '/internal/mcp/ops',
            __runtime: {
                adminPort: 1881,
                adminEndpointPath: '/internal/mcp/ops',
                credentials: { adminToken: 'configured-value' }
            }
        });
        const response = mockRes();
        await server.handleToolCall({
            id: 2,
            params: { name: 'get_flow', arguments: { mode: 'invalid-secret-input' } }
        }, response);

        assert.equal(response.body.error.code, -32602);
        const metric = server.sent[0][1];
        assert.equal(metric.payload.mode, 'unknown');
        assert.equal(metric.payload.status, 'failed');
        assert.equal(metric.payload.scannedNodes, null);
        assert.equal(metric.payload.cached, null);
        assert.equal(metric.payload.responseBytes, Buffer.byteLength(JSON.stringify(response.body)));
        assert.ok(!JSON.stringify(metric).includes('invalid-secret-input'));
    });

    it('marks a structured admin tool error as failed telemetry', async () => {
        const { server } = buildServer({
            serverPath: '/internal/mcp/ops',
            __runtime: {
                adminPort: 1881,
                adminEndpointPath: '/internal/mcp/ops',
                credentials: { adminToken: 'configured-value' }
            }
        });
        const result = {
            isError: true,
            content: [{ type: 'text', text: 'Tab not found' }],
            structuredContent: {
                mode: 'tab_summary',
                source: '/flow/missing',
                meta: { scannedNodes: 0, cached: false },
                error: { code: 'FLOW_NOT_FOUND', message: 'Tab not found' }
            }
        };
        server.adminTools.callTool = async () => result;
        const response = mockRes();
        await server.handleToolCall({
            id: 5,
            params: { name: 'get_flow', arguments: { id: 'missing' } }
        }, response);

        assert.deepStrictEqual(response.body.result, result);
        assert.deepStrictEqual({
            mode: server.sent[0][1].payload.mode,
            status: server.sent[0][1].payload.status,
            scannedNodes: server.sent[0][1].payload.scannedNodes,
            cached: server.sent[0][1].payload.cached
        }, { mode: 'tab_summary', status: 'failed', scannedNodes: 0, cached: false });
    });

    it('keeps admin responses available if telemetry delivery fails', async () => {
        const { server } = buildServer({
            serverPath: '/internal/mcp/ops',
            __flowNodes: [{ id: 'tab1', type: 'tab', label: 'Operations' }],
            __runtime: {
                adminPort: 1881,
                adminEndpointPath: '/internal/mcp/ops',
                credentials: { adminToken: 'configured-value' }
            }
        });
        server.send = () => { throw new Error('telemetry unavailable'); };
        const response = mockRes();
        await server.handleToolCall({ id: 3, params: { name: 'get_flow', arguments: {} } }, response);
        await server.handleToolCall({ id: 4, params: { name: 'get_flow', arguments: {} } }, mockRes());
        assert.equal(response.body.result.structuredContent.totalTabs, 1);
        assert.deepStrictEqual(server.warnings, ['MCP admin telemetry output failed']);
    });

    it('does not expose admin tools without complete runtime admin config', () => {
        delete process.env.NODE_RED_ADMIN_API_TOKEN;
        const { server } = buildServer({
            serverName: 'ops',
            serverPath: '/internal/mcp/ops',
            __runtime: {
                serverPort: 18004,
                adminPort: 1881,
                adminEndpointPath: '/internal/mcp/ops',
                credentials: { adminToken: '' }
            }
        });
        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        assert.ok(!res.body.result.tools.some(tool => tool.name === 'get_flow'));
    });

    it('uses NODE_RED_ADMIN_API_TOKEN for admin tool gating', () => {
        process.env.NODE_RED_ADMIN_API_TOKEN = 'configured-value';
        try
        {
            const { server } = buildServer({
                serverName: 'ops',
                serverPath: '/internal/mcp/ops',
                __runtime: {
                    serverPort: 18007,
                    adminPort: 1881,
                    adminEndpointPath: '/internal/mcp/ops',
                    credentials: { adminToken: '' }
                }
            });
            const res = mockRes();
            server.handleToolsList({ id: 1 }, res);
            assert.ok(res.body.result.tools.some(tool => tool.name === 'get_flow'));
        } finally
        {
            delete process.env.NODE_RED_ADMIN_API_TOKEN;
        }
    });


    it('keeps same tool name isolated across endpoint bindings', () => {
        const { RED, server } = buildServer({ id: 'alpha-endpoint', serverName: 'alpha' });
        RED.events.emit('mcp-tool-register', {
            name: 'status_tool',
            description: 'Alpha status',
            endpointId: 'alpha-endpoint',
            inputSchema: { type: 'object', properties: { alpha: { type: 'boolean' } } }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'status_tool',
            description: 'Beta status',
            endpointId: 'beta-endpoint',
            inputSchema: { type: 'object', properties: { beta: { type: 'boolean' } } }
        });

        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        assert.strictEqual(res.body.result.tools.length, 1);
        assert.strictEqual(res.body.result.tools[0].description, 'Alpha status');
    });

    it('executes a registered upstream flow tool through executionId response loop', async () => {
        const { RED, server } = buildServer();
        RED.events.emit('mcp-tool-register', {
            name: 'sample_ping',
            description: 'Sample ping',
            inputSchema: { type: 'object', properties: {} }
        });
        const pending = server.handleToolCall({ id: 7, params: { name: 'sample_ping', arguments: { text: 'ok' } } }, mockRes());
        const exec = server.sent.find(msg => msg.topic === 'mcp-tool-execute');
        assert.strictEqual(exec.payload.toolName, 'sample_ping');
        server.emit('input', {
            topic: 'mcp-tool-response',
            payload: { executionId: exec.payload.executionId, result: { ok: true, received: exec.payload.arguments } }
        });
        await pending;
    });

    it('resolves a pending tool execution when the response reaches a replacement endpoint instance', async () => {
        const runtime = createRuntime({ id: 'endpoint-shared', serverPath: '/mcp/a' });
        const replacement = new runtime.types['mcp-flow-server']({
            id: 'endpoint-shared',
            runtime: 'runtime-1',
            serverName: 'test-replacement',
            serverPath: '/mcp/a'
        });
        runtime.RED.events.emit('mcp-tool-register', {
            name: 'sample_ping',
            description: 'Sample ping',
            endpointId: 'endpoint-shared',
            inputSchema: { type: 'object', properties: {} }
        });

        const res = mockRes();
        const pending = runtime.server.handleToolCall({ id: 8, params: { name: 'sample_ping', arguments: { text: 'ok' } } }, res);
        const exec = runtime.server.sent.find(msg => msg.topic === 'mcp-tool-execute');
        assert.strictEqual(exec.payload.toolName, 'sample_ping');

        replacement.emit('input', {
            topic: 'mcp-tool-response',
            payload: { executionId: exec.payload.executionId, result: { ok: true, replacement: true } }
        });

        await pending;
        assert.deepStrictEqual(res.body.result, { content: [{ type: 'text', text: JSON.stringify({ ok: true, replacement: true }) }] });
    });

    it('returns OAuth challenge when an OAuth endpoint has no bearer token', async () => {
        const authNode = { id: 'auth-1', enabled: true, baseScopes: 'openid profile email', readAccessToken: async () => null };
        const { server } = buildServer({
            auth: 'auth-1',
            authMode: 'oauth',
            requiredScopes: 'resource:read',
            allowedGroups: 'team-a',
            __nodes: { 'auth-1': authNode },
            __runtime: { publicBaseUrl: 'https://mcp.example.test' }
        });
        const res = mockRes();

        await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'initialize' }), res);

        assert.strictEqual(res.statusCode, 401);
        assert.match(res.headers['www-authenticate'], /^Bearer /);
        assert.match(res.headers['www-authenticate'], /oauth-protected-resource\/mcp\/test/);
        assert.strictEqual(res.body.error, 'invalid_token');
    });

    it('returns OAuth challenge for GET discovery probes on an OAuth endpoint', async () => {
        const authNode = { id: 'auth-1', enabled: true, baseScopes: 'openid profile email', readAccessToken: async () => null };
        const { server } = buildServer({
            auth: 'auth-1',
            authMode: 'oauth',
            __nodes: { 'auth-1': authNode },
            __runtime: { serverPort: 18110, publicBaseUrl: 'https://mcp.example.test' }
        });

        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try
        {
            const res = await fetch('http://127.0.0.1:18110/mcp/test', { headers: { host: 'mcp.example.test' } });
            assert.strictEqual(res.status, 401);
            assert.match(res.headers.get('www-authenticate'), /^Bearer /);
            assert.match(res.headers.get('www-authenticate'), /oauth-protected-resource\/mcp\/test/);
        } finally
        {
            await new Promise(resolve => server.stopServer(() => resolve()));
        }
    });

    it('serves root protected resource metadata for a single OAuth endpoint', async () => {
        const authNode = { id: 'auth-1', enabled: true, baseScopes: 'openid profile email', readAccessToken: async () => null };
        const { server } = buildServer({
            auth: 'auth-1',
            authMode: 'oauth',
            __nodes: { 'auth-1': authNode },
            __runtime: { serverPort: 18111, publicBaseUrl: 'https://mcp.example.test' }
        });

        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try
        {
            const res = await fetch('http://127.0.0.1:18111/.well-known/oauth-protected-resource', { headers: { host: 'mcp.example.test' } });
            const body = await res.json();
            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.resource, 'https://mcp.example.test/mcp/test');
            assert.deepStrictEqual(body.authorization_servers, ['https://mcp.example.test']);

            const legacy = await fetch('http://127.0.0.1:18111/.well-known/oauth-authorization-server/auth-1', { headers: { host: 'mcp.example.test' } });
            assert.strictEqual(legacy.status, 200);

            const pathfulIssuer = await fetch('http://127.0.0.1:18111/.well-known/oauth-authorization-server/oauth/auth-1', { headers: { host: 'mcp.example.test' } });
            const issuerBody = await pathfulIssuer.json();
            assert.strictEqual(pathfulIssuer.status, 200);
            assert.strictEqual(issuerBody.issuer, 'https://mcp.example.test');
        } finally
        {
            await new Promise(resolve => server.stopServer(() => resolve()));
        }
    });

    it('parses allowed groups as comma-separated names so spaces inside group names are preserved', async () => {
        const authNode = {
            id: 'auth-1',
            enabled: true,
            baseScopes: 'openid profile email',
            readAccessToken: async () => ({
                resource: 'https://mcp.example.test/mcp/test',
                scopes: ['resource:read'],
                groups: ['DFF Users']
            })
        };
        const { server } = buildServer({
            auth: 'auth-1',
            authMode: 'oauth',
            requiredScopes: 'resource:read',
            allowedGroups: 'AI Tools MCP Users, DFF Users',
            __nodes: { 'auth-1': authNode },
            __runtime: { publicBaseUrl: 'https://mcp.example.test' }
        });
        const res = mockRes();

        await server.handleMcpHttpRequest(mockReq(
            { jsonrpc: '2.0', id: 1, method: 'initialize' },
            { authorization: 'Bearer configured-value' }
        ), res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.result.serverInfo.name, 'test');
    });

    it('allows initialize with a valid endpoint-scoped access token', async () => {
        const authNode = {
            id: 'auth-1',
            enabled: true,
            baseScopes: 'openid profile email',
            readAccessToken: async token => token === 'configured-value' ? {
                resource: 'https://mcp.example.test/mcp/test',
                scopes: ['resource:read'],
                groups: ['team-a'],
                subject: 'user-1'
            } : null
        };
        const { server } = buildServer({
            auth: 'auth-1',
            authMode: 'oauth',
            requiredScopes: 'resource:read',
            allowedGroups: 'team-a',
            __nodes: { 'auth-1': authNode },
            __runtime: { publicBaseUrl: 'https://mcp.example.test' }
        });
        const res = mockRes();

        await server.handleMcpHttpRequest(mockReq(
            { jsonrpc: '2.0', id: 1, method: 'initialize' },
            { authorization: 'Bearer configured-value' }
        ), res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.result.serverInfo.name, 'test');
    });

    it('filters tools/list by tool-level required scopes', async () => {
        const authNode = {
            id: 'auth-1',
            enabled: true,
            baseScopes: 'openid profile email',
            readAccessToken: async () => ({
                resource: 'https://mcp.example.test/mcp/test',
                scopes: ['resource:read', 'tool:read'],
                groups: ['team-a']
            })
        };
        const { RED, server } = buildServer({
            auth: 'auth-1',
            authMode: 'oauth',
            requiredScopes: 'resource:read',
            allowedGroups: 'team-a',
            __nodes: { 'auth-1': authNode },
            __runtime: { publicBaseUrl: 'https://mcp.example.test' }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'read_tool',
            description: 'Read',
            requiredScopes: ['tool:read'],
            inputSchema: { type: 'object', properties: {} }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'write_tool',
            description: 'Write',
            requiredScopes: ['tool:write'],
            inputSchema: { type: 'object', properties: {} }
        });
        const res = mockRes();

        await server.handleMcpHttpRequest(mockReq(
            { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            { authorization: 'Bearer scoped-token' }
        ), res);

        assert.deepStrictEqual(res.body.result.tools.map(tool => tool.name), ['read_tool']);
    });

    it('rejects tools/call when the token lacks the tool scope', async () => {
        const authNode = {
            id: 'auth-1',
            enabled: true,
            baseScopes: 'openid profile email',
            readAccessToken: async () => ({
                resource: 'https://mcp.example.test/mcp/test',
                scopes: ['resource:read'],
                groups: ['team-a']
            })
        };
        const { RED, server } = buildServer({
            auth: 'auth-1',
            authMode: 'oauth',
            requiredScopes: 'resource:read',
            allowedGroups: 'team-a',
            __nodes: { 'auth-1': authNode },
            __runtime: { publicBaseUrl: 'https://mcp.example.test' }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'write_tool',
            description: 'Write',
            requiredScopes: ['tool:write'],
            inputSchema: { type: 'object', properties: {} }
        });
        const res = mockRes();

        await server.handleMcpHttpRequest(mockReq(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_tool', arguments: {} } },
            { authorization: 'Bearer scoped-token' }
        ), res);

        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(res.body.error.message, 'Forbidden');
    });
});
