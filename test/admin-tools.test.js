'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminTools } = require('../lib/admin-tools');

function build(handlers) {
    const calls = [];
    const httpRequest = async (method, hostname, port, path, headers) => {
        calls.push({ method, hostname, port, path, headers });
        const handler = handlers[method + ' ' + path] || handlers[method + ' ' + path.replace(/\/flow\/[^/]+$/, '/flow/:id')];
        if (!handler) throw new Error('unmocked request: ' + method + ' ' + path);
        return handler({ path });
    };
    const tools = createAdminTools({ adminPort: 1880, getAdminToken: () => 'configured-value', httpRequest });
    return { tools, calls };
}

const tab = {
    id: 'tab1',
    label: 'Operations',
    disabled: false,
    nodes: [
        { id: 'g1', type: 'group', name: 'Pipeline', nodes: ['n1', 'n2'] },
        { id: 'n1', type: 'function', name: 'Prepare', g: 'g1', func: 'const secret = "never by default";', wires: [['n2']] },
        { id: 'n2', type: 'debug', name: 'Inspect', g: 'g1', wires: [] },
        { id: 'n3', type: 'link call', name: 'Dispatch', links: ['remote1'], wires: [] },
        { id: 'n4', type: 'subflow:sf1', name: 'Reusable', wires: [] }
    ],
    configs: [{ id: 'cfg', type: 'redis-config', password: 'private' }]
};

describe('lib/admin-tools', () => {
    it('exposes only read-only bounded navigation', () => {
        const { tools } = build({});
        assert.deepEqual(tools.TOOLS.map(tool => tool.name), ['get_flow']);
        assert.deepEqual(tools.TOOLS[0].inputSchema.properties.mode.enum,
            ['tabs', 'tab_summary', 'group', 'chain', 'node', 'subflows', 'subflow']);
        assert.deepEqual(tools.TOOLS[0].outputSchema.required, ['mode', 'source', 'meta']);
        assert.ok(!tools.TOOL_NAMES.has('deploy_flow'));
    });

    it('lists tabs in one pass, pages results and caches the expensive read', async () => {
        const all = Array.from({ length: 45 }, (_, i) => ({
            id: 'tab' + i, type: 'tab', label: 'Tab ' + i
        }));
        all.push({ id: 'n1', type: 'function', z: 'tab0', func: 'private code' });
        const { tools, calls } = build({ 'GET /flows': () => ({ status: 200, body: { rev: '1', flows: all } }) });
        const first = await tools.callTool('get_flow', {});
        assert.equal(first.structuredContent.mode, 'tabs');
        assert.equal(first.structuredContent.tabs.length, 40);
        assert.equal(first.structuredContent.tabs[0].nodeCount, 1);
        assert.equal(first.structuredContent.meta.scannedNodes, 46);
        assert.equal(first.structuredContent.meta.nextOffset, 40);
        assert.equal(first.structuredContent.meta.cached, false);
        assert.ok(!JSON.stringify(first).includes('private code'));
        const second = await tools.callTool('get_flow', { mode: 'tabs', offset: 40 });
        assert.equal(second.structuredContent.tabs.length, 5);
        assert.equal(second.structuredContent.meta.cached, true);
        assert.equal(calls.length, 1);
        assert.deepEqual(JSON.parse(first.content[0].text), first.structuredContent);
    });

    it('summarizes one tab without returning raw configuration', async () => {
        const { tools, calls } = build({ 'GET /flow/tab1': () => ({ status: 200, body: tab }) });
        const response = await tools.callTool('get_flow', { id: 'tab1' });
        const data = response.structuredContent;
        assert.equal(data.tab.nodeCount, 5);
        assert.equal(data.tab.groupCount, 1);
        assert.equal(data.tab.chainCount, 3);
        assert.equal(data.groups[0].nodeCount, 2);
        assert.equal(data.typeCounts.function, 1);
        assert.equal(data.keyNodes.length, 3);
        assert.equal(data.meta.scannedNodes, 5);
        assert.equal(data.meta.codeOmitted, true);
        assert.equal(data.flow, undefined);
        assert.ok(!JSON.stringify(response).includes('private'));
        assert.deepEqual(calls.map(call => call.path), ['/flow/tab1']);
    });

    it('inspects a group and a connected chain using direct wires', async () => {
        const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200, body: tab }) });
        const group = (await tools.callTool('get_flow', { mode: 'group', id: 'tab1', groupId: 'g1' })).structuredContent;
        assert.deepEqual(group.nodes.map(node => node.id), ['n1', 'n2']);
        assert.deepEqual(group.edges, [{ from: 'n1', to: 'n2', port: 0 }]);
        const chain = (await tools.callTool('get_flow', { mode: 'chain', id: 'tab1', nodeId: 'n2' })).structuredContent;
        assert.deepEqual(chain.nodes.map(node => node.id), ['n1', 'n2']);
        assert.equal(chain.chain.nodeCount, 2);
    });

    it('omits code and arbitrary config; explicit code is capped', async () => {
        const large = { ...tab, nodes: tab.nodes.map(node =>
            node.id === 'n1' ? { ...node, func: 'x'.repeat(5000), password: 'hidden' } : node
        ) };
        const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200, body: large }) });
        const normal = (await tools.callTool('get_flow', { mode: 'node', id: 'tab1', nodeId: 'n1' })).structuredContent;
        assert.deepEqual(normal.outgoing, [{ from: 'n1', to: 'n2', port: 0 }]);
        assert.equal(normal.node.code, undefined);
        assert.ok(!JSON.stringify(normal).includes('hidden'));
        const explicit = (await tools.callTool('get_flow', {
            mode: 'node', id: 'tab1', nodeId: 'n1', includeCode: true
        })).structuredContent;
        assert.equal(explicit.node.code.length, 2000);
        assert.equal(explicit.node.codeTruncated, true);
        assert.equal(explicit.meta.truncated, true);
        assert.equal(explicit.meta.codeOmitted, false);
        const link = (await tools.callTool('get_flow', { mode: 'node', id: 'tab1', nodeId: 'n3' })).structuredContent;
        assert.deepEqual(link.node.linkIds, ['remote1']);
        const httpNode = { id: 'http1', type: 'http in', name: 'Request', method: 'post', url: '/api/items', wires: [] };
        const withHttp = build({ 'GET /flow/tab1': () => ({ status: 200, body: { ...tab, nodes: [...tab.nodes, httpNode] } }) });
        const httpResult = (await withHttp.tools.callTool('get_flow', { mode: 'node', id: 'tab1', nodeId: 'http1' })).structuredContent;
        assert.deepEqual(httpResult.node.config, { method: 'post', route: '/api/items' });
    });

    it('lists definitions from global and finds usages only in an explicit tab', async () => {
        const { tools, calls } = build({
            'GET /flow/global': () => ({
                status: 200,
                body: { id: 'global', nodes: [], subflows: [{ id: 'sf1', name: 'Reusable', nodes: [
                    { id: 's1', type: 'function', func: 'internal code', wires: [] }
                ], in: [{}], out: [{}] }] }
            }),
            'GET /flow/tab1': () => ({ status: 200, body: tab })
        });
        const index = (await tools.callTool('get_flow', { mode: 'subflows' })).structuredContent;
        assert.equal(index.subflows[0].nodeCount, 1);
        const definition = (await tools.callTool('get_flow', {
            mode: 'subflow', subflowId: 'sf1', id: 'tab1'
        })).structuredContent;
        assert.equal(definition.subflow.inputs, 1);
        assert.deepEqual(definition.usages.map(node => node.id), ['n4']);
        assert.equal(definition.meta.scannedNodes, 6);
        assert.ok(!JSON.stringify(definition).includes('internal code'));
        assert.deepEqual(calls.map(call => call.path), ['/flow/global', '/flow/global', '/flow/tab1']);
    });

    it('validates IDs and modes before reading and returns bounded not-found errors', async () => {
        const { tools, calls } = build({ 'GET /flow/:id': () => ({ status: 404, body: '' }) });
        await assert.rejects(() => tools.callTool('get_flow', { mode: 'node', id: '../bad', nodeId: 'n1' }),
            error => error.rpcCode === -32602);
        await assert.rejects(() => tools.callTool('get_flow', { mode: 'raw', id: 'tab1' }),
            error => error.rpcCode === -32602);
        await assert.rejects(() => tools.callTool('get_flow', { mode: 'node', id: 'tab1' }),
            error => error.rpcCode === -32602);
        await assert.rejects(() => tools.callTool('get_flow', { mode: 'tabs', id: 'tab1' }),
            error => error.rpcCode === -32602);
        const missing = await tools.callTool('get_flow', { mode: 'tab_summary', id: 'missing' });
        assert.equal(missing.isError, true);
        assert.equal(missing.structuredContent.error.code, 'FLOW_NOT_FOUND');
        assert.equal(calls.length, 1);
    });

    it('pages large groups without leaking off-page nodes', async () => {
        const nodes = [{ id: 'g1', type: 'group', name: 'Large' }];
        for (let i = 0; i < 55; i++) nodes.push({ id: 'n' + i, type: 'function', g: 'g1', func: 'hidden', wires: [] });
        const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200, body: { id: 'tab1', nodes } }) });
        const first = (await tools.callTool('get_flow', { mode: 'group', id: 'tab1', groupId: 'g1' })).structuredContent;
        assert.equal(first.nodes.length, 40);
        assert.equal(first.meta.nextOffset, 40);
        const second = (await tools.callTool('get_flow', { mode: 'group', id: 'tab1', groupId: 'g1', offset: 40 })).structuredContent;
        assert.equal(second.nodes.length, 15);
        assert.equal(second.meta.nextOffset, null);
        assert.ok(!JSON.stringify(first).includes('hidden'));
    });

    it('rejects oversized tab data before building a graph', async () => {
        const huge = { id: 'tab1', nodes: Array.from({ length: 20001 }, (_, i) => ({ id: 'n' + i, type: 'function' })) };
        const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200, body: huge }) });
        await assert.rejects(() => tools.callTool('get_flow', { mode: 'tab_summary', id: 'tab1' }), /inspection node limit/);
    });

    it('stops graph traversal at the wire visit cap', async () => {
        const manyPorts = { id: 'n1', type: 'function', wires: Array.from({ length: 100001 }, () => []) };
        const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200, body: { id: 'tab1', nodes: [manyPorts] } }) });
        await assert.rejects(() => tools.callTool('get_flow', { mode: 'tab_summary', id: 'tab1' }), /inspection wire limit/);
    });

    it('sends only GET requests to loopback admin API with the configured token', async () => {
        delete process.env.NODE_RED_ADMIN_API_TOKEN;
        const { tools, calls } = build({ 'GET /flows': () => ({ status: 200, body: [] }) });
        await tools.callTool('get_flow', {});
        assert.deepEqual(calls[0], {
            method: 'GET', hostname: '127.0.0.1', port: 1880, path: '/flows',
            headers: { Authorization: 'Bearer configured-value' }
        });
    });
});
