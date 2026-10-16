'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

function buildRegistry(config = {}, nodes = {}) {
    const types = {};
    const events = new EventEmitter();
    const emitted = [];
    const runtime = {
        id: 'test-runtime', type: 'nr-mcp-runtime',
        registerTool: tool => emitted.push({ event: 'register', tool }),
        unregisterTool: registeredBy => emitted.push({ event: 'unregister', tool: { registeredBy } })
    };
    const nodeList = (Array.isArray(nodes) ? nodes : Object.values(nodes))
        .map(node => node.type === 'nr-mcp-endpoint' && node.runtime === undefined ? { ...node, runtime } : node);
    const RED = {
        events,
        nodes: {
            createNode(node) {
                Object.setPrototypeOf(node, EventEmitter.prototype);
                EventEmitter.call(node);
                node.sent = [];
                node.statuses = [];
                node.logs = [];
                node.warnings = [];
                node.send = msg => node.sent.push(msg);
                node.status = status => node.statuses.push(status);
                node.log = message => node.logs.push(message);
                node.debug = message => node.logs.push(message);
                node.warn = message => node.warnings.push(message);
            },
            registerType(name, ctor) { types[name] = ctor; },
            getNode(id) { return id === runtime.id ? runtime : nodeList.find(node => node.id === id); },
            eachNode(callback) { for (const node of [runtime, ...nodeList]) callback(node); }
        }
    };
    delete require.cache[require.resolve('../nr-mcp-tool')];
    require('../nr-mcp-tool')(RED);
    const registry = new types['nr-mcp-tool']({ scope: 'shared', runtime: runtime.id, ...config });
    return { registry, emitted };
}

describe('nr-mcp-tool', () => {
    it('registers an Endpoint tool in the runtime of the selected endpoint', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolDescription: 'Read status',
            scope: 'endpoint',
            endpoint: 'endpoint-1',
            toolSchema: '{"type":"object","properties":{}}'
        }, [{ type: 'nr-mcp-endpoint', id: 'endpoint-1', serverName: 'ops', serverPath: '/mcp/ops' }]);

        assert.strictEqual(registry.isRegistered, true);
        assert.strictEqual(emitted[0].event, 'register');
        assert.strictEqual(emitted[0].tool.endpointId, 'endpoint-1');
        assert.strictEqual(emitted[0].tool.annotations, undefined);
    });

    it('registers a Shared tool for every endpoint of the selected runtime', () => {
        const { emitted } = buildRegistry({ toolName: 'read_status', toolSchema: '{"type":"object","properties":{}}' });
        assert.strictEqual(emitted[0].tool.endpointId, '');
    });

    it('sends calls on the first output and cancellations on the second only when enabled', () => {
        const plain = buildRegistry({ toolName: 'read_status', toolSchema: '{"type":"object","properties":{}}' });
        plain.emitted[0].tool.deliver({ payload: {} });
        plain.emitted[0].tool.cancel({ executionId: 'e1', reason: 'timeout' });
        assert.deepStrictEqual(plain.registry.sent, [{ payload: {} }]);
        const withCancel = buildRegistry({ toolName: 'read_status', cancelOutput: true, toolSchema: '{"type":"object","properties":{}}' });
        withCancel.emitted[0].tool.cancel({ executionId: 'e1', reason: 'timeout' });
        assert.deepStrictEqual(withCancel.registry.sent, [[null, { mcp: { executionId: 'e1', reason: 'timeout' } }]]);
    });

    it('shows duplicate and endpoint errors reported by the runtime', () => {
        const { registry, emitted } = buildRegistry({ toolName: 'read_status', toolSchema: '{"type":"object","properties":{}}' });
        assert.strictEqual(registry.statuses.at(-1).text, 'shared');
        emitted[0].tool.setStatus('duplicate');
        assert.strictEqual(registry.statuses.at(-1).text, 'duplicate');
        emitted[0].tool.setStatus('error');
        assert.strictEqual(registry.statuses.at(-1).text, 'endpoint error');
    });

    it('advertises explicitly configured safety annotations', () => {
        const { emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{}}',
            toolBehavior: 'read',
            worldAccess: 'closed'
        });
        assert.deepStrictEqual(emitted[0].tool.annotations, {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false
        });
    });



    it('registers optional output schemas', () => {
        const { emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{}}',
            outputSchema: '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}'
        });

        assert.deepStrictEqual(emitted[0].tool.outputSchema, {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok']
        });
    });

    it('does not expose runtime registration commands', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{}}'
        });

        registry.emit('input', { topic: 'unregister' });

        assert.strictEqual(registry.listenerCount('input'), 0);
        assert.deepStrictEqual(emitted.map(entry => entry.event), ['register']);
    });

    // MCP-VAL-1
    it('marks invalid tool names and never registers them', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'Read-Status',
            toolSchema: '{"type":"object","properties":{}}'
        });
        assert.strictEqual(registry.statuses.at(-1).text, 'invalid');
        assert.match(registry.warnings[0], /lowercase/);
        assert.deepStrictEqual(emitted, []);
    });

    // MCP-VAL-2
    it('marks malformed input schemas as invalid', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"array"}'
        });
        assert.strictEqual(registry.statuses.at(-1).text, 'invalid');
        assert.match(registry.warnings[0], /type "object"/);
        assert.deepStrictEqual(emitted, []);
    });

    // MCP-VAL-2
    it('marks malformed output schemas as invalid', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{}}',
            outputSchema: 'not json'
        });
        assert.strictEqual(registry.statuses.at(-1).text, 'invalid');
        assert.match(registry.warnings[0], /valid JSON/);
        assert.deepStrictEqual(emitted, []);
    });

    // MCP-LIFE-2
    it('rejects a tool timeout outside the supported range', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{}}',
            timeoutMs: 999
        });
        assert.strictEqual(registry.statuses.at(-1).text, 'invalid');
        assert.match(registry.warnings[0], /between 1000 and 600000/);
        assert.deepStrictEqual(emitted, []);
    });

    // MCP-LIFE-2
    it('rejects a tool timeout that exceeds its endpoint timeout', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{}}',
            scope: 'endpoint',
            endpoint: 'endpoint-1',
            timeoutMs: 60000
        }, [{ type: 'nr-mcp-endpoint', id: 'endpoint-1', serverName: 'ops', serverPath: '/mcp/ops', toolTimeoutMs: 30000 }]);
        assert.strictEqual(registry.statuses.at(-1).text, 'invalid');
        assert.match(registry.warnings.at(-1), /cannot exceed its MCP endpoint timeout/);
        assert.deepStrictEqual(emitted, []);
    });

    it('accepts a tool timeout within its endpoint timeout and exposes it on the tool definition', () => {
        const { emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{}}',
            scope: 'endpoint',
            endpoint: 'endpoint-1',
            timeoutMs: 5000
        }, [{ type: 'nr-mcp-endpoint', id: 'endpoint-1', serverName: 'ops', serverPath: '/mcp/ops', toolTimeoutMs: 30000 }]);
        assert.strictEqual(emitted[0].tool.timeoutMs, 5000);
    });

    // MCP-VAL-3
    it('validates tool call arguments against the compiled input schema', () => {
        const { emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}'
        });
        const tool = emitted[0].tool;
        assert.doesNotThrow(() => tool.validateArguments({ id: 'a' }));
        assert.throws(() => tool.validateArguments({}), /Arguments do not match input schema/);
        assert.throws(() => tool.validateArguments('not-an-object'), /Arguments do not match input schema/);
    });
});

describe('registry lifecycle', () => {
    // MCP-NODE-4
    it('registers in the runtime synchronously in the constructor and unregisters on close', async () => {
        const { registry, emitted } = buildRegistry({ id: 'quick', toolName: 'quick_tool',
            toolSchema: '{"type":"object","properties":{}}' });
        assert.strictEqual(registry.isRegistered, true);
        assert.deepStrictEqual(emitted.map(entry => entry.event), ['register']);
        await new Promise(resolve => registry.emit('close', resolve));
        assert.deepStrictEqual(emitted.map(entry => entry.event), ['register', 'unregister']);
        assert.strictEqual(registry.isRegistered, false);
    });

    it('refuses a tool without a Scope or without the reference its Scope requires', () => {
        for (const config of [{ scope: '' }, { scope: 'endpoint', endpoint: '' }, { scope: 'endpoint', endpoint: 'missing' },
            { scope: 'shared', runtime: '' }, { scope: 'endpoint', endpoint: 'orphan-endpoint' }]) {
            const { registry, emitted } = buildRegistry({ toolName: 'orphan_tool', toolSchema: '{"type":"object","properties":{}}', ...config },
                [{ type: 'nr-mcp-endpoint', id: 'orphan-endpoint', runtime: null }]);
            assert.deepStrictEqual(emitted, [], JSON.stringify(config));
            assert.strictEqual(registry.statuses.at(-1).text, 'invalid');
        }
    });
});
