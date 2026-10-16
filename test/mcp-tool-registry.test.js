'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

function buildRegistry(config = {}, nodes = {}) {
    const types = {};
    const events = new EventEmitter();
    const emitted = [];
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
            getNode(id) { return nodes[id]; },
            eachNode(callback) { for (const node of Array.isArray(nodes) ? nodes : Object.values(nodes)) callback(node); }
        }
    };
    events.on('mcp-tool-register', tool => emitted.push({ event: 'register', tool }));
    events.on('mcp-tool-unregister', tool => emitted.push({ event: 'unregister', tool }));
    delete require.cache[require.resolve('../mcp-tool-registry')];
    require('../mcp-tool-registry')(RED);
    const registry = new types['mcp-tool-registry'](config);
    return { registry, emitted };
}

describe('mcp-tool-registry', () => {
    it('registers tools against selected endpoints', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolDescription: 'Read status',
            endpoint: '/mcp/ops',

            toolSchema: '{"type":"object","properties":{}}'
        }, [{ type: 'mcp-flow-server', id: 'endpoint-1', serverName: 'ops', serverPath: '/mcp/ops' }]);

        registry.registerTool();

        assert.strictEqual(emitted[0].event, 'register');
        assert.strictEqual(emitted[0].tool.endpointPath, '/mcp/ops');
        assert.strictEqual(emitted[0].tool.serverName, 'ops');
        assert.strictEqual(emitted[0].tool.annotations, undefined);
    });

    it('advertises explicitly configured safety annotations', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{}}',
            toolBehavior: 'read',
            worldAccess: 'closed'
        });

        registry.registerTool();
        assert.deepStrictEqual(emitted[0].tool.annotations, {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false
        });
    });



    it('registers optional output schemas', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{}}',
            outputSchema: '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}'
        });

        registry.registerTool();

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
        assert.deepStrictEqual(emitted, []);
    });

    // MCP-VAL-1
    it('marks invalid tool names and never registers them', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'Read-Status',
            toolSchema: '{"type":"object","properties":{}}'
        });
        registry.registerTool();
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
        registry.registerTool();
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
        registry.registerTool();
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
        registry.registerTool();
        assert.strictEqual(registry.statuses.at(-1).text, 'invalid');
        assert.match(registry.warnings[0], /between 1000 and 600000/);
        assert.deepStrictEqual(emitted, []);
    });

    // MCP-LIFE-2
    it('rejects a tool timeout that exceeds its endpoint timeout', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{}}',
            endpoint: '/mcp/ops',
            timeoutMs: 60000
        }, [{ type: 'mcp-flow-server', id: 'endpoint-1', serverName: 'ops', serverPath: '/mcp/ops', toolTimeoutMs: 30000 }]);
        registry.registerTool();
        assert.strictEqual(registry.statuses.at(-1).text, 'invalid');
        assert.match(registry.warnings.at(-1), /cannot exceed its MCP endpoint timeout/);
        assert.deepStrictEqual(emitted, []);
    });

    it('accepts a tool timeout within its endpoint timeout and exposes it on the tool definition', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{}}',
            endpoint: '/mcp/ops',
            timeoutMs: 5000
        }, [{ type: 'mcp-flow-server', id: 'endpoint-1', serverName: 'ops', serverPath: '/mcp/ops', toolTimeoutMs: 30000 }]);
        registry.registerTool();
        assert.strictEqual(emitted[0].tool.timeoutMs, 5000);
    });

    // MCP-VAL-3
    it('validates tool call arguments against the compiled input schema', () => {
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolSchema: '{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}'
        });
        registry.registerTool();
        const tool = emitted[0].tool;
        assert.doesNotThrow(() => tool.validateArguments({ id: 'a' }));
        assert.throws(() => tool.validateArguments({}), /Arguments do not match input schema/);
        assert.throws(() => tool.validateArguments('not-an-object'), /Arguments do not match input schema/);
    });
});

describe('registry lifecycle', () => {
    it('does not register a tool when closed before the delayed registration', async () => {
        const { registry, emitted } = buildRegistry({ id: 'quick', toolName: 'quick_tool', endpoint: '__shared__' });
        await new Promise(resolve => registry.emit('close', resolve));
        await new Promise(resolve => setTimeout(resolve, 600));
        assert.deepStrictEqual(emitted, []);
        assert.strictEqual(registry.isRegistered, false);
    });
});
