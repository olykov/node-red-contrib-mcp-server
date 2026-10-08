'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { createAdminTools } = require('../lib/admin-tools');

function build(handlers, runtime = {}) {
    const calls = [];
    const httpRequest = async (method, hostname, port, path, headers) => {
        calls.push({ method, hostname, port, path, headers });
        const handler = handlers[method + ' ' + path] || handlers[method + ' ' + path.replace(/\/flow\/[^/]+$/, '/flow/:id')];
        if (!handler) throw new Error('unmocked request: ' + method + ' ' + path);
        return handler({ path });
    };
    const tools = createAdminTools({ adminPort: 1880, getAdminToken: () => 'configured-value', httpRequest, ...runtime });
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
            ['tabs', 'tab_summary', 'group', 'chain', 'node', 'subflows', 'subflow', 'configs', 'config', 'node_configs']);
        assert.deepEqual(tools.TOOLS[0].outputSchema.required, ['mode', 'source', 'meta']);
        assert.ok(!tools.TOOL_NAMES.has('deploy_flow'));
    });

    it('lists tabs from runtime with pagination and deploy-scoped caching, without HTTP', async () => {
        const events = new EventEmitter();
        const configs = Array.from({ length: 45 }, (_, i) => ({
            id: 'tab' + i, type: 'tab', label: 'Tab ' + i, disabled: i === 1
        }));
        configs.push(
            { id: 'n1', type: 'function', z: 'tab0', func: 'private code' },
            { id: 'cfg', type: 'redis-config', z: 'tab0', password: 'private' },
            { id: 'g1', type: 'group', z: 'tab44' }
        );
        let scans = 0;
        const { tools, calls } = build({}, {
            eachNode(callback) {
                scans++;
                for (const node of configs) callback(node);
            },
            events
        });
        const first = await tools.callTool('get_flow', {});
        const data = first.structuredContent;
        assert.equal(data.mode, 'tabs');
        assert.equal(data.source, 'runtime:nodes');
        assert.equal(data.tabs.length, 40);
        assert.equal(data.tabs[0].nodeCount, 2);
        assert.equal(data.tabs[1].disabled, true);
        assert.equal(data.totalTabs, 45);
        assert.equal(data.meta.scannedNodes, 48);
        assert.equal(data.meta.returnedNodes, 40);
        assert.equal(data.meta.nextOffset, 40);
        assert.equal(data.meta.cached, false);
        assert.ok(!JSON.stringify(first).includes('private'));
        assert.deepEqual(JSON.parse(first.content[0].text), data);

        const second = (await tools.callTool('get_flow', { mode: 'tabs', offset: 40 })).structuredContent;
        assert.equal(second.tabs.length, 5);
        assert.equal(second.tabs[4].nodeCount, 1);
        assert.equal(second.meta.cached, true);
        assert.equal(scans, 1);
        assert.deepEqual(calls, []);

        events.emit('runtime-event', { id: 'runtime-state' });
        assert.equal((await tools.callTool('get_flow', {})).structuredContent.meta.cached, true);
        configs.push({ id: 'n2', type: 'debug', z: 'tab0' });
        events.emit('runtime-event', { id: 'runtime-deploy' });
        const refreshed = (await tools.callTool('get_flow', {})).structuredContent;
        assert.equal(refreshed.tabs[0].nodeCount, 3);
        assert.equal(refreshed.meta.cached, false);
        assert.equal(scans, 2);
        tools.dispose();
        assert.equal(events.listenerCount('runtime-event'), 0);
    });

    it('fails closed if the runtime does not support tab indexing', async () => {
        const { tools, calls } = build({});
        await assert.rejects(() => tools.callTool('get_flow', {}), /tab listing is unavailable/);
        assert.deepEqual(calls, []);
    });

    it('indexes more than 100,000 runtime nodes without fetching flows', async () => {
        const { tools, calls } = build({}, {
            now: () => 0,
            eachNode(callback) {
                callback({ id: 'tab1', type: 'tab', label: 'Large' });
                const node = { id: 'n1', type: 'debug', z: 'tab1' };
                for (let i = 0; i < 300000; i++) callback(node);
            }
        });
        const data = (await tools.callTool('get_flow', {})).structuredContent;
        assert.equal(data.meta.scannedNodes, 300001);
        assert.equal(data.tabs[0].nodeCount, 300000);
        assert.equal(data.meta.limits.tabIndexMilliseconds, 250);
        assert.equal(data.meta.limits.tabIndexScopes, 10000);
        assert.deepEqual(calls, []);
    });

    it('stops a slow runtime tab index without caching a partial result', async () => {
        const events = new EventEmitter();
        let scans = 0;
        let clock = 0;
        const { tools } = build({}, {
            events,
            now: () => clock,
            eachNode(callback) {
                scans++;
                for (let i = 0; i < 1024; i++) {
                    if (i === 1023) clock += 251;
                    callback({ id: 'n1', type: 'debug', z: 'tab1' });
                }
            }
        });
        await assert.rejects(() => tools.callTool('get_flow', {}), /tab index time limit/);
        await assert.rejects(() => tools.callTool('get_flow', {}), /temporarily unavailable/);
        assert.equal(scans, 1);
        events.emit('runtime-event', { id: 'runtime-deploy' });
        await assert.rejects(() => tools.callTool('get_flow', {}), /tab index time limit/);
        assert.equal(scans, 2);
        tools.dispose();
        assert.equal(events.listenerCount('runtime-event'), 0);
    });

    it('bounds memory used for distinct runtime scopes', async () => {
        const { tools } = build({}, {
            now: () => 0,
            eachNode(callback) {
                for (let i = 0; i <= 10000; i++) callback({ id: 'n' + i, type: 'debug', z: 'scope' + i });
            }
        });
        await assert.rejects(() => tools.callTool('get_flow', {}), /tab index scope limit/);
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
            node.id === 'n1' ? { ...node, func: 'x'.repeat(15000), password: 'hidden' } : node
        ) };
        const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200, body: large }) });
        const normal = (await tools.callTool('get_flow', { mode: 'node', id: 'tab1', nodeId: 'n1' })).structuredContent;
        assert.deepEqual(normal.outgoing, [{ from: 'n1', to: 'n2', port: 0 }]);
        assert.equal(normal.node.code, undefined);
        assert.ok(!JSON.stringify(normal).includes('hidden'));
        const explicit = (await tools.callTool('get_flow', {
            mode: 'node', id: 'tab1', nodeId: 'n1', includeCode: true
        })).structuredContent;
        assert.equal(explicit.node.code.length, 10000);
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

    it('returns bounded inject parameters only when explicitly requested', async () => {
        const inject = {
            id: 'inject1', type: 'inject', name: 'Seed advertiser',
            payload: 'advertiser-123', payloadType: 'str',
            topic: 'meta.ads', topicType: 'str',
            once: true, onceDelay: 0.5, repeat: '', crontab: '',
            props: [{ p: 'payload', pt: 'msg', v: 'advertiser-123', vt: 'str' }], wires: [[]]
        };
        const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200, body: { id: 'tab1', nodes: [inject] } }) });
        const normal = (await tools.callTool('get_flow', { mode: 'node', id: 'tab1', nodeId: 'inject1' })).structuredContent;
        assert.equal(normal.node.config, undefined);

        const explicit = (await tools.callTool('get_flow', {
            mode: 'node', id: 'tab1', nodeId: 'inject1', includeConfig: true
        })).structuredContent;
        assert.deepEqual(explicit.node.config, {
            props: [{ p: 'payload', pt: 'msg', v: 'advertiser-123', vt: 'str' }],
            payload: 'advertiser-123', payloadType: 'str', topic: 'meta.ads', topicType: 'str',
            once: true, onceDelay: 0.5, repeat: '', crontab: ''
        });
    });

    it('bounds requested inject parameters', async () => {
        const inject = { id: 'inject1', type: 'inject', payload: 'x'.repeat(32769), payloadType: 'str', wires: [] };
        const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200, body: { id: 'tab1', nodes: [inject] } }) });
        const data = (await tools.callTool('get_flow', {
            mode: 'node', id: 'tab1', nodeId: 'inject1', includeConfig: true
        })).structuredContent;
        assert.deepEqual(data.node.config, { payloadType: 'str' });
        assert.deepEqual(data.node.configOmittedProperties, ['payload']);
        assert.equal(data.meta.truncated, true);
    });

    it('exposes execution settings for each supported node only on explicit inspection', async () => {
        const cases = [
            ['link in', { links: ['entry'] }],
            ['link out', { mode: 'return', links: [] }],
            ['link call', { linkType: 'static', links: ['entry'], timeout: '30' }],
            ['switch', { property: 'payload.operation', propertyType: 'msg',
                rules: [{ t: 'eq', v: 'findOne', vt: 'str' }, { t: 'else' }], checkall: 'true', repair: false, outputs: 2 }],
            ['catch', { scope: ['database'], uncaught: false }],
            ['mongodb4', { mode: 'collection', collection: 'items', operation: 'find', output: 'toArray', maxTimeMS: '5000', handleDocId: false }],
            ['mcp-flow-server', { serverPath: '/mcp/items', authMode: 'inherit', allowedGroups: 'Readers', requiredScopes: 'items:read', advertisedScopes: 'openid' }],
            ['mcp-tool-registry', { toolName: 'read_items', endpoint: 'items', toolDescription: 'Read items',
                toolSchema: JSON.stringify({ type: 'object', properties: { count: { type: 'integer' } } }),
                outputSchema: JSON.stringify({ type: 'array', items: { type: 'object' } }),
                toolBehavior: 'read-only', worldAccess: 'closed', requiredScopes: 'items:read' }]
        ];
        for (const [type, settings] of cases) {
            const target = { id: 'target', type, ...settings, wires: [], credentials: { password: 'private-value' },
                token: 'private-value', secret: 'private-value', arbitrary: 'private-value' };
            const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200, body: { id: 'tab1', nodes: [target] } }) });
            const inspect = extra => tools.callTool('get_flow', { mode: 'node', id: 'tab1', nodeId: 'target', ...extra });
            const normal = (await inspect({})).structuredContent;
            assert.deepEqual((await inspect({ includeConfig: false })).structuredContent, normal);
            const expanded = await inspect({ includeConfig: true });
            assert.equal(expanded.structuredContent.node.configSupported, true, type);
            assert.deepEqual(expanded.structuredContent.node.config, { ...(normal.node.config || {}), ...settings }, type);
            assert.equal(JSON.stringify(expanded).includes('private-value'), false, type);
            assert.equal(expanded.structuredContent.meta.truncated, false, type);
            assert.deepEqual(JSON.parse(expanded.content[0].text), expanded.structuredContent);
            const chain = (await tools.callTool('get_flow', { mode: 'chain', id: 'tab1', nodeId: 'target' })).structuredContent;
            assert.deepEqual(chain.nodes[0], normal.node.type.startsWith('link ') ?
                Object.fromEntries(Object.entries(normal.node).filter(([key]) => !key.startsWith('linkIds'))) : normal.node);
        }
    });

    it('distinguishes return and link output modes even with identical empty links', async () => {
        for (const mode of ['return', 'link']) {
            const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200,
                body: { id: 'tab1', nodes: [{ id: 'target', type: 'link out', mode, links: [], wires: [] }] } }) });
            const response = (await tools.callTool('get_flow', { mode: 'node', id: 'tab1', nodeId: 'target', includeConfig: true })).structuredContent;
            assert.deepEqual(response.node.linkIds, []);
            assert.equal(response.node.config.mode, mode);
        }
    });

    it('redacts named secrets inside rules and JSON schema text without mutating the source', async () => {
        const schema = JSON.stringify({ type: 'object', credentials: { token: 'hidden-value' },
            'x-options': { api_key: 'hidden-value', safe: true } });
        const rule = { t: 'eq', v: { safe: 1, secret: 'hidden-value', authorization: 'hidden-value' }, vt: 'json' };
        for (const target of [
            { id: 'target', type: 'mcp-tool-registry', toolSchema: schema, outputSchema: '{invalid', wires: [] },
            { id: 'target', type: 'switch', rules: [rule], wires: [] }
        ]) {
            const before = JSON.stringify(target);
            const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200, body: { id: 'tab1', nodes: [target] } }) });
            const data = (await tools.callTool('get_flow', { mode: 'node', id: 'tab1', nodeId: 'target', includeConfig: true })).structuredContent;
            assert.equal(JSON.stringify(data).includes('hidden-value'), false);
            assert.ok(data.node.configRedactedProperties.length > 0);
            if (target.type === 'switch') assert.equal(data.node.config.rules[0].v.safe, 1);
            else {
                assert.equal(JSON.parse(data.node.config.toolSchema)['x-options'].safe, true);
                assert.deepEqual(data.node.configOmittedProperties, ['outputSchema']);
                assert.equal(data.meta.truncated, true);
            }
            assert.equal(JSON.stringify(target), before);
        }
    });

    it('reports oversized, aggregate-limited and deeply nested settings without partial values', async () => {
        let deep = { type: 'string' };
        for (let i = 0; i < 20; i++) deep = { items: deep };
        const cases = [
            { type: 'catch', scope: Array(2001).fill('node') },
            { type: 'switch', rules: [{ t: 'eq', v: '\u00e9'.repeat(17000) }] },
            { type: 'mcp-tool-registry', toolSchema: JSON.stringify(deep) },
            { type: 'mcp-flow-server', serverPath: 'a'.repeat(30000), authMode: 'b'.repeat(30000), allowedGroups: 'c'.repeat(30000) }
        ];
        for (const settings of cases) {
            const target = { id: 'target', ...settings, wires: [] };
            const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200, body: { id: 'tab1', nodes: [target] } }) });
            const data = (await tools.callTool('get_flow', { mode: 'node', id: 'tab1', nodeId: 'target', includeConfig: true })).structuredContent;
            assert.ok(data.node.configOmittedProperties.length > 0);
            assert.equal(data.meta.truncated, true);
            for (const field of data.node.configOmittedProperties) assert.equal(data.node.config[field], undefined);
            assert.ok(Buffer.byteLength(JSON.stringify(data.node.config)) <= data.meta.limits.configPageBytes);
        }
    });

    it('marks unsupported node configuration explicitly rather than claiming complete settings', async () => {
        const { tools } = build({ 'GET /flow/tab1': () => ({ status: 200,
            body: { id: 'tab1', nodes: [{ id: 'target', type: 'custom-node', secret: 'hidden-value', wires: [] }] } }) });
        const data = (await tools.callTool('get_flow', { mode: 'node', id: 'tab1', nodeId: 'target', includeConfig: true })).structuredContent;
        assert.equal(data.node.configSupported, false);
        assert.deepEqual(data.node.config, {});
        assert.equal(JSON.stringify(data).includes('hidden-value'), false);
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

    it('exposes internal and port connections without returning subflow code', async () => {
        const definition = {
            id: 'sf1', name: 'Reusable',
            in: [{ wires: [{ id: 'switch1' }] }],
            out: [{ wires: [{ id: 'metric1', port: 0 }] }],
            nodes: [
                { id: 'switch1', type: 'switch', wires: [['metric1'], ['debug1']] },
                { id: 'metric1', type: 'metric', wires: [[]] },
                { id: 'debug1', type: 'debug', wires: [] },
                { id: 'fn1', type: 'function', func: 'private code', wires: [] }
            ]
        };
        const { tools, calls } = build({
            'GET /flow/global': () => ({ status: 200, body: { nodes: [], subflows: [definition] } })
        });
        const data = (await tools.callTool('get_flow', { mode: 'subflow', subflowId: 'sf1' })).structuredContent;
        assert.deepEqual(data.edges, [
            { from: 'switch1', to: 'metric1', port: 0 },
            { from: 'switch1', to: 'debug1', port: 1 }
        ]);
        assert.deepEqual(data.inputConnections, [{ input: 0, to: 'switch1' }]);
        assert.deepEqual(data.outputConnections, [{ from: 'metric1', port: 0, output: 0 }]);
        assert.equal(data.totalEdges, 2);
        assert.equal(data.totalInputConnections, 1);
        assert.equal(data.totalOutputConnections, 1);
        assert.equal(data.meta.truncated, false);
        assert.ok(!JSON.stringify(data).includes('private code'));
        assert.deepEqual(calls.map(call => call.path), ['/flow/global']);
    });

    it('pages subflow nodes and edges independently', async () => {
        const nodes = Array.from({ length: 55 }, (_, index) => ({
            id: 'n' + index, type: 'change', wires: [index < 54 ? ['n' + (index + 1)] : []]
        }));
        const definition = {
            id: 'sf1', nodes,
            in: [{ wires: [{ id: 'n0' }] }],
            out: [{ wires: [{ id: 'n54', port: 0 }] }]
        };
        const { tools } = build({
            'GET /flow/global': () => ({ status: 200, body: { nodes: [], subflows: [definition] } })
        });
        const first = (await tools.callTool('get_flow', { mode: 'subflow', subflowId: 'sf1' })).structuredContent;
        assert.equal(first.nodes.length, 40);
        assert.equal(first.edges.length, 40);
        assert.equal(first.totalEdges, 54);
        assert.equal(first.meta.nextOffset, 40);
        assert.equal(first.meta.truncated, true);
        const second = (await tools.callTool('get_flow', {
            mode: 'subflow', subflowId: 'sf1', offset: 40
        })).structuredContent;
        assert.equal(second.nodes.length, 15);
        assert.equal(second.edges.length, 14);
        assert.deepEqual(second.edges.at(-1), { from: 'n53', to: 'n54', port: 0 });
        assert.deepEqual(second.inputConnections, []);
        assert.deepEqual(second.outputConnections, []);
        assert.equal(second.meta.nextOffset, null);
        assert.equal(second.meta.truncated, false);
    });

    it('continues paging when only subflow output connections remain', async () => {
        const definition = {
            id: 'sf1', nodes: [{ id: 'n0', type: 'change', wires: [] }], in: [],
            out: [{ wires: Array.from({ length: 45 }, () => ({ id: 'n0', port: 0 })) }]
        };
        const { tools } = build({
            'GET /flow/global': () => ({ status: 200, body: { nodes: [], subflows: [definition] } })
        });
        const first = (await tools.callTool('get_flow', { mode: 'subflow', subflowId: 'sf1' })).structuredContent;
        assert.equal(first.nodes.length, 1);
        assert.equal(first.outputConnections.length, 40);
        assert.equal(first.meta.nextOffset, 40);
        const second = (await tools.callTool('get_flow', {
            mode: 'subflow', subflowId: 'sf1', offset: 40
        })).structuredContent;
        assert.equal(second.nodes.length, 0);
        assert.equal(second.outputConnections.length, 5);
        assert.equal(second.totalOutputConnections, 45);
        assert.equal(second.meta.nextOffset, null);
    });

    it('requires subflow mode instead of interpreting a definition id as a tab id', async () => {
        const { tools, calls } = build({
            'GET /flow/sf1': () => ({ status: 404, body: '' }),
            'GET /flow/global': () => ({ status: 200, body: {
                nodes: [], subflows: [{ id: 'sf1', nodes: [], in: [], out: [] }]
            } })
        });
        const wrongMode = await tools.callTool('get_flow', { id: 'sf1' });
        assert.equal(wrongMode.structuredContent.error.code, 'FLOW_NOT_FOUND');
        const correctMode = await tools.callTool('get_flow', { mode: 'subflow', subflowId: 'sf1' });
        assert.equal(correctMode.structuredContent.subflow.id, 'sf1');
        assert.deepEqual(calls.map(call => call.path), ['/flow/sf1', '/flow/global']);
    });

    it('stops subflow connection inspection at its wire visit cap', async () => {
        const definition = { id: 'sf1', nodes: [
            { id: 'n0', type: 'change', wires: [Array(100001).fill('n0')] }
        ], in: [], out: [] };
        const { tools } = build({
            'GET /flow/global': () => ({ status: 200, body: { nodes: [], subflows: [definition] } })
        });
        await assert.rejects(() => tools.callTool('get_flow', { mode: 'subflow', subflowId: 'sf1' }),
            /subflow exceeds inspection wire limit/);
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
        const { tools, calls } = build({ 'GET /flow/tab1': () => ({ status: 200, body: tab }) });
        await tools.callTool('get_flow', { id: 'tab1' });
        assert.deepEqual(calls[0], {
            method: 'GET', hostname: '127.0.0.1', port: 1880, path: '/flow/tab1',
            headers: { Authorization: 'Bearer configured-value' }
        });
    });

    it('lists and inspects tab configs while redacting only the credential container', async () => {
        const flow = {
            id: 'tab1', nodes: [], configs: [{
                id: 'cfg1', type: 'service-config', name: 'Primary', host: 'example.test', port: 1234,
                enabled: false, options: { retry: [1, 2] }, password: 'ordinary-property',
                credentials: { username: 'credential-text', password: 'credential-password' }
            }]
        };
        const { tools, calls } = build({ 'GET /flow/tab1': () => ({ status: 200, body: flow }) });
        const listed = (await tools.callTool('get_flow', { mode: 'configs', id: 'tab1' })).structuredContent;
        assert.deepEqual(listed.configs, [{ id: 'cfg1', type: 'service-config', name: 'Primary' }]);
        assert.equal(listed.totalConfigs, 1);
        const response = await tools.callTool('get_flow', { mode: 'config', id: 'tab1', configId: 'cfg1' });
        assert.deepEqual({ ...response.structuredContent.config.properties }, {
            name: 'Primary', host: 'example.test', port: 1234, enabled: false,
            options: { retry: [1, 2] }, password: 'ordinary-property'
        });
        assert.equal(response.structuredContent.config.credentials, '[REDACTED]');
        assert.equal(response.structuredContent.totalProperties, 6);
        assert.ok(!JSON.stringify(response).includes('credential-text'));
        assert.ok(!JSON.stringify(response).includes('credential-password'));
        assert.equal(response.content[0].text, JSON.stringify(response.structuredContent));
        assert.deepEqual(calls.map(call => call.path), ['/flow/tab1', '/flow/tab1']);
    });

    it('resolves tab and global config references without building a graph', async () => {
        const flow = { id: 'tab1', nodes: [{
            id: 'n1', type: 'processor', local: 'cfg1', shared: 'cfg2', name: 'Processor', wires: []
        }], configs: [{ id: 'cfg1', type: 'local-config', name: 'Local' }] };
        const global = { id: 'global', nodes: [], configs: [{
            id: 'cfg2', type: 'shared-config', name: 'Shared', credentials: { token: 'hidden' }
        }], subflows: [] };
        const { tools, calls } = build({
            'GET /flow/tab1': () => ({ status: 200, body: flow }),
            'GET /flow/global': () => ({ status: 200, body: global })
        });
        const refs = (await tools.callTool('get_flow', {
            mode: 'node_configs', id: 'tab1', nodeId: 'n1'
        })).structuredContent;
        assert.deepEqual(refs.configRefs, [
            { property: 'local', scope: 'tab', id: 'cfg1', type: 'local-config', name: 'Local' },
            { property: 'shared', scope: 'global', id: 'cfg2', type: 'shared-config', name: 'Shared' }
        ]);
        const detail = await tools.callTool('get_flow', { mode: 'config', configId: 'cfg2' });
        assert.equal(detail.structuredContent.config.credentials, '[REDACTED]');
        assert.ok(!JSON.stringify(detail).includes('hidden'));
        assert.deepEqual(calls.map(call => call.path), ['/flow/tab1', '/flow/global', '/flow/global']);
    });

    it('supports subflow-local configs and resolves their global references', async () => {
        const global = { id: 'global', nodes: [], configs: [
            { id: 'cfg2', type: 'shared-config', host: 'example.test' }
        ], subflows: [{ id: 'sf1', name: 'Reusable', nodes: [
            { id: 'n1', type: 'processor', local: 'cfg1', shared: 'cfg2' }
        ], configs: [{ id: 'cfg1', type: 'local-config', enabled: true }] }] };
        const { tools, calls } = build({ 'GET /flow/global': () => ({ status: 200, body: global }) });
        const listed = (await tools.callTool('get_flow', { mode: 'configs', subflowId: 'sf1' })).structuredContent;
        assert.equal(listed.totalConfigs, 1);
        const detail = (await tools.callTool('get_flow', {
            mode: 'config', subflowId: 'sf1', configId: 'cfg1'
        })).structuredContent;
        assert.equal(detail.config.properties.enabled, true);
        const refs = (await tools.callTool('get_flow', {
            mode: 'node_configs', subflowId: 'sf1', nodeId: 'n1'
        })).structuredContent;
        assert.deepEqual(refs.configRefs.map(ref => [ref.property, ref.scope]), [
            ['local', 'subflow'], ['shared', 'global']
        ]);
        assert.deepEqual(calls.map(call => call.path), ['/flow/global', '/flow/global', '/flow/global']);
    });

    it('pages config collections and properties and omits oversized values', async () => {
        const configs = Array.from({ length: 45 }, (_, i) => ({ id: 'cfg' + i, type: 'service-config' }));
        configs[0].large = 'x'.repeat(33000);
        for (let i = 0; i < 45; i++) configs[0]['field' + i] = i;
        const { tools } = build({ 'GET /flow/global': () => ({
            status: 200, body: { id: 'global', nodes: [], configs, subflows: [] }
        }) });
        const first = (await tools.callTool('get_flow', { mode: 'configs' })).structuredContent;
        const second = (await tools.callTool('get_flow', { mode: 'configs', offset: 40 })).structuredContent;
        assert.equal(first.configs.length, 40);
        assert.equal(first.meta.nextOffset, 40);
        assert.equal(second.configs.length, 5);
        const detail = (await tools.callTool('get_flow', { mode: 'config', configId: 'cfg0' })).structuredContent;
        assert.deepEqual(detail.config.omittedProperties, ['large']);
        assert.equal(detail.meta.truncated, true);
        assert.equal(detail.meta.nextOffset, 40);
        const tail = (await tools.callTool('get_flow', {
            mode: 'config', configId: 'cfg0', offset: 40
        })).structuredContent;
        assert.equal(tail.meta.nextOffset, null);
        assert.equal(tail.config.properties.field44, 44);
    });

    it('rejects invalid config requests and reports missing config nodes', async () => {
        const { tools, calls } = build({ 'GET /flow/global': () => ({
            status: 200, body: { id: 'global', nodes: [], configs: [], subflows: [] }
        }) });
        await assert.rejects(() => tools.callTool('get_flow', { mode: 'config' }), /configId is required/);
        await assert.rejects(() => tools.callTool('get_flow', {
            mode: 'configs', id: 'tab1', subflowId: 'sf1'
        }), /Select a tab or subflow/);
        await assert.rejects(() => tools.callTool('get_flow', { mode: 'config', configId: '../bad' }),
            error => error.rpcCode === -32602);
        const missing = await tools.callTool('get_flow', { mode: 'config', configId: 'cfg1' });
        assert.equal(missing.structuredContent.error.code, 'CONFIG_NOT_FOUND');
        assert.deepEqual(calls.map(call => call.path), ['/flow/global']);
    });

    it('treats an omitted configs array as an empty scope', async () => {
        const { tools } = build({ 'GET /flow/global': () => ({
            status: 200, body: { id: 'global', subflows: [] }
        }) });
        const listed = (await tools.callTool('get_flow', { mode: 'configs' })).structuredContent;
        assert.deepEqual(listed.configs, []);
        assert.equal(listed.totalConfigs, 0);
    });

    it('limits the aggregate size of a config property page', async () => {
        const config = { id: 'cfg1', type: 'service-config', first: 'a'.repeat(30000),
            second: 'b'.repeat(30000), third: 'c'.repeat(30000) };
        const { tools } = build({ 'GET /flow/global': () => ({
            status: 200, body: { id: 'global', configs: [config] }
        }) });
        const first = (await tools.callTool('get_flow', { mode: 'config', configId: 'cfg1' })).structuredContent;
        assert.equal(first.meta.nextOffset, 2);
        assert.equal(first.config.properties.third, undefined);
        const second = (await tools.callTool('get_flow', {
            mode: 'config', configId: 'cfg1', offset: 2
        })).structuredContent;
        assert.equal(second.config.properties.third.length, 30000);
        assert.equal(second.meta.nextOffset, null);
    });
});
