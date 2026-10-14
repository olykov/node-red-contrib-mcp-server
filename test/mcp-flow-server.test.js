'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

function createRuntime(config = {}) {
    const types = {};
    const events = new EventEmitter();
    const nodeMap = config.__nodes || {};
    nodeMap['default-auth'] = { id: 'default-auth', oauthSlug: 'default-login',
        baseScopes: 'openid profile email', readAccessToken: async token => token === 'test-token' ?
            { groups: [], scopes: ['openid', 'profile', 'email'] } : null };
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
            registerType(name, ctor, options) { types[name] = ctor; types['options:' + name] = options; },
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
        serverPort: 18001
    }, config.__runtime || {});
    const runtimeNode = new types['mcp-runtime'](runtimeConfig);
    nodeMap[runtimeConfig.id] = runtimeNode;
    const nodeConfig = Object.assign({
        id: 'endpoint-1',
        runtime: runtimeConfig.id,
        auth: 'default-auth',
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
        const { RED, server } = buildServer();
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

    it('preserves registered tool annotations and security metadata', () => {
        const { RED, server } = buildServer();
        RED.events.emit('mcp-tool-register', {
            name: 'read_status',
            description: 'Read status',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
        });

        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        const tool = res.body.result.tools.find(item => item.name === 'read_status');
        assert.deepStrictEqual(tool.annotations, {
            readOnlyHint: true, destructiveHint: false, openWorldHint: false
        });
        assert.deepStrictEqual(tool._meta.securitySchemes, [{ type: 'oauth2', scopes: ['openid', 'profile', 'email'] }]);
    });

    it('serves registry annotations through the MCP tools/list request', async () => {
        const { RED, types, server } = buildServer();
        require('../mcp-tool-registry')(RED);
        const registry = new types['mcp-tool-registry']({
            id: 'registry-1',
            toolName: 'read_status',
            endpoint: server.id,
            toolSchema: '{"type":"object","properties":{}}',
            toolBehavior: 'read',
            worldAccess: 'closed'
        });
        registry.registerTool();

        const res = mockRes();
        await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), res);

        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body.result.tools.find(tool => tool.name === 'read_status').annotations, {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false
        });
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
            serverPath: '/mcp/ops',

            __runtime: { serverPort: 18002 }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'read_status',
            description: 'Read status',
            endpointId: 'endpoint-1',
            inputSchema: { type: 'object', properties: {} }
        });

        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        assert.strictEqual(server.serverName, 'ops');
        assert.strictEqual(server.serverPath, '/mcp/ops');
        assert.strictEqual(server.serverPort, 18002);
        assert.strictEqual(runtimeNode.serverPort, 18002);
        assert.deepStrictEqual(res.body.result.tools[0]._meta.securitySchemes, [{ type: 'oauth2', scopes: ['openid', 'profile', 'email'] }]);
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
            auth: 'default-auth',
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
            serverPort: 18006
        });
        runtime.nodeMap['runtime-b'] = runtimeB;
        const serverB = new runtime.types['mcp-flow-server']({
            id: 'endpoint-b',
            runtime: 'runtime-b',
            auth: 'default-auth',
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
            adminEndpointPath: '/mcp/ops',
            credentials: { adminToken: 'configured-value' }
        };
        const adminServer = buildServer({
            id: 'admin-endpoint',
            serverName: 'ops',
            serverPath: '/mcp/ops',
            __runtime: adminRuntime
        }).server;
        const otherServer = buildServer({
            id: 'other-endpoint',
            serverName: 'other',
            serverPath: '/mcp/other',
            __runtime: Object.assign({ id: 'runtime-2' }, adminRuntime)
        }).server;

        const adminRes = mockRes();
        adminServer.handleToolsList({ id: 1 }, adminRes);
        const otherRes = mockRes();
        otherServer.handleToolsList({ id: 2 }, otherRes);

        const getFlow = adminRes.body.result.tools.find(tool => tool.name === 'get_flow');
        assert.ok(getFlow);
        assert.ok(getFlow.inputSchema.properties.mode.enum.includes('subflow'));
        assert.deepStrictEqual(getFlow.inputSchema.properties.subflowId, {
            type: 'string', description: 'Definition ID in subflow mode'
        });
        assert.deepStrictEqual(getFlow.inputSchema.properties.includeConfig, {
            type: 'boolean',
            description: 'Return bounded execution settings for inject, link, switch, catch, mongodb4 and MCP nodes in node mode; credentials are excluded'
        });
        assert.strictEqual(getFlow.outputSchema.type, 'object');
        assert.deepStrictEqual(getFlow.outputSchema.required, ['mode', 'source', 'meta']);
        assert.deepStrictEqual(getFlow.annotations, {
            readOnlyHint: true, destructiveHint: false, openWorldHint: false
        });
        assert.ok(!otherRes.body.result.tools.some(tool => tool.name === 'get_flow'));
    });

    it('passes the in-process tab iterator to the admin tool and releases its listener', async () => {
        const flowNodes = [
            { id: 'tab1', type: 'tab', label: 'Operations' },
            { id: 'n1', type: 'function', z: 'tab1', func: 'private code' }
        ];
        const { RED, server } = buildServer({
            id: 'admin-endpoint',
            serverPath: '/mcp/ops',
            __flowNodes: flowNodes,
            __runtime: {
                adminPort: 1881,
                adminEndpointPath: '/mcp/ops',
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

    it('publishes admin calls through the runtime metrics source without changing the MCP response', async () => {
        const { server, runtimeNode, types } = buildServer({
            serverName: 'ops',
            serverPath: '/mcp/ops',
            __flowNodes: [{ id: 'tab1', type: 'tab', label: 'Operations' }],
            __runtime: {
                adminPort: 1881,
                adminEndpointPath: '/mcp/ops',
                credentials: { adminToken: 'configured-value' }
            }
        });
        const metrics = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        const response = mockRes();
        await server.handleToolCall({ id: 1, params: { name: 'get_flow', arguments: {} } }, response);

        assert.equal(response.body.result.structuredContent.totalTabs, 1);
        assert.equal(metrics.sent.length, 1);
        assert.equal(metrics.sent[0].topic, 'mcp-tool-telemetry');
        assert.deepStrictEqual(Object.keys(metrics.sent[0].payload).sort(), [
            'cached', 'durationMs', 'endpoint', 'mode', 'responseBytes', 'scannedNodes', 'status', 'tool'
        ]);
        assert.equal(metrics.sent[0].payload.endpoint, 'ops');
        assert.equal(metrics.sent[0].payload.tool, 'get_flow');
        assert.equal(metrics.sent[0].payload.status, 'success');
        assert.equal(server.sent.length, 0);
        assert.ok(!JSON.stringify(metrics.sent[0]).includes('configured-value'));
    });

    it('forwards failed admin telemetry without request arguments', async () => {
        const { server, runtimeNode, types } = buildServer({
            serverPath: '/mcp/ops',
            __runtime: {
                adminPort: 1881,
                adminEndpointPath: '/mcp/ops',
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

    it('emits one bounded runtime event for a flow tool call', async () => {
        const { RED, server, runtimeNode, types } = buildServer();
        RED.events.emit('mcp-tool-register', {
            name: 'sample_ping',
            description: 'Sample',
            inputSchema: { type: 'object', properties: {} }
        });
        const metrics = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        const response = mockRes();
        const pending = server.handleMcpHttpRequest(mockReq({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'sample_ping', arguments: { secret: 'private-argument' } }
        }, { authorization: 'Bearer test-token' }), response);
        await new Promise(resolve => setImmediate(resolve));
        const execution = server.sent.find(msg => msg.topic === 'mcp-tool-execute');
        server.emit('input', {
            topic: 'mcp-tool-response',
            payload: { executionId: execution.payload.executionId, result: { secret: 'private-result' } }
        });
        await pending;

        assert.equal(response.body.result.content[0].text, JSON.stringify({ secret: 'private-result' }));
        assert.equal(metrics.sent.length, 1);
        assert.equal(metrics.sent[0].topic, 'mcp-tool-telemetry');
        assert.deepStrictEqual(Object.keys(metrics.sent[0].payload).sort(), [
            'cached', 'durationMs', 'endpoint', 'mode', 'responseBytes', 'scannedNodes', 'status', 'tool'
        ]);
        assert.deepStrictEqual({
            endpoint: metrics.sent[0].payload.endpoint,
            tool: metrics.sent[0].payload.tool,
            mode: metrics.sent[0].payload.mode,
            status: metrics.sent[0].payload.status,
            responseBytes: metrics.sent[0].payload.responseBytes,
            scannedNodes: metrics.sent[0].payload.scannedNodes,
            cached: metrics.sent[0].payload.cached
        }, {
            endpoint: 'test', tool: 'sample_ping', mode: 'flow', status: 'success',
            responseBytes: Buffer.byteLength(JSON.stringify(response.body)),
            scannedNodes: null, cached: null
        });
        assert.ok(metrics.sent[0].payload.durationMs >= 0);
        assert.ok(!JSON.stringify(metrics.sent[0]).includes('private-argument'));
        assert.ok(!JSON.stringify(metrics.sent[0]).includes('private-result'));
        assert.equal(server.sent.filter(Array.isArray).length, 0);
    });

    it('tracks flow errors and rejects legacy direct calls', async () => {
        const { RED, server, runtimeNode, types } = buildServer();
        RED.events.emit('mcp-tool-register', {
            name: 'sample_tool',
            description: 'Sample',
            inputSchema: { type: 'object', properties: {} }
        });
        const metrics = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        server.executeToolFlow = async () => ({
            isError: true, content: [{ type: 'text', text: 'private-failure' }]
        });
        const failed = mockRes();
        await server.handleMcpHttpRequest(mockReq({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'sample_tool', arguments: {} }
        }, { authorization: 'Bearer test-token' }), failed);
        assert.equal(failed.body.result.isError, true);
        assert.deepStrictEqual(metrics.sent[0].payload.tool, 'sample_tool');
        assert.equal(metrics.sent[0].payload.status, 'failed');

        const unknown = mockRes();
        await server.handleMcpHttpRequest(mockReq({
            jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'unbounded-private-tool-name', arguments: {} }
        }, { authorization: 'Bearer test-token' }), unknown);
        assert.equal(unknown.body.error.code, -32602);
        assert.equal(metrics.sent[1].payload.tool, 'unknown');
        assert.equal(metrics.sent[1].payload.status, 'failed');

        let executed = false;
        server.executeToolFlow = async () => {
            executed = true;
            return { ok: true };
        };
        const direct = mockRes();
        await server.handleMcpHttpRequest(mockReq({
            jsonrpc: '2.0', id: 3, method: 'sample_tool', params: {}
        }, { authorization: 'Bearer test-token' }), direct);
        assert.equal(direct.body.error.code, -32601);
        assert.equal(executed, false);
        assert.equal(metrics.sent.length, 2);
        assert.ok(!JSON.stringify(metrics.sent).includes('unbounded-private-tool-name'));
        assert.ok(!JSON.stringify(metrics.sent).includes('private-failure'));
    });

    it('tracks authentication and role denials without executing the tool', async () => {
        const authNode = {
            id: 'auth-1', oauthSlug: 'test-login',
            baseScopes: 'openid profile email',
            readAccessToken: async () => ({
                resource: 'https://mcp.example.test/mcp/test',
                scopes: ['openid'],
                groups: []
            })
        };
        const { RED, server, runtimeNode, types } = buildServer({
            auth: 'auth-1',
            allowedGroups: 'team-a',
            __nodes: { 'auth-1': authNode },
            __runtime: { publicBaseUrl: 'https://mcp.example.test' }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'write_tool',
            description: 'Write',
            inputSchema: { type: 'object', properties: {} }
        });
        const metrics = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_tool', arguments: {} } };

        const unauthenticated = mockRes();
        await server.handleMcpHttpRequest(mockReq(request), unauthenticated);
        assert.equal(unauthenticated.statusCode, 200);
        assert.equal(unauthenticated.body.result.isError, true);
        assert.equal(metrics.sent[0].payload.tool, 'unknown');
        assert.equal(metrics.sent[0].payload.status, 'failed');

        const forbidden = mockRes();
        await server.handleMcpHttpRequest(mockReq(request, { authorization: 'Bearer scoped-token' }), forbidden);
        assert.equal(forbidden.statusCode, 403);
        assert.equal(forbidden.body.error, 'insufficient_access');
        assert.equal(metrics.sent[1].payload.tool, 'unknown');
        assert.equal(metrics.sent[1].payload.status, 'failed');
        assert.equal(metrics.sent.length, 2);
        assert.equal(server.sent.length, 0);
    });

    it('tracks a flow tool execution rejection without changing the RPC error', async () => {
        const { RED, server, runtimeNode, types } = buildServer();
        RED.events.emit('mcp-tool-register', {
            name: 'sample_ping',
            description: 'Sample',
            inputSchema: { type: 'object', properties: {} }
        });
        const metrics = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        server.executeToolFlow = async () => { throw new Error('Tool execution timeout'); };
        const response = mockRes();
        await server.handleMcpHttpRequest(mockReq({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'sample_ping', arguments: {} }
        }, { authorization: 'Bearer test-token' }), response);
        assert.equal(response.body.error.message, 'Tool execution timeout');
        assert.equal(metrics.sent.length, 1);
        assert.equal(metrics.sent[0].payload.tool, 'sample_ping');
        assert.equal(metrics.sent[0].payload.status, 'failed');
    });

    it('collects tool calls from every endpoint on the selected runtime', async () => {
        const runtime = createRuntime({ id: 'endpoint-a', serverName: 'alpha' });
        const serverB = new runtime.types['mcp-flow-server']({
            id: 'endpoint-b',
            runtime: runtime.runtimeNode.id,
            auth: 'default-auth',
            serverName: 'beta',
            serverPath: '/mcp/b'
        });
        runtime.RED.events.emit('mcp-tool-register', {
            name: 'shared_ping',
            description: 'Shared',
            inputSchema: { type: 'object', properties: {} }
        });
        const metrics = new runtime.types['mcp-server-metrics']({
            id: 'metrics-1', runtime: runtime.runtimeNode.id
        });
        runtime.server.executeToolFlow = async () => ({ ok: true });
        serverB.executeToolFlow = async () => ({ ok: true });
        const request = { id: 1, params: { name: 'shared_ping', arguments: {} } };

        await runtime.server.handleToolCall(request, mockRes());
        await serverB.handleToolCall(request, mockRes());

        assert.deepStrictEqual(metrics.sent.map(msg => msg.payload.endpoint), ['alpha', 'beta']);
        assert.deepStrictEqual(metrics.sent.map(msg => msg.payload.tool), ['shared_ping', 'shared_ping']);
    });

    it('allows only one metrics source per runtime and releases its subscription on close', () => {
        const { runtimeNode, types } = buildServer();
        const first = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        const duplicate = new types['mcp-server-metrics']({ id: 'metrics-2', runtime: runtimeNode.id });
        assert.deepStrictEqual(duplicate.errors, ['Only one MCP Server Metrics node is allowed per runtime']);

        runtimeNode.publishToolTelemetry({ tool: 'get_flow' });
        assert.equal(first.sent.length, 1);
        assert.equal(duplicate.sent.length, 0);

        first.emit('close');
        const replacement = new types['mcp-server-metrics']({ id: 'metrics-3', runtime: runtimeNode.id });
        runtimeNode.publishToolTelemetry({ tool: 'get_flow' });
        assert.equal(first.sent.length, 1);
        assert.equal(replacement.sent.length, 1);

        runtimeNode.emit('close');
        runtimeNode.publishToolTelemetry({ tool: 'get_flow' });
        assert.equal(replacement.sent.length, 1);
    });

    it('reports a missing metrics runtime without subscribing', () => {
        const { types } = buildServer();
        const metrics = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: 'missing' });
        assert.deepStrictEqual(metrics.errors, ['MCP runtime is required for metrics']);
        assert.equal(metrics.sent.length, 0);
    });

    it('keeps MCP responses available if the metrics source fails', async () => {
        const { RED, server, runtimeNode, types } = buildServer({
            serverPath: '/mcp/ops',
            __flowNodes: [{ id: 'tab1', type: 'tab', label: 'Operations' }],
            __runtime: {
                adminPort: 1881,
                adminEndpointPath: '/mcp/ops',
                credentials: { adminToken: 'configured-value' }
            }
        });
        const metrics = new types['mcp-server-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        metrics.send = () => { throw new Error('metrics unavailable'); };
        const response = mockRes();
        await server.handleToolCall({ id: 1, params: { name: 'get_flow', arguments: {} } }, response);
        await server.handleToolCall({ id: 2, params: { name: 'get_flow', arguments: {} } }, mockRes());
        RED.events.emit('mcp-tool-register', {
            name: 'sample_ping',
            description: 'Sample',
            inputSchema: { type: 'object', properties: {} }
        });
        server.executeToolFlow = async () => ({ ok: true });
        const flowResponse = mockRes();
        await server.handleToolCall({
            id: 3, params: { name: 'sample_ping', arguments: {} }
        }, flowResponse);

        assert.equal(response.body.result.structuredContent.totalTabs, 1);
        assert.equal(flowResponse.body.result.content[0].text, JSON.stringify({ ok: true }));
        assert.deepStrictEqual(runtimeNode.warnings, ['MCP tool telemetry subscriber failed']);
    });

    it('does not expose admin tools without complete runtime admin config', () => {
        delete process.env.NODE_RED_ADMIN_API_TOKEN;
        const { server } = buildServer({
            serverName: 'ops',
            serverPath: '/mcp/ops',
            __runtime: {
                serverPort: 18004,
                adminPort: 1881,
                adminEndpointPath: '/mcp/ops',
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
                serverPath: '/mcp/ops',
                __runtime: {
                    serverPort: 18007,
                    adminPort: 1881,
                    adminEndpointPath: '/mcp/ops',
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
            auth: 'default-auth',
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

    it('permits initialize without a bearer token on an OAuth endpoint', async () => {
        const authNode = { id: 'auth-1', oauthSlug: 'test-login', baseScopes: 'openid profile email', readAccessToken: async () => null };
        const { server } = buildServer({
            auth: 'auth-1',
            allowedGroups: 'team-a',
            __nodes: { 'auth-1': authNode },
            __runtime: { publicBaseUrl: 'https://mcp.example.test' }
        });
        const res = mockRes();

        await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'initialize' }), res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.result.serverInfo.name, 'test');
        assert.strictEqual(res.headers['www-authenticate'], undefined);
    });

    it('returns OAuth challenge for GET discovery probes on an OAuth endpoint', async () => {
        const authNode = { id: 'auth-1', oauthSlug: 'test-login', baseScopes: 'openid profile email', readAccessToken: async () => null };
        const { server } = buildServer({
            auth: 'auth-1',
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
        const authNode = { id: 'auth-1', oauthSlug: 'test-login', baseScopes: 'openid profile email', readAccessToken: async () => null };
        const { server } = buildServer({
            auth: 'auth-1',
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

            const legacy = await fetch('http://127.0.0.1:18111/.well-known/oauth-authorization-server/test-login', { headers: { host: 'mcp.example.test' } });
            assert.strictEqual(legacy.status, 200);

            const pathfulIssuer = await fetch('http://127.0.0.1:18111/.well-known/oauth-authorization-server/oauth/test-login', { headers: { host: 'mcp.example.test' } });
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
            id: 'auth-1', oauthSlug: 'test-login',
            baseScopes: 'openid profile email',
            readAccessToken: async () => ({
                resource: 'https://mcp.example.test/mcp/test',
                scopes: ['openid'],
                groups: ['Team B']
            })
        };
        const { server } = buildServer({
            auth: 'auth-1',
            allowedGroups: 'MCP Users, Team B',
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
            id: 'auth-1', oauthSlug: 'test-login',
            baseScopes: 'openid profile email',
            readAccessToken: async token => token === 'configured-value' ? {
                resource: 'https://mcp.example.test/mcp/test',
                scopes: ['openid'],
                groups: ['team-a'],
                subject: 'user-1'
            } : null
        };
        const { server } = buildServer({
            auth: 'auth-1',
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

    it('advertises automatic OAuth scopes on every tool', async () => {
        const authNode = {
            id: 'auth-1', oauthSlug: 'test-login',
            baseScopes: 'openid profile email',
            readAccessToken: async () => ({
                resource: 'https://mcp.example.test/mcp/test',
                scopes: ['openid', 'profile'],
                groups: ['team-a']
            })
        };
        const { RED, server } = buildServer({
            auth: 'auth-1',
            allowedGroups: 'team-a',
            __nodes: { 'auth-1': authNode },
            __runtime: { publicBaseUrl: 'https://mcp.example.test' }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'read_tool',
            description: 'Read',
            inputSchema: { type: 'object', properties: {} }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'write_tool',
            description: 'Write',
            inputSchema: { type: 'object', properties: {} }
        });
        const res = mockRes();

        await server.handleMcpHttpRequest(mockReq(
            { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            { authorization: 'Bearer scoped-token' }
        ), res);

        assert.deepStrictEqual(res.body.result.tools.map(tool => tool.name), ['read_tool', 'write_tool']);
        assert.deepStrictEqual(res.body.result.tools[1].securitySchemes,
            [{ type: 'oauth2', scopes: ['openid', 'profile', 'email'] }]);
    });

    it('allows tools/call by role without requiring additional scopes', async () => {
        const authNode = {
            id: 'auth-1', oauthSlug: 'test-login',
            baseScopes: 'openid profile email',
            readAccessToken: async () => ({
                resource: 'https://mcp.example.test/mcp/test',
                scopes: ['openid'],
                groups: ['team-a']
            })
        };
        const { RED, server } = buildServer({
            auth: 'auth-1',
            allowedGroups: 'team-a',
            __nodes: { 'auth-1': authNode },
            __runtime: { publicBaseUrl: 'https://mcp.example.test' }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'write_tool',
            description: 'Write',
            inputSchema: { type: 'object', properties: {} }
        });
        const res = mockRes();

        server.executeToolFlow = async () => ({ content: [{ type: 'text', text: 'ok' }] });
        await server.handleMcpHttpRequest(mockReq(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_tool', arguments: {} } },
            { authorization: 'Bearer scoped-token' }
        ), res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.result.content[0].text, 'ok');
        assert.strictEqual(res.body.result._meta, undefined);
        assert.strictEqual(server.sent.length, 0);
    });
});

describe('tool-level OAuth discovery', () => {
    function setup(runtime = {}) {
        let reads = 0;
        const auth = {
            id: 'auth-1', oauthSlug: 'test-login',
            readAccessToken: async token => {
                reads++;
                if (token === 'invalid' || token === 'expired') return null;
                return {
                    resource: token === 'wrong-resource' ? 'https://mcp.example.test/mcp/other' : 'https://mcp.example.test/mcp/test',
                    groups: token === 'wrong-role' ? [] : ['operators'], scopes: []
                };
            }
        };
        const context = buildServer({
            auth: auth.id, allowedGroups: 'operators',
            __nodes: { [auth.id]: auth },
            __runtime: { publicBaseUrl: 'https://mcp.example.test', adminPort: 1880,
                credentials: { adminToken: 'test-admin-token' }, adminEndpointPath: '/mcp/test', ...runtime }
        });
        context.RED.events.emit('mcp-tool-register', {
            name: 'protected_tool', description: 'Protected test tool',
            inputSchema: { type: 'object', properties: {} },
            outputSchema: { type: 'object' }
        });
        let executions = 0;
        context.server.executeToolFlow = async () => { executions++; return { content: [{ type: 'text', text: 'ok' }] }; };
        context.server.adminTools.callTool = async () => { executions++; return { content: [{ type: 'text', text: 'ok' }] }; };
        return { ...context, reads: () => reads, executions: () => executions };
    }

    it('exposes only descriptors without validating credentials or executing tools', async () => {
        const context = setup();
        let first;
        for (const token of [null, 'invalid', 'expired', 'wrong-role']) {
            const res = mockRes();
            await context.server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' },
                token ? { authorization: 'Bearer ' + token } : {}), res);
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.result.tools.length, 2);
            for (const tool of res.body.result.tools) {
                assert.deepStrictEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: [] }]);
                assert.deepStrictEqual(tool._meta.securitySchemes, tool.securitySchemes);
                assert.equal(tool.credentials, undefined);
                assert.equal(tool.node, undefined);
            }
            if (first) assert.deepStrictEqual(res.body.result, first);
            first = res.body.result;
        }
        assert.equal(context.reads(), 0);
        assert.equal(context.executions(), 0);
    });

    it('challenges missing, invalid and expired credentials before flow or admin execution, then allows a valid call', async () => {
        const context = setup();
        for (const name of ['protected_tool', 'get_flow']) {
            const request = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: {} } };
            for (const token of [null, 'invalid', 'expired']) {
                const res = mockRes();
                await context.server.handleMcpHttpRequest(mockReq(request,
                    token ? { authorization: 'Bearer ' + token } : {}), res);
                assert.equal(res.statusCode, 200);
                assert.equal(res.body.id, 7);
                assert.equal(res.body.error, undefined);
                assert.equal(res.body.result.isError, true);
                const challenge = res.body.result._meta['mcp/www_authenticate'];
                assert.equal(challenge.length, 1);
                assert.match(challenge[0], /^Bearer resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource\/mcp\/test"/);
                assert.match(challenge[0], /error="invalid_token", error_description="Authentication required"/);
                assert.equal(context.executions(), name === 'protected_tool' ? 0 : 1);
            }
            const valid = mockRes();
            await context.server.handleMcpHttpRequest(mockReq(request, { authorization: 'Bearer valid' }), valid);
            assert.equal(valid.body.result.content[0].text, 'ok');
            assert.equal(valid.body.result._meta, undefined);
        }
        assert.equal(context.executions(), 2);
    });

    it('keeps role and resource failures forbidden without execution or reauthorization challenges', async () => {
        const context = setup();
        for (const token of ['wrong-role', 'wrong-resource']) {
            for (const name of ['protected_tool', 'get_flow']) {
                const res = mockRes();
                await context.server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1,
                    method: 'tools/call', params: { name } }, { authorization: 'Bearer ' + token }), res);
                assert.equal(res.statusCode, 403);
                assert.equal(res.body.result, undefined);
            }
        }
        assert.equal(context.executions(), 0);
    });

    it('fails closed when required auth configuration is unresolved', async () => {
        for (const auth of ['', 'missing-auth']) {
            const { server } = buildServer({ auth });
            assert.throws(() => server.initializeServer(), /auth configuration is required/);
            const res = mockRes();
            await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1,
                method: 'tools/call', params: { name: 'get_flow' } }), res);
            assert.equal(res.statusCode, 503);
            assert.equal(res.body.error, 'auth_not_configured');
            assert.equal(server.sent.length, 0);
        }
    });

    it('does not allow an old public setting to bypass OAuth', async () => {
        const { server } = buildServer({ authMode: 'public' });
        const res = mockRes();
        await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1,
            method: 'tools/call', params: { name: 'get_flow' } }), res);
        assert.equal(res.body.result.isError, true);
        assert.match(res.body.result._meta['mcp/www_authenticate'][0], /invalid_token/);
        assert.equal(server.sent.length, 0);
    });

    it('serves anonymous HTTP discovery and challenges protected HTTP calls', async () => {
        const context = setup({ serverPort: 18114 });
        const server = context.server;
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        const post = async (method, token) => {
            const res = await fetch('http://127.0.0.1:18114/mcp/test', {
                method: 'POST',
                headers: { 'content-type': 'application/json', connection: 'close',
                    ...(token ? { authorization: 'Bearer ' + token } : {}) },
                body: JSON.stringify({ jsonrpc: '2.0', id: 8, method,
                    ...(method === 'tools/call' ? { params: { name: 'protected_tool' } } : {}) })
            });
            return { status: res.status, body: await res.json() };
        };
        try {
            assert.equal((await post('initialize')).status, 200);
            const initialized = await fetch('http://127.0.0.1:18114/mcp/test', {
                method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
            });
            assert.equal(initialized.status, 202);
            assert.equal(await initialized.text(), '');
            const list = await post('tools/list', 'expired');
            assert.equal(list.status, 200);
            assert.equal(list.body.result.tools.length, 2);
            const challenge = await post('tools/call');
            assert.equal(challenge.status, 200);
            assert.equal(challenge.body.result.isError, true);
            assert.match(challenge.body.result._meta['mcp/www_authenticate'][0], /resource_metadata=/);
            assert.equal(context.executions(), 0);
            assert.equal((await post('tools/call', 'wrong-resource')).status, 403);
            assert.equal(context.executions(), 0);
            assert.equal((await post('tools/call', 'valid')).body.result.content[0].text, 'ok');
            assert.equal(context.executions(), 1);
        } finally {
            await new Promise(resolve => server.stopServer(() => resolve()));
        }
    });
});

describe('automatic runtime startup without CORS', () => {
    it('starts shared endpoints after flow startup and can stop and start them again', async () => {
        const context = createRuntime({ __runtime: { serverPort: 18116 } });
        const second = new context.types['mcp-flow-server']({ id: 'endpoint-second',
            runtime: context.runtimeNode.id, auth: 'default-auth', serverPath: '/mcp/second' });
        const endpoints = [context.server, second];
        const start = async () => {
            const pending = endpoints.map(node => new Promise((resolve, reject) => {
                const original = node.startServer;
                node.startServer = () => original(error => {
                    node.startServer = original;
                    if (error) reject(error); else resolve();
                });
            }));
            context.RED.events.emit('flows:started');
            const results = await Promise.allSettled(pending);
            for (const result of results) assert.equal(result.status, 'fulfilled', result.reason && result.reason.message);
        };
        const stop = async () => {
            for (const node of endpoints) await new Promise(resolve => node.stopServer(resolve));
        };
        try {
            assert.equal(context.server.isRunning, false);
            await start();
            for (const node of endpoints) {
                assert.equal(node.isRunning, true);
                const response = await fetch('http://127.0.0.1:18116' + node.serverPath, {
                    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://browser.example.test' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
                });
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('access-control-allow-origin'), null);
                assert.equal(response.headers.get('access-control-allow-methods'), null);
                assert.equal(response.headers.get('access-control-allow-headers'), null);
                await response.json();
            }
            const preflight = await fetch('http://127.0.0.1:18116/mcp/test', { method: 'OPTIONS',
                headers: { origin: 'https://browser.example.test', 'access-control-request-method': 'POST' } });
            assert.equal(preflight.headers.get('access-control-allow-origin'), null);
            await preflight.text();
            const stream = await fetch('http://127.0.0.1:18116/mcp/test/sse');
            assert.equal(stream.status, 404);
            assert.notEqual(stream.headers.get('content-type'), 'text/event-stream');
            await stream.text();
            const keepAlive = await fetch('http://127.0.0.1:18116/mcp/test', { method: 'POST',
                headers: { 'content-type': 'application/json', connection: 'keep-alive' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
            await keepAlive.json();
            const stopped = Date.now();
            await stop();
            assert.ok(Date.now() - stopped < 2000, 'close must not wait for idle keep-alive sockets');
            await start();
            assert.ok(endpoints.every(node => node.isRunning));
        } finally { await stop(); }
    });

    it('can close during startup and reuse the same port with a replacement node', async () => {
        const { RED, server, types, runtimeNode } = createRuntime({ __runtime: { serverPort: 18117 } });
        RED.events.emit('flows:started');
        await new Promise(resolve => server.emit('close', resolve));
        assert.equal(server.isRunning, false);
        const replacement = new types['mcp-flow-server']({ id: 'replacement', runtime: runtimeNode.id,
            auth: 'default-auth', serverPath: '/mcp/test' });
        try {
            await new Promise((resolve, reject) => replacement.startServer(error => error ? reject(error) : resolve()));
            assert.equal(replacement.isRunning, true);
        } finally { await new Promise(resolve => replacement.emit('close', resolve)); }
        assert.equal(RED.events.listenerCount('flows:started'), 0);
    });

    it('removes the startup subscription when closed before startup', async () => {
        const { RED, server } = createRuntime();
        let starts = 0;
        server.startServer = () => { starts++; };
        await new Promise(resolve => server.emit('close', resolve));
        assert.equal(RED.events.listenerCount('flows:started'), 0);
        RED.events.emit('flows:started');
        assert.equal(starts, 0);
    });
});

describe('stable OAuth routes', () => {
    function auth(id, slug = 'test-login') {
        return { id, oauthSlug: slug, baseScopes: 'openid profile email',
            readState: async () => null, readCode: async () => null, readAccessToken: async () => null };
    }

    function setup(authNode, port = 18112) {
        return createRuntime({ auth: authNode.id, __nodes: { [authNode.id]: authNode },
            __runtime: { serverPort: port, publicBaseUrl: 'https://mcp.example.test' } });
    }

    function endpoint(context, authNode, id, path, runtimeId = 'runtime-1') {
        context.nodeMap[authNode.id] = authNode;
        return new context.types['mcp-flow-server']({ id, auth: authNode.id,
            runtime: runtimeId, serverPath: path, serverName: id });
    }

    function start(server) {
        return new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
    }

    function stop(server) {
        return new Promise((resolve, reject) => server.stopServer(error => error ? reject(error) : resolve()));
    }

    it('keeps HTTP discovery stable after replacement and removes old node-ID routes', async () => {
        // The test replaces the listener; do not reuse its old keep-alive sockets.
        const fetch = (url, options = {}) => globalThis.fetch(url, {
            ...options, headers: { ...options.headers, connection: 'close' }
        });
        const oldAuth = auth('old-auth-id');
        const context = setup(oldAuth);
        let active = context.server;
        await start(active);
        try {
            const url = 'http://127.0.0.1:18112';
            const before = await (await fetch(url + '/.well-known/oauth-authorization-server/test-login')).json();
            assert.strictEqual(before.authorization_endpoint, 'https://mcp.example.test/oauth/test-login/authorize');
            assert.strictEqual(before.token_endpoint, 'https://mcp.example.test/oauth/test-login/token');
            assert.strictEqual((await fetch(url + '/oauth/old-auth-id/authorize')).status, 404);
            assert.strictEqual((await fetch(url + '/.well-known/oauth-authorization-server/old-auth-id')).status, 404);
            assert.strictEqual((await fetch(url + '/oauth/unknown/authorize')).status, 404);
            const invalid = await fetch(url + '/oauth/test-login/callback?code=test&state=unknown');
            assert.strictEqual(invalid.status, 400);
            assert.strictEqual((await invalid.json()).error, 'invalid_state');
            await stop(active);
            active = endpoint(context, auth('replacement-auth-id'), 'replacement-endpoint', '/mcp/test');
            await start(active);
            const after = await (await fetch(url + '/.well-known/oauth-authorization-server/test-login')).json();
            assert.deepStrictEqual(after, before);
            assert.strictEqual((await fetch(url + '/oauth/replacement-auth-id/authorize')).status, 404);
            assert.strictEqual((await fetch(url + '/oauth/test-login/authorize')).status, 400);
            assert.strictEqual((await fetch(url + '/oauth/test-login/token', { method: 'POST' })).status, 400);
        } finally { await stop(active); }
    });

    it('rejects conflicting configurations while allowing endpoints to share the same auth node', () => {
        const shared = auth('shared-auth');
        const context = setup(shared);
        context.server.initializeServer();
        const second = endpoint(context, shared, 'second-endpoint', '/mcp/second');
        assert.doesNotThrow(() => second.initializeServer());
        const duplicate = endpoint(context, auth('different-auth'), 'duplicate', '/mcp/duplicate');
        assert.throws(() => duplicate.initializeServer(), /OAuth slug already registered/);
        assert.strictEqual(context.server.portState.routes.has('/mcp/duplicate'), false);
        context.nodeMap['runtime-other'] = new context.types['mcp-runtime']({ id: 'runtime-other',
            serverPort: 18113, publicBaseUrl: 'https://mcp.example.test/' });
        const crossPort = endpoint(context, auth('cross-port-auth'), 'cross-port', '/mcp/other', 'runtime-other');
        assert.throws(() => crossPort.initializeServer(), /OAuth slug already registered/);
        const missing = endpoint(context, { ...auth('missing-slug'), oauthSlug: '' }, 'missing', '/mcp/missing');
        assert.throws(() => missing.initializeServer(), /OAuth slug/);
    });

    it('rejects callback/code records pointing to endpoints bound to another auth configuration', async () => {
        const first = auth('first-auth', 'first-login');
        first.readState = async () => ({ endpointId: 'second-endpoint' });
        first.readCode = async () => ({ endpointId: 'second-endpoint' });
        const context = setup(first, 18114);
        const second = endpoint(context, auth('second-auth', 'second-login'), 'second-endpoint', '/mcp/second');
        await start(context.server);
        await start(second);
        try {
            const url = 'http://127.0.0.1:18114';
            const callback = await fetch(url + '/oauth/first-login/callback?code=test&state=test');
            assert.strictEqual(callback.status, 400);
            assert.strictEqual((await callback.json()).error, 'invalid_state');
            const token = await fetch(url + '/oauth/first-login/token', {
                method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&code=test'
            });
            assert.strictEqual(token.status, 400);
            assert.strictEqual((await token.json()).error, 'invalid_grant');
            assert.strictEqual((await fetch(url + '/.well-known/oauth-authorization-server')).status, 404);
            assert.strictEqual((await fetch(url + '/.well-known/oauth-authorization-server/first-login')).status, 200);
            assert.strictEqual((await fetch(url + '/.well-known/oauth-authorization-server/second-login')).status, 200);
        } finally { await stop(second); await stop(context.server); }
    });
});

describe('Creating Nodes review fixes', () => {
    it('registers the runtime admin token as a password credential', () => {
        const { types } = createRuntime();
        assert.deepStrictEqual(types['options:mcp-runtime'], { credentials: { adminToken: { type: 'password' } } });
        const runtime = new types['mcp-runtime']({ id: 'runtime-cred', credentials: { adminToken: 'from-editor' } });
        assert.strictEqual(runtime.adminToken, 'from-editor');
    });

    it('accepts comma- and whitespace-separated endpoint groups', () => {
        const { server } = createRuntime({ allowedGroups: 'ops admins,  auditors\nreaders' });
        assert.deepStrictEqual(server.allowedGroups, ['ops', 'admins', 'auditors', 'readers']);
    });

    it('protects the editor server listing with a read permission', () => {
        const handlers = {};
        const RED = { events: new EventEmitter(), nodes: { registerType() {} },
            auth: { needsPermission: permission => Object.assign(() => {}, { permission }) },
            httpAdmin: { get(path, ...chain) { handlers[path] = chain; } } };
        delete require.cache[require.resolve('../mcp-flow-server')];
        require('../mcp-flow-server')(RED);
        const chain = handlers['/mcp-flow-servers'];
        assert.strictEqual(chain.length, 2);
        assert.strictEqual(chain[0].permission, 'mcp-flow-server.read');
    });

    it('uses send/done for commands and reports start failures through done', async () => {
        const { server } = createRuntime({ runtime: 'missing-runtime' });
        const sent = [];
        await new Promise(resolve => server.emit('input', { topic: 'status' }, msg => sent.push(msg), resolve));
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].payload.authRequired, true);
        const failure = await new Promise(resolve => server.emit('input', { topic: 'start' }, () => {}, resolve));
        assert.match(failure.message, /MCP runtime is required/);
        const ignored = await new Promise(resolve => server.emit('input', { topic: 'unknown' }, () => {}, resolve));
        assert.strictEqual(ignored, undefined);
    });

    it('cancels a pending restart and sends nothing after close', async () => {
        const { server } = createRuntime({ __runtime: { serverPort: 18118 } });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        server.emit('input', { topic: 'restart' }, () => {}, () => {});
        await new Promise(resolve => setTimeout(resolve, 50));
        const sentBefore = server.sent.length;
        await new Promise(resolve => server.emit('close', resolve));
        await new Promise(resolve => setTimeout(resolve, 1200));
        assert.strictEqual(server.isRunning, false);
        assert.ok(!server.sent.slice(sentBefore).some(msg => msg.topic === 'mcp-server-started'));
    });

    it('does not send stopped events or status while closing', async () => {
        const { server } = createRuntime({ __runtime: { serverPort: 18119 } });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        const sent = server.sent.length;
        const statuses = server.statuses.length;
        await new Promise(resolve => server.emit('close', resolve));
        assert.strictEqual(server.sent.length, sent);
        assert.strictEqual(server.statuses.length, statuses);
    });

    it('reports token storage failures as 503 and logs unknown refresh tokens', async () => {
        const authNode = { id: 'storage-auth', oauthSlug: 'storage-login', baseScopes: 'openid',
            readAccessToken: async () => null, readCode: async () => { throw new Error('redis down'); },
            refreshStore: { read: async token => { if (token === 'boom') throw new Error('redis down'); return null; } } };
        const { server } = createRuntime({ auth: 'storage-auth', __nodes: { 'storage-auth': authNode },
            __runtime: { serverPort: 18120 } });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try {
            const post = body => fetch('http://127.0.0.1:18120/oauth/storage-login/token', { method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
            const outage = await post('grant_type=refresh_token&refresh_token=boom');
            assert.strictEqual(outage.status, 503);
            assert.strictEqual((await outage.json()).error, 'temporarily_unavailable');
            assert.ok(server.errors.some(error => /OAuth token storage error/.test(error)));
            const unknown = await post('grant_type=refresh_token&refresh_token=missing');
            assert.strictEqual(unknown.status, 400);
            assert.strictEqual((await unknown.json()).error, 'invalid_grant');
            assert.ok(server.logs.includes('OAuth refresh: unknown'));
            const code = await post('grant_type=authorization_code&code=x');
            assert.strictEqual(code.status, 503);
        } finally { await new Promise(resolve => server.emit('close', resolve)); }
    });

    it('keeps internal error text out of client responses', async () => {
        const authNode = { id: 'leak-auth', oauthSlug: 'leak-login', baseScopes: 'openid',
            readAccessToken: async () => { throw new Error('secret internal detail'); },
            readState: async () => { throw new Error('secret internal detail'); } };
        const { server } = createRuntime({ auth: 'leak-auth', __nodes: { 'leak-auth': authNode },
            __runtime: { serverPort: 18121 } });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try {
            const url = 'http://127.0.0.1:18121';
            const callback = await fetch(url + '/oauth/leak-login/callback?code=a&state=b');
            assert.strictEqual(callback.status, 503);
            assert.doesNotMatch(await callback.text(), /secret internal detail/);
            const get = await fetch(url + '/mcp/test', { headers: { authorization: 'Bearer x' } });
            assert.strictEqual(get.status, 503);
            assert.doesNotMatch(await get.text(), /secret internal detail/);
            const rpc = await fetch(url + '/mcp/test', { method: 'POST', headers: { 'content-type': 'application/json',
                authorization: 'Bearer x' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                params: { name: 'any' } }) });
            assert.doesNotMatch(await rpc.text(), /secret internal detail/);
            const authorize = await fetch(url + '/oauth/leak-login/authorize?response_type=code&code_challenge_method=S256' +
                '&code_challenge=c&client_id=https%3A%2F%2Fclient.example.test%2Fm.json&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb&state=s');
            assert.doesNotMatch(await authorize.text(), /allowedClientHosts|client_id host/);
        } finally { await new Promise(resolve => server.emit('close', resolve)); }
    });
});
