'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { normalizeIp, parseCidr, ipInCidr } = require('../lib/cidr');
const { message } = require('../lib/messages');

// MCP-STO-2
describe('trusted proxy CIDR matching', () => {
    it('matches IPv4 and IPv6 ranges and unwraps mapped addresses', () => {
        assert.ok(ipInCidr('10.1.2.3', '10.0.0.0/8'));
        assert.ok(!ipInCidr('11.1.2.3', '10.0.0.0/8'));
        assert.ok(ipInCidr('::ffff:10.1.2.3', '10.0.0.0/8'));
        assert.ok(ipInCidr('2001:db8::1', '2001:db8::/32'));
        assert.ok(!ipInCidr('2001:db9::1', '2001:db8::/32'));
        assert.ok(ipInCidr('192.168.0.5', '192.168.0.5'));
    });

    it('rejects malformed addresses and prefixes', () => {
        assert.strictEqual(normalizeIp('not-an-ip'), null);
        assert.throws(() => parseCidr('10.0.0.0/33'));
        assert.throws(() => parseCidr('10.0.0.0/8/8'));
        assert.throws(() => parseCidr('nope/8'));
        assert.throws(() => parseCidr('10.0.0.0/x'));
        assert.ok(!ipInCidr('garbage', '10.0.0.0/8'));
    });
});

// MCP-PKG-4
describe('message catalogs', () => {
    it('resolves status texts from the shipped catalog', () => {
        assert.strictEqual(message(null, 'nr-mcp-tool', 'nr-mcp-tool.status.endpointError'), 'endpoint error');
        assert.strictEqual(message(null, 'nr-mcp-tool', 'nr-mcp-tool.status.duplicate'), 'duplicate');
        assert.strictEqual(message(null, 'nr-mcp-metrics', 'nr-mcp-metrics.status.listening'), 'listening');
    });

    it('prefers the Node-RED translation and falls back to the key when missing', () => {
        assert.strictEqual(message({ _: () => 'translated' }, 'nr-mcp-endpoint', 'nr-mcp-endpoint.status.error'), 'translated');
        assert.strictEqual(message(null, 'nr-mcp-endpoint', 'nr-mcp-endpoint.status.nope'), 'nr-mcp-endpoint.status.nope');
    });
});
