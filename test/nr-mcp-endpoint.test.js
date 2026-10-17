'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const { prepare, mcpFetch } = require('./helpers/mcp-request');

function createRuntime(config = {}) {
    const types = {};
    const events = new EventEmitter();
    const nodeMap = config.__nodes || {};
    nodeMap['default-auth'] = { id: 'default-auth', oauthSlug: 'default-login',
        baseScopes: 'openid profile email', readAccessToken: async token => token === 'test-token' ?
            { groups: ['test-group'], scopes: ['openid', 'profile', 'email'] } : null };
    const flowNodes = config.__flowNodes || [];
    const configs = [];
    const RED = {
        mcpRuntimes: [],
        events,
        log: { debug() {} },
        settings: config.__settings || {},
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
                node.debug = () => {};
                node.error = e => node.errors.push(e);
                node.warn = w => node.warnings.push(w);
            },
            registerType(name, ctor, options) {
                // Test defaults for settings that production requires (Base URL, endpoint groups).
                const defaults = { 'nr-mcp-runtime': { publicBaseUrl: 'https://mcp.example.test' },
                    'nr-mcp-endpoint': { allowedGroups: 'test-group' } }[name];
                types[name] = function (cfg) {
                    const merged = defaults ? { ...defaults, ...cfg } : cfg;
                    configs.push({ ...merged, type: name });
                    const instance = new ctor(merged);
                    if (name === 'nr-mcp-runtime') RED.mcpRuntimes.push(instance);
                    if ((name === 'nr-mcp-runtime' || name === 'nr-mcp-endpoint') && merged.id) nodeMap[merged.id] = instance;
                    return instance;
                };
                types['options:' + name] = options;
            },
            getNode(id) { return nodeMap[id]; },
            eachNode(callback) { for (const node of [...configs, ...flowNodes]) callback(node); }
        },
        httpAdmin: { get() {} }
    };
    delete require.cache[require.resolve('../nr-mcp-endpoint')];
    require('../nr-mcp-endpoint')(RED);
    require('../nr-mcp-metrics')(RED);
    delete require.cache[require.resolve('../nr-mcp-tool')];
    require('../nr-mcp-tool')(RED);
    RED.types = types;
    RED.delivered = [];
    RED.cancelled = [];
    const runtimeConfig = Object.assign({
        id: 'runtime-1',
        serverPort: 18001,
        bindHost: '127.0.0.1',
        publicBaseUrl: 'https://mcp.example.test'
    }, config.__runtime || {});
    const runtimeNode = new types['nr-mcp-runtime'](runtimeConfig);
    nodeMap[runtimeConfig.id] = runtimeNode;
    const nodeConfig = Object.assign({
        id: 'endpoint-1',
        runtime: runtimeConfig.id,
        auth: 'default-auth',
        serverName: 'test',
        serverPath: '/mcp/test',
        allowedGroups: 'test-group',
    }, config);
    const server = new types['nr-mcp-endpoint'](nodeConfig);
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

function registerTool(RED, tool) {
    const registered = { registeredBy: tool.name + '@' + (tool.endpointId || '*'),
        deliver: msg => RED.delivered.push(msg), cancel: mcp => RED.cancelled.push(mcp), ...tool };
    for (const runtime of RED.mcpRuntimes) runtime.registerTool(registered);
}

function respond(RED, msg) {
    const node = new RED.types['nr-mcp-tool-response']({ id: 'response-' + RED.delivered.length });
    return new Promise(resolve => node.emit('input', msg, () => {}, resolve));
}

function toolResult(result) {
    const { resultType, _meta, ...rest } = result;
    assert.strictEqual(resultType, 'complete');
    const meta = { ..._meta };
    delete meta['io.modelcontextprotocol/serverInfo'];
    return Object.keys(meta).length ? { ...rest, _meta: meta } : rest;
}

function mockReq(body, headers = {}, remoteAddress = '127.0.0.1') {
    const prepared = prepare(body, headers);
    return Object.assign(new EventEmitter(), {
        body: prepared.body,
        headers: Object.assign({ host: 'mcp.example.test' }, prepared.headers),
        path: '/mcp/test',
        socket: { remoteAddress }
    });
}

describe('upstream nr-mcp-endpoint local extensions', () => {
    it('keeps upstream registry tools and advertises _meta.securitySchemes', () => {
        const { RED, server } = buildServer();
        registerTool(RED, {
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
        registerTool(RED, {
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
        registerTool(RED, {
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
        const { types, server } = buildServer();
        new types['nr-mcp-tool']({
            id: 'registry-1',
            toolName: 'read_status',
            scope: 'endpoint',
            endpoint: server.id,
            toolSchema: '{"type":"object","properties":{}}',
            toolBehavior: 'read',
            worldAccess: 'closed'
        });

        const res = mockRes();
        await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' },
            { authorization: 'Bearer test-token' }), res);

        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body.result.tools.find(tool => tool.name === 'read_status').annotations, {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false
        });
    });

    // MCP-REG-1
    it('omits duplicate endpoint tools and restores the remaining owner on unregister', async () => {
        const { types, server, runtimeNode } = buildServer();
        server.initializeServer();
        const first = new types['nr-mcp-tool']({ id: 'duplicate-a', toolName: 'same_tool',
            scope: 'endpoint', endpoint: server.id, toolSchema: '{"type":"object","properties":{}}' });
        const second = new types['nr-mcp-tool']({ id: 'duplicate-b', toolName: 'same_tool',
            scope: 'endpoint', endpoint: server.id, toolSchema: '{"type":"object","properties":{}}' });

        assert.deepStrictEqual(server.registeredTools().map(tool => tool.name), []);
        assert.equal(first.statuses.at(-1).text, 'duplicate');
        assert.equal(second.statuses.at(-1).text, 'duplicate');
        assert.equal(runtimeNode.warnings.filter(message => message.includes('Duplicate MCP tool name')).length, 1);

        await new Promise(resolve => first.emit('close', resolve));
        assert.deepStrictEqual(server.registeredTools().map(tool => tool.registeredBy), ['duplicate-b']);
        assert.equal(second.statuses.at(-1).text, 'registered');
    });

    // MCP-REG-2, MCP-REG-3
    it('uses endpoint tools instead of same-name shared tools and sorts the list deterministically', () => {
        const { RED, server } = buildServer();
        registerTool(RED, { name: 'zeta', description: 'Z', registeredBy: 'z',
            inputSchema: { type: 'object', properties: {} } });
        registerTool(RED, { name: 'same', description: 'Shared', registeredBy: 'shared',
            inputSchema: { type: 'object', properties: {} } });
        registerTool(RED, { name: 'same', description: 'Bound', endpointId: server.id,
            registeredBy: 'bound', inputSchema: { type: 'object', properties: {} } });
        registerTool(RED, { name: 'alpha', description: 'A', registeredBy: 'alpha',
            inputSchema: { type: 'object', properties: {} } });

        const response = mockRes();
        server.handleToolsList({ id: 1 }, response);
        assert.deepStrictEqual(response.body.result.tools.map(tool => tool.name), ['alpha', 'same', 'zeta']);
        assert.equal(response.body.result.tools[1].description, 'Bound');
    });

    it('requires an explicit runtime config node before starting', () => {
        const runtime = createRuntime({ runtime: '' });

        assert.strictEqual(runtime.server.runtime, null);
        assert.strictEqual(runtime.server.serverPort, 0);
        assert.throws(() => runtime.server.initializeServer(), /MCP runtime is required/);
    });

    // MCP-NET-2
    it('listens on all interfaces and warns once when Bind Host is empty', () => {
        const { runtimeNode } = buildServer({ __runtime: { bindHost: '' } });
        assert.equal(runtimeNode.bindHost, '');
        assert.deepStrictEqual(runtimeNode.warnings, [
            'MCP runtime bindHost is not set; listening on all interfaces'
        ]);
    });

    it('uses endpoint fields with runtime transport config', () => {
        const { RED, server, runtimeNode } = buildServer({
            serverName: 'ops',
            serverPath: '/mcp/ops',

            __runtime: { serverPort: 18002 }
        });
        registerTool(RED, {
            name: 'read_status',
            description: 'Read status',
            endpointId: server.id,
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

    it('filters registered tools by endpoint path when a binding is configured', () => {
        const { RED, server } = buildServer({ id: 'alpha-endpoint', serverName: 'alpha' });
        registerTool(RED, {
            name: 'shared_tool',
            description: 'Shared',
            inputSchema: { type: 'object', properties: {} }
        });
        registerTool(RED, {
            name: 'alpha_tool',
            description: 'Alpha',
            endpointId: 'alpha-endpoint',
            inputSchema: { type: 'object', properties: {} }
        });
        registerTool(RED, {
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
        const serverB = new runtime.types['nr-mcp-endpoint']({
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

    // MCP-NODE-5
    it('marks the tools of an endpoint red when a second runtime asks for a port in use', async () => {
        const runtime = createRuntime({
            id: 'endpoint-a',
            serverPath: '/mcp/a',
            __runtime: { id: 'runtime-a', serverPort: 18006, bindHost: '127.0.0.1' }
        });
        const runtimeB = new runtime.types['nr-mcp-runtime']({
            id: 'runtime-b',
            serverPort: 18006,
            bindHost: '127.0.0.1'
        });
        runtime.nodeMap['runtime-b'] = runtimeB;
        const serverB = new runtime.types['nr-mcp-endpoint']({
            id: 'endpoint-b',
            runtime: 'runtime-b',
            auth: 'default-auth',
            serverName: 'b',
            serverPath: '/mcp/b'
        });
        const tool = new runtime.types['nr-mcp-tool']({ id: 'tool-b', toolName: 'tool_b', scope: 'endpoint',
            endpoint: 'endpoint-b', toolSchema: '{"type":"object","properties":{}}' });
        await new Promise((resolve, reject) => runtime.server.startServer(error => error ? reject(error) : resolve()));
        try {
            const failure = await new Promise(resolve => serverB.startServer(error => resolve(error)));
            assert.equal(failure.code, 'EADDRINUSE');
            assert.equal(serverB.isRunning, false);
            assert.equal(serverB.state, 'error');
            assert.deepStrictEqual(tool.statuses.at(-1), { fill: 'red', shape: 'ring', text: 'endpoint error' });
        } finally {
            await new Promise(resolve => serverB.emit('close', resolve));
            await new Promise(resolve => runtime.server.emit('close', resolve));
        }
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

    // MCP-ADM-3
    it('reads the admin API root and host from RED.settings instead of the loopback default', async () => {
        const http = require('node:http');
        const received = [];
        const admin = http.createServer((req, res) => {
            received.push(req.url);
            res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
            res.end(JSON.stringify({ id: 'tab1', label: 'Operations', disabled: false, nodes: [] }));
        });
        await new Promise(resolve => admin.listen(0, '127.0.0.1', resolve));
        const adminPort = admin.address().port;
        try {
            const { server } = buildServer({
                id: 'admin-endpoint', serverPath: '/mcp/ops',
                __settings: { httpAdminRoot: '/admin', uiHost: '127.0.0.1', uiPort: adminPort },
                __runtime: { adminEndpointPath: '/mcp/ops', credentials: { adminToken: 'configured-value' } }
            });
            const flow = (await server.adminTools.callTool('get_flow', { id: 'tab1' })).structuredContent;
            assert.equal(flow.tab.id, 'tab1');
            assert.deepStrictEqual(received, ['/admin/flow/tab1']);
        } finally {
            if (admin.closeAllConnections) admin.closeAllConnections();
            await new Promise(resolve => admin.close(resolve));
        }
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
        const metrics = new types['nr-mcp-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        const response = mockRes();
        await server.handleToolCall({ id: 1, params: { name: 'get_flow', arguments: {} } }, response);

        assert.equal(response.body.result.structuredContent.totalTabs, 1);
        assert.equal(metrics.sent.length, 1);
        assert.equal(metrics.sent[0].topic, 'mcp-tool-telemetry');
        assert.deepStrictEqual(Object.keys(metrics.sent[0].payload).sort(), [
            'cached', 'client', 'durationMs', 'endpoint', 'mode', 'responseBytes', 'scannedNodes', 'status', 'tool', 'user'
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
        const metrics = new types['nr-mcp-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
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

    // MCP-KEEP-6
    it('emits one bounded runtime event for a flow tool call', async () => {
        const { RED, server, runtimeNode, types } = buildServer();
        registerTool(RED, {
            name: 'sample_ping',
            description: 'Sample',
            inputSchema: { type: 'object', properties: {} }
        });
        const metrics = new types['nr-mcp-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        const response = mockRes();
        const pending = server.handleMcpHttpRequest(mockReq({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'sample_ping', arguments: { secret: 'private-argument' } }
        }, { authorization: 'Bearer test-token' }), response);
        await new Promise(resolve => setImmediate(resolve));
        const execution = RED.delivered[0];
        await respond(RED, { payload: { secret: 'private-result' }, mcp: { executionId: execution.mcp.executionId } });
        await pending;

        assert.equal(response.body.result.content[0].text, JSON.stringify({ secret: 'private-result' }));
        assert.equal(metrics.sent.length, 1);
        assert.equal(metrics.sent[0].topic, 'mcp-tool-telemetry');
        assert.deepStrictEqual(Object.keys(metrics.sent[0].payload).sort(), [
            'cached', 'client', 'durationMs', 'endpoint', 'mode', 'responseBytes', 'scannedNodes', 'status', 'tool', 'user'
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

    it('rejects tool calls above the concurrency limit', async () => {
        const { RED, server } = buildServer();
        registerTool(RED, { name: 'slow_tool', description: 'Slow', inputSchema: { type: 'object', properties: {} } });
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        server.executeToolFlow = async () => { await gate; return { ok: true }; };
        const call = id => server.handleToolCall({ id, params: { name: 'slow_tool', arguments: {} } }, mockRes());
        const running = Array.from({ length: 32 }, (_, i) => call(i));
        const rejected = mockRes();
        await server.handleToolCall({ id: 99, params: { name: 'slow_tool', arguments: {} } }, rejected);
        assert.equal(rejected.body.error.code, -32000);
        release();
        await Promise.all(running);
        assert.equal(server.activeToolCalls, 0);
    });

    it('cancels a tool call when the client closes the connection and ignores the late flow response', async () => {
        const { RED, server } = buildServer();
        registerTool(RED, {
            name: 'sample_ping', description: 'Sample', inputSchema: { type: 'object', properties: {} }
        });
        const response = Object.assign(new EventEmitter(), mockRes());
        const pending = server.handleToolCall({ id: 42, params: { name: 'sample_ping', arguments: {} } }, response);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(server.activeToolCalls, 1);
        const execution = RED.delivered[0];

        response.emit('close');
        await pending;
        assert.equal(response.body, undefined, 'no response is written for a closed connection');
        assert.equal(server.activeToolCalls, 0, 'concurrency slot must be released on cancellation');

        assert.deepStrictEqual(RED.cancelled, [{ executionId: execution.mcp.executionId, toolName: 'sample_ping', reason: 'cancelled' }]);
        assert.equal(await respond(RED, { payload: 'late', mcp: { executionId: execution.mcp.executionId } }), undefined,
            'a late response is ignored without an error');
        assert.match((await respond(RED, { payload: 'x', mcp: { executionId: 'unknown-id' } })).message, /Unknown MCP executionId/);
        assert.match((await respond(RED, { payload: 'x' })).message, /executionId is required/);
        assert.equal(server.warnings.length, 0, 'the late response must not raise an Orphan warning');
    });

    // MCP-PROTO-6
    it('tracks flow errors and rejects legacy direct calls', async () => {
        const { RED, server, runtimeNode, types } = buildServer();
        registerTool(RED, {
            name: 'sample_tool',
            description: 'Sample',
            inputSchema: { type: 'object', properties: {} }
        });
        const metrics = new types['nr-mcp-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
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
        registerTool(RED, {
            name: 'write_tool',
            description: 'Write',
            inputSchema: { type: 'object', properties: {} }
        });
        const metrics = new types['nr-mcp-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_tool', arguments: {} } };

        const unauthenticated = mockRes();
        await server.handleMcpHttpRequest(mockReq(request), unauthenticated);
        assert.equal(unauthenticated.statusCode, 401);
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
        registerTool(RED, {
            name: 'sample_ping',
            description: 'Sample',
            inputSchema: { type: 'object', properties: {} }
        });
        const metrics = new types['nr-mcp-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        server.executeToolFlow = async () => { throw new Error('Tool execution timeout'); };
        const response = mockRes();
        await server.handleMcpHttpRequest(mockReq({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'sample_ping', arguments: {} }
        }, { authorization: 'Bearer test-token' }), response);
        assert.equal(response.body.result.isError, true);
        assert.equal(response.body.result.content[0].text, 'Tool execution timeout');
        assert.equal(metrics.sent.length, 1);
        assert.equal(metrics.sent[0].payload.tool, 'sample_ping');
        assert.equal(metrics.sent[0].payload.status, 'failed');
    });

    it('collects tool calls from every endpoint on the selected runtime', async () => {
        const runtime = createRuntime({ id: 'endpoint-a', serverName: 'alpha' });
        const serverB = new runtime.types['nr-mcp-endpoint']({
            id: 'endpoint-b',
            runtime: runtime.runtimeNode.id,
            auth: 'default-auth',
            serverName: 'beta',
            serverPath: '/mcp/b'
        });
        registerTool(runtime.RED, {
            name: 'shared_ping',
            description: 'Shared',
            inputSchema: { type: 'object', properties: {} }
        });
        const metrics = new runtime.types['nr-mcp-metrics']({
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

    it('allows only one metrics source per runtime and releases its subscription on close', async () => {
        const { runtimeNode, types } = buildServer();
        const first = new types['nr-mcp-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        const duplicate = new types['nr-mcp-metrics']({ id: 'metrics-2', runtime: runtimeNode.id });
        assert.deepStrictEqual(duplicate.errors, ['Only one MCP Server Metrics node is allowed per runtime']);

        runtimeNode.publishToolTelemetry({ tool: 'get_flow' });
        assert.equal(first.sent.length, 1);
        assert.equal(duplicate.sent.length, 0);

        first.emit('close');
        const replacement = new types['nr-mcp-metrics']({ id: 'metrics-3', runtime: runtimeNode.id });
        runtimeNode.publishToolTelemetry({ tool: 'get_flow' });
        assert.equal(first.sent.length, 1);
        assert.equal(replacement.sent.length, 1);

        await new Promise(resolve => runtimeNode.emit('close', resolve));
        runtimeNode.publishToolTelemetry({ tool: 'get_flow' });
        assert.equal(replacement.sent.length, 1);
    });

    it('reports a missing metrics runtime without subscribing', () => {
        const { types } = buildServer();
        const metrics = new types['nr-mcp-metrics']({ id: 'metrics-1', runtime: 'missing' });
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
        const metrics = new types['nr-mcp-metrics']({ id: 'metrics-1', runtime: runtimeNode.id });
        metrics.send = () => { throw new Error('metrics unavailable'); };
        const response = mockRes();
        await server.handleToolCall({ id: 1, params: { name: 'get_flow', arguments: {} } }, response);
        await server.handleToolCall({ id: 2, params: { name: 'get_flow', arguments: {} } }, mockRes());
        registerTool(RED, {
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

    // MCP-NAME-2
    it('ignores NODE_RED_ADMIN_API_TOKEN, so admin tools need the credential or Admin Token Env', () => {
        process.env.NODE_RED_ADMIN_API_TOKEN = 'configured-value';
        try
        {
            const { server, runtimeNode } = buildServer({
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
            assert.ok(!res.body.result.tools.some(tool => tool.name === 'get_flow'));
            assert.ok(!runtimeNode.warnings.some(message => message.includes('NODE_RED_ADMIN_API_TOKEN')));
        } finally
        {
            delete process.env.NODE_RED_ADMIN_API_TOKEN;
        }
    });

    // MCP-ADM-4
    it('prioritizes the credential admin token over Admin Token Env', () => {
        process.env.MCP_CUSTOM_ADMIN_TOKEN = 'env-value';
        try
        {
            const { runtimeNode: withCredential, server: credentialServer } = createRuntime({ serverPath: '/mcp/ops', __runtime: {
                id: 'runtime-credential', serverPort: 18008, adminPort: 1881, adminEndpointPath: '/mcp/ops',
                credentials: { adminToken: 'credential-value' }, adminTokenEnv: 'MCP_CUSTOM_ADMIN_TOKEN'
            } });
            assert.equal(withCredential.adminToken, 'credential-value');
            assert.equal(credentialServer.adminToken, 'credential-value');

            const { runtimeNode: withEnvName, server: envServer } = createRuntime({ serverPath: '/mcp/ops', __runtime: {
                id: 'runtime-env-name', serverPort: 18009, adminPort: 1881, adminEndpointPath: '/mcp/ops',
                credentials: { adminToken: '' }, adminTokenEnv: 'MCP_CUSTOM_ADMIN_TOKEN'
            } });
            assert.equal(withEnvName.adminToken, '');
            assert.equal(envServer.adminToken, 'env-value');
        } finally
        {
            delete process.env.MCP_CUSTOM_ADMIN_TOKEN;
        }
    });

    // MCP-ADM-1
    it('advertises and returns Function code only for configured groups', async () => {
        const { server, nodeMap } = buildServer({
            serverPath: '/mcp/ops',
            __runtime: { adminPort: 1881, adminEndpointPath: '/mcp/ops',
                credentials: { adminToken: 'configured-value' }, allowFunctionCode: true,
                codeGroups: 'MCP.CodeReaders' }
        });
        nodeMap['default-auth'].readAccessToken = async () => ({
            groups: ['MCP.CodeReaders'], scopes: ['openid'], subject: 'reader'
        });
        const unprivileged = mockRes();
        server.handleToolsList({ id: 1 }, unprivileged, { groups: ['MCP.Users'] });
        assert.ok(!Object.hasOwn(unprivileged.body.result.tools.find(tool => tool.name === 'get_flow')
            .inputSchema.properties, 'includeCode'));
        const privileged = mockRes();
        server.handleToolsList({ id: 2 }, privileged, { groups: ['MCP.CodeReaders'] });
        assert.ok(Object.hasOwn(privileged.body.result.tools.find(tool => tool.name === 'get_flow')
            .inputSchema.properties, 'includeCode'));
        const deniedCall = mockRes();
        await server.handleToolCall({ id: 3, params: {
            name: 'get_flow', arguments: { includeCode: true }
        } }, deniedCall, { groups: ['MCP.Users'] });
        assert.equal(deniedCall.body.error.code, -32602);
        server.adminTools.callTool = async (name, args, claims) => {
            assert.equal(name, 'get_flow');
            assert.equal(args.includeCode, true);
            assert.ok(server.canIncludeFunctionCode(claims));
            return { content: [] };
        };
        const response = mockRes();
        await server.handleToolCall({ id: 4, params: { name: 'get_flow', arguments: { includeCode: true } } },
            response, { groups: ['MCP.CodeReaders'] });
        assert.equal(response.statusCode, 200);
    });

    it('keeps same tool name isolated across endpoint bindings', () => {
        const { RED, server } = buildServer({ id: 'alpha-endpoint', serverName: 'alpha' });
        registerTool(RED, {
            name: 'status_tool',
            description: 'Alpha status',
            endpointId: 'alpha-endpoint',
            inputSchema: { type: 'object', properties: { alpha: { type: 'boolean' } } }
        });
        registerTool(RED, {
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
        registerTool(RED, {
            name: 'sample_ping',
            description: 'Sample ping',
            inputSchema: { type: 'object', properties: {} }
        });
        const pending = server.handleToolCall({ id: 7, params: { name: 'sample_ping', arguments: { text: 'ok' } } }, mockRes());
        const exec = RED.delivered[0];
        assert.strictEqual(exec.mcp.toolName, 'sample_ping');
        await respond(RED, { payload: { ok: true, received: exec.payload }, mcp: { executionId: exec.mcp.executionId } });
        await pending;
    });

    it('challenges an anonymous server/discover on an OAuth endpoint', async () => {
        const authNode = { id: 'auth-1', oauthSlug: 'test-login', baseScopes: 'openid profile email', readAccessToken: async () => null };
        const { server } = buildServer({
            auth: 'auth-1',
            allowedGroups: 'team-a',
            __nodes: { 'auth-1': authNode },
            __runtime: { publicBaseUrl: 'https://mcp.example.test' }
        });
        const res = mockRes();

        await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'server/discover' }), res);

        assert.strictEqual(res.statusCode, 401);
        assert.match(res.headers['www-authenticate'], /^Bearer resource_metadata=/);
    });

    it('answers GET on the MCP path with 405 and no session stream', async () => {
        const authNode = { id: 'auth-1', oauthSlug: 'test-login', baseScopes: 'openid profile email', readAccessToken: async () => null };
        const { server } = buildServer({
            auth: 'auth-1',
            __nodes: { 'auth-1': authNode },
            __runtime: { serverPort: 18110, publicBaseUrl: 'https://mcp.example.test' }
        });

        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try
        {
            const res = await mcpFetch('http://127.0.0.1:18110/mcp/test', { headers: { host: 'mcp.example.test' } });
            assert.strictEqual(res.status, 405);
            assert.strictEqual(res.headers.get('allow'), 'POST');
            assert.notEqual(res.headers.get('content-type'), 'text/event-stream');
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
            const res = await mcpFetch('http://127.0.0.1:18111/.well-known/oauth-protected-resource', { headers: { host: 'mcp.example.test' } });
            const body = await res.json();
            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.resource, 'https://mcp.example.test/mcp/test');
            assert.deepStrictEqual(body.authorization_servers, ['https://mcp.example.test']);

            const legacy = await mcpFetch('http://127.0.0.1:18111/.well-known/oauth-authorization-server/test-login', { headers: { host: 'mcp.example.test' } });
            assert.strictEqual(legacy.status, 200);

            const pathfulIssuer = await mcpFetch('http://127.0.0.1:18111/.well-known/oauth-authorization-server/oauth/test-login', { headers: { host: 'mcp.example.test' } });
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
            { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            { authorization: 'Bearer configured-value' }
        ), res);
        assert.strictEqual(res.statusCode, 200);

        authNode.readAccessToken = async () => ({ resource: 'https://mcp.example.test/mcp/test', scopes: ['openid'], groups: ['Team C'] });
        const partial = mockRes();
        await server.handleMcpHttpRequest(mockReq(
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            { authorization: 'Bearer configured-value' }
        ), partial);
        assert.strictEqual(partial.statusCode, 403);
    });

    it('allows server/discover with a valid endpoint-scoped access token', async () => {
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
            { jsonrpc: '2.0', id: 1, method: 'server/discover' },
            { authorization: 'Bearer configured-value' }
        ), res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'test');
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
        registerTool(RED, {
            name: 'read_tool',
            description: 'Read',
            inputSchema: { type: 'object', properties: {} }
        });
        registerTool(RED, {
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
        registerTool(RED, {
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
        assert.strictEqual(res.body.result._meta['mcp/www_authenticate'], undefined);
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
        registerTool(context.RED, {
            name: 'protected_tool', description: 'Protected test tool',
            inputSchema: { type: 'object', properties: {} },
            outputSchema: { type: 'object' }
        });
        let executions = 0;
        context.server.executeToolFlow = async () => { executions++; return { content: [{ type: 'text', text: 'ok' }] }; };
        context.server.adminTools.callTool = async () => { executions++; return { content: [{ type: 'text', text: 'ok' }] }; };
        return { ...context, reads: () => reads, executions: () => executions };
    }

    it('requires a valid token for tools/list and answers 401 or 403 otherwise', async () => {
        const context = setup();
        for (const [token, status] of [[null, 401], ['invalid', 401], ['expired', 401], ['wrong-role', 403]]) {
            const res = mockRes();
            await context.server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' },
                token ? { authorization: 'Bearer ' + token } : {}), res);
            assert.equal(res.statusCode, status);
            assert.equal(res.body.result, undefined);
            if (status === 401) assert.match(res.headers['www-authenticate'], /^Bearer resource_metadata=/);
        }
        let first;
        for (const token of ['valid', 'valid']) {
            const res = mockRes();
            await context.server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' },
                { authorization: 'Bearer ' + token }), res);
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
                assert.equal(res.statusCode, 401);
                assert.equal(res.body.error, 'invalid_token');
                assert.match(res.headers['www-authenticate'], /^Bearer resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource\/mcp\/test"/);
                assert.equal(context.executions(), name === 'protected_tool' ? 0 : 1);
            }
            const valid = mockRes();
            await context.server.handleMcpHttpRequest(mockReq(request, { authorization: 'Bearer valid' }), valid);
            assert.equal(valid.body.result.content[0].text, 'ok');
            assert.equal(valid.body.result._meta['mcp/www_authenticate'], undefined);
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

    // MCP-KEEP-1
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
        assert.equal(res.statusCode, 401);
        assert.equal(res.body.error, 'invalid_token');
        assert.equal(server.sent.length, 0);
    });

    // MCP-KEEP-1
    it('challenges every MCP request without a token over HTTP and rejects the legacy handshake', async () => {
        const context = setup({ serverPort: 18114 });
        const server = context.server;
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        const post = async (method, token) => {
            const res = await mcpFetch('http://127.0.0.1:18114/mcp/test', {
                method: 'POST',
                headers: { 'content-type': 'application/json', connection: 'close',
                    ...(token ? { authorization: 'Bearer ' + token } : {}) },
                body: JSON.stringify({ jsonrpc: '2.0', id: 8, method,
                    ...(method === 'tools/call' ? { params: { name: 'protected_tool' } } : {}) })
            });
            return { status: res.status, body: await res.json() };
        };
        try {
            const legacy = await post('initialize');
            assert.equal(legacy.status, 400);
            assert.equal(legacy.body.error.code, -32022);
            assert.deepStrictEqual(legacy.body.error.data.supported, ['2026-07-28']);
            assert.equal((await post('server/discover')).status, 401);
            const notification = await mcpFetch('http://127.0.0.1:18114/mcp/test', {
                method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
            });
            assert.equal(notification.status, 401);
            await notification.text();
            assert.equal((await post('tools/list', 'expired')).status, 401);
            const list = await post('tools/list', 'valid');
            assert.equal(list.status, 200);
            assert.equal(list.body.result.tools.length, 2);
            const challenge = await post('tools/call');
            assert.equal(challenge.status, 401);
            assert.equal(challenge.body.error, 'invalid_token');
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
    // MCP-NET-3
    it('starts shared endpoints after flow startup and can stop and start them again', async () => {
        const context = createRuntime({ __runtime: {
            serverPort: 18116, allowedOrigins: 'https://browser.example.test'
        } });
        const second = new context.types['nr-mcp-endpoint']({ id: 'endpoint-second',
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
                const response = await mcpFetch('http://127.0.0.1:18116' + node.serverPath, {
                    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://browser.example.test',
                        authorization: 'Bearer test-token' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
                });
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('access-control-allow-origin'), null);
                assert.equal(response.headers.get('access-control-allow-methods'), null);
                assert.equal(response.headers.get('access-control-allow-headers'), null);
                await response.json();
            }
            const preflight = await mcpFetch('http://127.0.0.1:18116/mcp/test', { method: 'OPTIONS',
                headers: { origin: 'https://browser.example.test', 'access-control-request-method': 'POST' } });
            assert.equal(preflight.headers.get('access-control-allow-origin'), null);
            await preflight.text();
            const stream = await mcpFetch('http://127.0.0.1:18116/mcp/test/sse');
            assert.equal(stream.status, 404);
            assert.notEqual(stream.headers.get('content-type'), 'text/event-stream');
            await stream.text();
            const keepAlive = await mcpFetch('http://127.0.0.1:18116/mcp/test', { method: 'POST',
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
        const replacement = new types['nr-mcp-endpoint']({ id: 'replacement', runtime: runtimeNode.id,
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

    // MCP-NET-1
    it('keeps a persistent server error listener and reports post-start failures', async () => {
        const { server } = createRuntime({ __runtime: { serverPort: 18118 } });
        try {
            await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
            server.httpServer.emit('error', new Error('simulated socket failure'));
            assert.equal(server.isRunning, false);
            assert.equal(server.state, 'error');
            assert.ok(server.errors.some(message => message.includes('simulated socket failure')));
        } finally {
            await new Promise(resolve => server.emit('close', resolve));
        }
    });

    it('rejects disallowed browser origins before parsing the request body', async () => {
        const { server } = createRuntime({ __runtime: { serverPort: 18119 } });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try {
            const response = await mcpFetch('http://127.0.0.1:18119/mcp/test', {
                method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.test' },
                body: '{invalid-json'
            });
            assert.equal(response.status, 403);
            assert.deepStrictEqual(await response.json(), { error: 'origin_not_allowed' });
        } finally {
            await new Promise(resolve => server.emit('close', resolve));
        }
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
        return new context.types['nr-mcp-endpoint']({ id, auth: authNode.id,
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
        const fetchClose = (target, init = {}) => mcpFetch(target, { ...init, headers: { connection: 'close', ...(init.headers || {}) } });
        const oldAuth = auth('old-auth-id');
        const context = setup(oldAuth);
        let active = context.server;
        await start(active);
        try {
            const url = 'http://127.0.0.1:18112';
            const before = await (await fetchClose(url + '/.well-known/oauth-authorization-server/test-login')).json();
            assert.strictEqual(before.authorization_endpoint, 'https://mcp.example.test/oauth/test-login/authorize');
            assert.strictEqual(before.token_endpoint, 'https://mcp.example.test/oauth/test-login/token');
            assert.strictEqual((await fetchClose(url + '/oauth/old-auth-id/authorize')).status, 404);
            assert.strictEqual((await fetchClose(url + '/.well-known/oauth-authorization-server/old-auth-id')).status, 404);
            assert.strictEqual((await fetchClose(url + '/oauth/unknown/authorize')).status, 404);
            const invalid = await fetchClose(url + '/oauth/test-login/callback?code=test&state=unknown');
            assert.strictEqual(invalid.status, 400);
            assert.strictEqual((await invalid.json()).error, 'invalid_state');
            await stop(active);
            active = endpoint(context, auth('replacement-auth-id'), 'replacement-endpoint', '/mcp/test');
            await start(active);
            const after = await (await fetchClose(url + '/.well-known/oauth-authorization-server/test-login')).json();
            assert.deepStrictEqual(after, before);
            assert.strictEqual((await fetchClose(url + '/oauth/replacement-auth-id/authorize')).status, 404);
            assert.strictEqual((await fetchClose(url + '/oauth/test-login/authorize')).status, 400);
            assert.strictEqual((await fetchClose(url + '/oauth/test-login/token', { method: 'POST' })).status, 400);
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
        context.nodeMap['runtime-other'] = new context.types['nr-mcp-runtime']({ id: 'runtime-other',
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
            const callback = await mcpFetch(url + '/oauth/first-login/callback?code=test&state=test');
            assert.strictEqual(callback.status, 400);
            assert.strictEqual((await callback.json()).error, 'invalid_state');
            const token = await mcpFetch(url + '/oauth/first-login/token', {
                method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&code=test'
            });
            assert.strictEqual(token.status, 400);
            assert.strictEqual((await token.json()).error, 'invalid_grant');
            assert.strictEqual((await mcpFetch(url + '/.well-known/oauth-authorization-server')).status, 404);
            assert.strictEqual((await mcpFetch(url + '/.well-known/oauth-authorization-server/first-login')).status, 200);
            assert.strictEqual((await mcpFetch(url + '/.well-known/oauth-authorization-server/second-login')).status, 200);
        } finally { await stop(second); await stop(context.server); }
    });
});

describe('Creating Nodes review fixes', () => {
    it('registers the runtime admin token as a password credential', () => {
        const { types } = createRuntime();
        assert.deepStrictEqual(types['options:nr-mcp-runtime'], { credentials: { adminToken: { type: 'password' } } });
        const runtime = new types['nr-mcp-runtime']({ id: 'runtime-cred', credentials: { adminToken: 'from-editor' } });
        assert.strictEqual(runtime.adminToken, 'from-editor');
    });

    it('splits endpoint groups on commas and new lines and keeps spaces inside names', () => {
        const { server } = createRuntime({ allowedGroups: 'ops admins,  auditors\nreaders' });
        assert.deepStrictEqual(server.allowedGroups, ['ops admins', 'auditors', 'readers']);
    });

    it('protects the editor server listing with a read permission', () => {
        const handlers = {};
        const RED = { events: new EventEmitter(), nodes: { registerType() {} },
            auth: { needsPermission: permission => Object.assign(() => {}, { permission }) },
            httpAdmin: { get(path, ...chain) { handlers[path] = chain; } } };
        delete require.cache[require.resolve('../nr-mcp-endpoint')];
        require('../nr-mcp-endpoint')(RED);
        const chain = handlers['/nr-mcp-endpoints'];
        assert.strictEqual(chain.length, 2);
        assert.strictEqual(chain[0].permission, 'nr-mcp-endpoint.read');
    });

    // MCP-NODE-3
    it('takes no input messages, so start, stop and restart commands do not exist', () => {
        const { server } = createRuntime();
        assert.strictEqual(server.listenerCount('input'), 0);
    });

    it('sends nothing and sets no node status while starting and closing', async () => {
        const { server } = createRuntime({ __runtime: { serverPort: 18119 } });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        assert.equal(server.state, 'running');
        await new Promise(resolve => server.emit('close', resolve));
        assert.deepStrictEqual(server.sent, []);
        assert.deepStrictEqual(server.statuses, []);
    });

    it('reports token storage failures as 503 and logs unknown refresh tokens', async () => {
        const authNode = { id: 'storage-auth', oauthSlug: 'storage-login', baseScopes: 'openid',
            readAccessToken: async () => null, readCode: async () => { throw new Error('redis down'); },
            refreshStore: { read: async token => { if (token === 'boom') throw new Error('redis down'); return null; } } };
        const { server } = createRuntime({ auth: 'storage-auth', __nodes: { 'storage-auth': authNode },
            __runtime: { serverPort: 18120 } });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try {
            const post = body => mcpFetch('http://127.0.0.1:18120/oauth/storage-login/token', { method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
            const outage = await post('grant_type=refresh_token&refresh_token=boom');
            assert.strictEqual(outage.status, 503);
            assert.strictEqual((await outage.json()).error, 'temporarily_unavailable');
            assert.ok(server.errors.some(error => /OAuth token storage error/.test(error)));
            const unknown = await post('grant_type=refresh_token&refresh_token=missing');
            assert.strictEqual(unknown.status, 400);
            assert.strictEqual((await unknown.json()).error, 'invalid_grant');
            assert.ok(server.logs.some(line => /"event":"oauth.refresh","outcome":"unknown"/.test(line)));
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
            const callback = await mcpFetch(url + '/oauth/leak-login/callback?code=a&state=b');
            assert.strictEqual(callback.status, 503);
            assert.doesNotMatch(await callback.text(), /secret internal detail/);
            const get = await mcpFetch(url + '/mcp/test', { headers: { authorization: 'Bearer x' } });
            assert.strictEqual(get.status, 405);
            assert.doesNotMatch(await get.text(), /secret internal detail/);
            const rpc = await mcpFetch(url + '/mcp/test', { method: 'POST', headers: { 'content-type': 'application/json',
                authorization: 'Bearer x' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                params: { name: 'any' } }) });
            assert.doesNotMatch(await rpc.text(), /secret internal detail/);
            const authorize = await mcpFetch(url + '/oauth/leak-login/authorize?response_type=code&code_challenge_method=S256' +
                '&code_challenge=c&client_id=https%3A%2F%2Fclient.example.test%2Fm.json&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb&state=s');
            assert.doesNotMatch(await authorize.text(), /allowedClientHosts|client_id host/);
        } finally { await new Promise(resolve => server.emit('close', resolve)); }
    });
});

describe('3.0 configuration rules', () => {
    it('binds Endpoint tools to the endpoint node id so a redeployed endpoint keeps them', () => {
        const { RED, types, server, runtimeNode } = buildServer({ id: 'stable-endpoint', serverPath: '/mcp/stable' });
        new types['nr-mcp-tool']({ id: 'tool-1', toolName: 'stable_tool', scope: 'endpoint', endpoint: 'stable-endpoint',
            toolSchema: '{"type":"object","properties":{}}' });
        const replacement = new types['nr-mcp-endpoint']({ id: 'stable-endpoint', runtime: runtimeNode.id,
            auth: 'default-auth', serverPath: '/mcp/renamed' });
        const other = new types['nr-mcp-endpoint']({ id: 'other-endpoint', runtime: runtimeNode.id,
            auth: 'default-auth', serverPath: '/mcp/stable' });
        assert.ok(RED.types['nr-mcp-tool-response']);
        assert.deepStrictEqual(server.registeredTools().map(tool => tool.name), ['stable_tool']);
        assert.deepStrictEqual(replacement.registeredTools().map(tool => tool.name), ['stable_tool']);
        assert.deepStrictEqual(other.registeredTools(), []);
    });

    it('delivers tool calls through the tool node and serves no /health route', async () => {
        const { RED, server } = buildServer({ __runtime: { serverPort: 18131 } });
        registerTool(RED, { name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try {
            const health = await mcpFetch('http://127.0.0.1:18131/health');
            assert.strictEqual(health.status, 404);
            await health.text();
            const pending = server.handleToolCall({ id: 1, params: { name: 'ping', arguments: {} } }, mockRes());
            const exec = RED.delivered[0];
            await respond(RED, { payload: 'ok', mcp: { executionId: exec.mcp.executionId } });
            await pending;
        } finally { await new Promise(resolve => server.emit('close', resolve)); }
        assert.deepStrictEqual(server.sent, []);
        assert.equal(RED.delivered.length, 1);
    });
});

describe('protocol version header and JSON-RPC batch handling', () => {
    it('validates the protocol version and the mirrored request headers', async () => {
        const { server, nodeMap } = createRuntime({ __runtime: { serverPort: 18150 } });
        nodeMap['default-auth'].readAccessToken = async () => ({ groups: ['test-group'], scopes: ['openid'] });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try {
            const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
            const call = async (headers, body) => {
                const res = await mcpFetch('http://127.0.0.1:18150/mcp/test', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token', 'x-test-raw': '1', ...headers },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body })
                });
                return { status: res.status, body: await res.json() };
            };
            const list = { method: 'tools/list', params: { _meta: meta } };
            const modern = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' };
            assert.equal((await call(modern, list)).status, 200);
            const unsupported = await call({ ...modern, 'mcp-protocol-version': '2025-11-25' }, { method: 'tools/list',
                params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } } });
            assert.equal(unsupported.status, 400);
            assert.deepStrictEqual(unsupported.body.error.data, { supported: ['2026-07-28'], requested: '2025-11-25' });
            assert.equal((await call({ 'mcp-method': 'tools/list' }, list)).body.error.code, -32020);
            assert.equal((await call({ ...modern, 'mcp-method': 'tools/call' }, list)).body.error.code, -32020);
            const toolCall = { method: 'tools/call', params: { name: 'ping', arguments: {}, _meta: meta } };
            const callHeaders = { ...modern, 'mcp-method': 'tools/call' };
            assert.equal((await call({ ...callHeaders, 'mcp-name': 'other' }, toolCall)).body.error.code, -32020);
            const encoded = await call({ ...callHeaders, 'mcp-name': '=?base64?' + Buffer.from('ping').toString('base64') + '?=' }, toolCall);
            assert.notEqual(encoded.body.error && encoded.body.error.code, -32020);
            const unknown = await call({ ...modern, 'mcp-method': 'resources/list' }, { method: 'resources/list', params: { _meta: meta } });
            assert.equal(unknown.status, 404);
            assert.equal(unknown.body.error.code, -32601);
        } finally { await new Promise(resolve => server.emit('close', resolve)); }
    });

    // MCP-PROTO-5
    it('rejects DELETE on the MCP path with 405 and JSON-RPC batch arrays with -32600', async () => {
        const { server } = createRuntime({ __runtime: { serverPort: 18151 } });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try {
            const deleted = await mcpFetch('http://127.0.0.1:18151/mcp/test', { method: 'DELETE' });
            assert.equal(deleted.status, 405);
            assert.equal((await deleted.json()).error, 'method_not_allowed');

            const batch = await mcpFetch('http://127.0.0.1:18151/mcp/test', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
            });
            assert.equal(batch.status, 400);
            assert.deepStrictEqual(await batch.json(), {
                jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' }
            });
        } finally { await new Promise(resolve => server.emit('close', resolve)); }
    });
});

describe('audit log and OAuth hardening', () => {
    const events = (lines, name) => lines.map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(entry => entry && entry.event === name);

    // MCP-KEEP-6
    it('audits tool calls with the caller and passes the identity to the flow, never the arguments', async () => {
        const { RED, server, nodeMap } = createRuntime();
        nodeMap['default-auth'].readAccessToken = async token => token === 'test-token' ? { groups: ['test-group'],
            scopes: ['openid'], subject: 'user-1', email: 'user@example.test', client_id: 'https://claude.ai/meta', sessionId: 'session-1' } : null;
        nodeMap['default-auth'].refreshStore = { readSession: async () => ({ expiresAt: Date.now() + 60000, idleExpiresAt: Date.now() + 60000 }) };
        registerTool(RED, { name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } });
        const res = mockRes();
        const pending = server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'ping', arguments: { secret: 'argument-value' } } }, { authorization: 'Bearer test-token' }), res);
        await new Promise(resolve => setImmediate(resolve));
        const exec = RED.delivered[0];
        assert.deepStrictEqual(exec.mcp, { executionId: exec.mcp.executionId, toolName: 'ping', subject: 'user-1',
            email: 'user@example.test', groups: ['test-group'], client: 'https://claude.ai/meta' });
        assert.deepStrictEqual(exec.payload, { secret: 'argument-value' });
        await respond(RED, { payload: 'ok', mcp: { executionId: exec.mcp.executionId } });
        await pending;
        const [call] = events(server.logs, 'mcp.tool_call');
        assert.strictEqual(call.outcome, 'success');
        assert.strictEqual(call.subject, 'user-1');
        assert.strictEqual(call.client, 'https://claude.ai/meta');
        assert.match(call.session, /^[0-9a-f]{12}$/);
        assert.ok(!server.logs.join('\n').includes('argument-value'));
        assert.ok(!server.logs.join('\n').includes('session-1'));
    });

    it('audits rejected tokens but not the anonymous start of sign-in', async () => {
        const { server } = createRuntime({ __runtime: { trustedProxies: '127.0.0.1/32' } });
        await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } }), mockRes());
        assert.strictEqual(events(server.logs, 'mcp.auth').length, 0);
        await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } },
            { authorization: 'Bearer stolen', 'x-forwarded-for': '203.0.113.5' }), mockRes());
        const [denied] = events(server.logs, 'mcp.auth');
        assert.strictEqual(denied.reason, 'invalid_token');
        assert.strictEqual(denied.ip, '203.0.113.5');
        assert.ok(!server.logs.join('\n').includes('stolen'));
    });

    // MCP-STO-2
    it('ignores a forwarded header from a socket that is not a trusted proxy', async () => {
        const { server } = createRuntime({ __runtime: { trustedProxies: '198.51.100.1/32' } });
        await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } },
            { authorization: 'Bearer invalid-test-token', 'x-forwarded-for': '203.0.113.5' }, '192.0.2.9'), mockRes());
        const [denied] = events(server.logs, 'mcp.auth');
        assert.strictEqual(denied.ip, '192.0.2.9');
    });

    // MCP-STO-2
    it('resolves the original client address from a two-hop forwarded chain behind trusted proxies', async () => {
        const { server } = createRuntime({ __runtime: { trustedProxies: '127.0.0.1/32,10.0.0.0/8' } });
        await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } },
            { authorization: 'Bearer invalid-test-token', 'x-forwarded-for': '203.0.113.5, 10.0.0.2' }), mockRes());
        const [denied] = events(server.logs, 'mcp.auth');
        assert.strictEqual(denied.ip, '203.0.113.5');
    });

    // MCP-KEEP-1
    it('refuses to start without a Base URL or without groups', () => {
        assert.throws(() => createRuntime({ __runtime: { publicBaseUrl: '' } }).server.initializeServer(), /Base URL is required/);
        assert.throws(() => createRuntime({ allowedGroups: '' }).server.initializeServer(), /Groups are required/);
    });

    it('answers server/discover with 2026-07-28, identity, capabilities and cache hints', () => {
        const { server } = createRuntime();
        const res = mockRes();
        server.handleDiscover({ id: 1 }, res);
        assert.deepStrictEqual(res.body.result.supportedVersions, ['2026-07-28']);
        assert.equal(res.body.result.resultType, 'complete');
        assert.equal(res.body.result._meta['io.modelcontextprotocol/serverInfo'].version, require('../package.json').version);
        assert.equal(res.body.result.cacheScope, 'private');
        assert.ok(Number.isInteger(res.body.result.ttlMs));
    });

    // MCP-PROTO-3
    it('does not advertise tool list changes since the package never sends them', () => {
        const { server } = createRuntime();
        const res = mockRes();
        server.handleDiscover({ id: 1 }, res);
        assert.deepStrictEqual(res.body.result.capabilities.tools, {});
    });

    // MCP-HTTP-1
    it('rejects oversized JSON bodies before routing', async () => {
        const { server } = createRuntime({ __runtime: { serverPort: 18140 } });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try {
            const res = await mcpFetch('http://127.0.0.1:18140/mcp/test', { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', pad: 'secret-body-marker-' + 'x'.repeat(300 * 1024) }) });
            assert.strictEqual(res.status, 413);
            assert.match(res.headers.get('content-type'), /application\/json/);
            assert.deepStrictEqual(await res.json(), {
                jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' }
            });
            assert.ok(!server.errors.join('\n').includes('secret-body-marker'));
        } finally { await new Promise(resolve => server.emit('close', resolve)); }
    });

    // MCP-HTTP-2, MCP-HTTP-3
    it('returns sanitized JSON errors for invalid JSON and unexpected MCP route exceptions', async () => {
        const { server } = createRuntime({ __runtime: { serverPort: 18141 } });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try {
            const malformed = await mcpFetch('http://127.0.0.1:18141/mcp/test', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid-json'
            });
            assert.equal(malformed.status, 400);
            assert.match(malformed.headers.get('content-type'), /application\/json/);
            assert.deepStrictEqual(await malformed.json(), {
                jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' }
            });

            server.handleMcpHttpRequest = async () => { throw new Error('internal route marker'); };
            const failed = await mcpFetch('http://127.0.0.1:18141/mcp/test', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
            });
            const body = await failed.json();
            assert.equal(failed.status, 500);
            assert.equal(body.error.code, -32603);
            assert.equal(body.error.message, 'Internal error');
            assert.ok(body.error.data.requestId);
            assert.ok(server.errors.some(message => message.includes(body.error.data.requestId) &&
                message.includes('internal route marker')));
            assert.ok(!JSON.stringify(body).includes('internal route marker'));

            const oauthMalformed = await mcpFetch('http://127.0.0.1:18141/oauth/default-login/token', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid-json'
            });
            assert.equal(oauthMalformed.status, 400);
            assert.match(oauthMalformed.headers.get('content-type'), /application\/json/);
            assert.deepStrictEqual(await oauthMalformed.json(), { error: 'invalid_request' });

            const oauthTooLarge = await mcpFetch('http://127.0.0.1:18141/oauth/default-login/token', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ code: 'secret-oauth-marker-' + 'x'.repeat(300 * 1024) })
            });
            assert.equal(oauthTooLarge.status, 413);
            assert.deepStrictEqual(await oauthTooLarge.json(), { error: 'invalid_request' });
            assert.ok(!server.errors.join('\n').includes('secret-oauth-marker'));
        } finally {
            await new Promise(resolve => server.emit('close', resolve));
        }
    });

    // MCP-HTTP-4
    it('returns retryable 503 when token validation storage fails', async () => {
        const { server, nodeMap } = createRuntime();
        nodeMap['default-auth'].readAccessToken = async () => { throw new Error('Redis unavailable'); };
        const response = mockRes();
        await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 7, method: 'tools/list' },
            { authorization: 'Bearer test-token' }), response);
        assert.equal(response.statusCode, 503);
        assert.equal(response.headers['retry-after'], '1');
        assert.equal(response.body.error.code, -32603);
        assert.equal(response.body.error.message, 'Service unavailable');
    });
});

describe('tool result tolerance', () => {
    async function call(response) {
        const { RED, server } = createRuntime();
        registerTool(RED, { name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } });
        const res = mockRes();
        const pending = server.handleToolCall({ id: 1, params: { name: 'ping', arguments: {} } }, res);
        const exec = RED.delivered[0];
        await respond(RED, { payload: response.result, mcp: { executionId: exec.mcp.executionId, error: response.error } });
        await pending;
        return res.body;
    }

    it('maps undefined to empty content, Buffers to text and error objects to their message', async () => {
        assert.deepStrictEqual(toolResult((await call({ result: undefined })).result), { content: [] });
        assert.deepStrictEqual(toolResult((await call({ result: Buffer.from('hello') })).result), { content: [{ type: 'text', text: 'hello' }] });
        const errored = await call({ error: { message: 'catch message' } });
        assert.strictEqual(errored.result.isError, true);
        assert.strictEqual(errored.result.content[0].text, 'catch message');
    });
});

describe('telemetry identity', () => {
    it('reports the caller e-mail and a bounded client label in tool telemetry', async () => {
        const { RED, server, nodeMap, runtimeNode } = createRuntime();
        nodeMap['default-auth'].readAccessToken = async () => ({ groups: ['test-group'], scopes: ['openid'],
            subject: 'user-1', email: 'user@example.test', client_id: 'https://chatgpt.com/oauth/codex/abc/client.json' });
        const events = [];
        runtimeNode.subscribeToolTelemetry(event => events.push(event));
        registerTool(RED, { name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } });
        const pending = server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'ping', arguments: {} } }, { authorization: 'Bearer any' }), mockRes());
        await new Promise(resolve => setImmediate(resolve));
        const exec = RED.delivered[0];
        await respond(RED, { payload: 'ok', mcp: { executionId: exec.mcp.executionId } });
        await pending;
        assert.strictEqual(events[0].user, 'user@example.test');
        assert.strictEqual(events[0].client, 'codex');
        await server.handleMcpHttpRequest(mockReq({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping' } }), mockRes());
        assert.strictEqual(events[1].user, 'unknown');
        assert.strictEqual(events[1].client, 'unknown');
    });
});


describe('notifications and endpoint limits', () => {
    // MCP-PROTO-4
    it('acknowledges authenticated cancellation and unknown notifications with 202 and no warning', async () => {
        const { server } = createRuntime({ __runtime: { serverPort: 18160 } });
        await new Promise((resolve, reject) => server.startServer(error => error ? reject(error) : resolve()));
        try {
            for (const method of ['notifications/cancelled', 'notifications/something-new']) {
                const res = await mcpFetch('http://127.0.0.1:18160/mcp/test', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
                    body: JSON.stringify({ jsonrpc: '2.0', method, params: { requestId: 'none' } })
                });
                assert.strictEqual(res.status, 202);
                assert.strictEqual(await res.text(), '');
            }
            assert.deepStrictEqual(server.warnings, []);
        } finally { await new Promise(resolve => server.emit('close', resolve)); }
    });

    // MCP-LIFE-2
    it('rejects endpoint tool timeout and concurrency values outside their bounds and keeps the defaults', () => {
        for (const config of [{ toolTimeoutMs: 999 }, { toolTimeoutMs: 600001 }, { toolTimeoutMs: 'abc' }]) {
            const { server } = createRuntime({ ...config });
            assert.match(server.configError, /Tool Timeout/);
            assert.strictEqual(server.toolTimeoutMs, 30000);
        }
        for (const config of [{ maxConcurrentCalls: 0 }, { maxConcurrentCalls: 1025 }, { maxConcurrentCalls: 1.5 }]) {
            const { server } = createRuntime({ ...config });
            assert.match(server.configError, /Max Concurrent Calls/);
            assert.strictEqual(server.maxConcurrentCalls, 32);
        }
        const bounds = createRuntime({ toolTimeoutMs: 1000, maxConcurrentCalls: 1024 }).server;
        assert.strictEqual(bounds.configError, undefined);
        assert.strictEqual(bounds.toolTimeoutMs, 1000);
        const defaults = createRuntime().server;
        assert.strictEqual(defaults.toolTimeoutMs, 30000);
        assert.strictEqual(defaults.maxConcurrentCalls, 32);
    });
});

describe('notifications and client messages', () => {
    const send = (server, body, headers) => {
        const res = mockRes();
        res.end = function () { this.ended = true; return this; };
        return server.handleMcpHttpRequest(mockReq(body, headers), res).then(() => res);
    };

    // MCP-PROTO-4
    it('accepts authenticated notifications with 202 and challenges anonymous ones', async () => {
        const { server } = createRuntime();
        const accepted = await send(server, { jsonrpc: '2.0', method: 'notifications/unknown' }, { authorization: 'Bearer test-token' });
        assert.strictEqual(accepted.statusCode, 202);
        assert.strictEqual(accepted.body, undefined);
        assert.strictEqual((await send(server, { jsonrpc: '2.0', method: 'notifications/unknown' }, {})).statusCode, 401);
    });

    it('rejects JSON-RPC responses from the client', async () => {
        const { server } = createRuntime();
        const res = await send(server, { jsonrpc: '2.0', id: 3, result: {} }, { authorization: 'Bearer test-token' });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error.code, -32600);
    });
});
