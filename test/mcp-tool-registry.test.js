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
                node.warn = message => node.warnings.push(message);
            },
            registerType(name, ctor) { types[name] = ctor; },
            getNode(id) { return nodes[id]; }
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
        const endpoint = { id: 'endpoint-1', serverName: 'ops' };
        const { registry, emitted } = buildRegistry({
            toolName: 'read_status',
            toolDescription: 'Read status',
            endpoint: 'endpoint-1',
            requiredScopes: 'status:read audit:read',
            toolSchema: '{"type":"object","properties":{}}'
        }, { 'endpoint-1': endpoint });

        registry.registerTool();

        assert.strictEqual(emitted[0].event, 'register');
        assert.strictEqual(emitted[0].tool.endpointId, 'endpoint-1');
        assert.strictEqual(emitted[0].tool.serverName, 'ops');
        assert.deepStrictEqual(emitted[0].tool.requiredScopes, ['status:read', 'audit:read']);
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
});
