'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdminTools } = require('../lib/admin-tools');

function build(handlers) {
    const calls = [];
    const httpRequest = async (method, hostname, port, path, headers, body) => {
        calls.push({ method, hostname, port, path, headers, body });
        const key = method + ' ' + path.replace(/^(\/flow)\/.+$/, '$1/:id');
        const handler = handlers[key] || handlers[method + ' ' + path];
        if (!handler) throw new Error('unmocked request: ' + method + ' ' + path);
        return handler({ method, path, body });
    };
    const tools = createAdminTools({ adminPort: 1880, getAdminToken: () => 'configured-value', httpRequest });
    return { tools, calls };
}

describe('lib/admin-tools', () => {
    it('exposes only read-only get_flow', () => {
        const { tools } = build({});
        assert.deepStrictEqual(tools.TOOLS.map(t => t.name), ['get_flow']);
        assert.ok(tools.TOOL_NAMES.has('get_flow'));
        assert.ok(!tools.TOOL_NAMES.has('deploy_flow'));
        assert.strictEqual(tools.TOOLS[0].outputSchema.type, 'object');
        assert.deepStrictEqual(tools.TOOLS[0].outputSchema.required, ['mode']);
    });

    it('lists tabs with node counts', async () => {
        const { tools } = build({
            'GET /flows': () => ({
                status: 200,
                body: [
                    { id: 'tab1', type: 'tab', label: 'Flow One' },
                    { id: 'tab2', type: 'tab', label: 'Flow Two', disabled: true },
                    { id: 'n1', type: 'function', z: 'tab1' },
                    { id: 'n2', type: 'function', z: 'tab1' },
                    { id: 'n3', type: 'function', z: 'tab2' }
                ]
            })
        });
        const result = await tools.callTool('get_flow', {});
        assert.match(result.content[0].text, /Node-RED flow tabs/);
        assert.match(result.content[0].text, /Flow One/);
        assert.match(result.content[0].text, /Nodes: 2/);
        assert.match(result.content[0].text, /Flow Two\*\* \[disabled\]/);
        assert.deepStrictEqual(result.structuredContent, {
            mode: 'list',
            flows: [
                { id: 'tab1', label: 'Flow One', disabled: false, nodeCount: 2 },
                { id: 'tab2', label: 'Flow Two', disabled: true, nodeCount: 1 }
            ]
        });
    });

    it('returns one flow JSON by id and rejects path-like ids', async () => {
        const { tools } = build({
            'GET /flow/:id': ({ path }) => {
                assert.strictEqual(path, '/flow/abc123');
                return { status: 200, body: { id: 'abc123', label: 'My Flow', nodes: [] } };
            }
        });
        const result = await tools.callTool('get_flow', { id: 'abc123' });
        assert.deepStrictEqual(result.structuredContent, { mode: 'flow', id: 'abc123', flow: { id: 'abc123', label: 'My Flow', nodes: [] } });
        assert.deepStrictEqual(JSON.parse(result.content[0].text), { id: 'abc123', label: 'My Flow', nodes: [] });
        await assert.rejects(() => tools.callTool('get_flow', { id: '../etc/passwd' }), err => err.rpcCode === -32602);
    });

    it('sends only GET requests to loopback admin API with the configured token', async () => {
        delete process.env.NODE_RED_ADMIN_API_TOKEN;
        const inspected = [];
        const httpRequest = async (method, hostname, port, path, headers) => {
            inspected.push({ method, hostname, port, path, headers });
            return { status: 200, body: [] };
        };
        const tools = createAdminTools({ adminPort: 1880, getAdminToken: () => 'configured-value', httpRequest });
        await tools.callTool('get_flow', {});
        assert.deepStrictEqual(inspected[0], {
            method: 'GET', hostname: '127.0.0.1', port: 1880, path: '/flows', headers: { Authorization: ['Bearer', 'configured-value'].join(' ') }
        });
    });
});
