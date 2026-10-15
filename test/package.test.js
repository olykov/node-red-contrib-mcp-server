'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const EventEmitter = require('node:events');
const manifest = require('../package.json');

it('loads only the supported flow-serving palette nodes', () => {
    const registered = [];
    const RED = {
        events: new EventEmitter(),
        nodes: { registerType(name) { registered.push(name); } },
        httpAdmin: { get() {} }
    };
    assert.equal(manifest.main, 'mcp-flow-server.js');
    for (const file of Object.values(manifest['node-red'].nodes)) {
        assert.ok(existsSync(resolve(__dirname, '..', file.replace(/\.js$/, '.html'))));
        require('../' + file)(RED);
    }
    assert.deepEqual(registered.sort(), ['mcp-auth', 'mcp-flow-server', 'mcp-redis',
        'mcp-runtime', 'mcp-server-metrics', 'mcp-tool-registry']);
    for (const name of ['mcp-client', 'mcp-server']) {
        for (const extension of ['js', 'html']) {
            assert.equal(existsSync(resolve(__dirname, '..', name + '.' + extension)), false);
        }
    }
    for (const dependency of ['eventsource', 'ws']) {
        assert.equal(manifest.dependencies[dependency], undefined);
    }
});

it('declares accurate package metadata and ships the example instead of tests', () => {
    assert.strictEqual(manifest.name, '@olykov/node-red-mcp-server');
    assert.strictEqual(manifest['node-red'].version, '>=5.0.0');
    assert.strictEqual(manifest.peerDependencies, undefined);
    assert.strictEqual(manifest.engines.node, '>=18.0.0');
    assert.strictEqual(manifest.dependencies.qs, undefined);
    assert.ok(manifest.repository && /github\.com\/olykov\/node-red-contrib-mcp-server/.test(manifest.repository.url));
    assert.ok(manifest.files.includes('examples/'));
    assert.ok(!manifest.files.includes('test/'));
    assert.ok(!manifest.keywords.includes('node-red'));
});

it('ships an example flow whose nodes satisfy the current editor contracts', () => {
    const flow = require('../examples/flow-based-mcp-server-example.json');
    const byId = new Map(flow.map(node => [node.id, node]));
    const server = flow.find(node => node.type === 'mcp-flow-server');
    assert.strictEqual(byId.get(server.runtime).type, 'mcp-runtime');
    assert.strictEqual(byId.get(server.auth).type, 'mcp-auth');
    assert.strictEqual(byId.get(byId.get(server.auth).redis).type, 'mcp-redis');
    assert.strictEqual(server.serverPort, undefined);
    for (const tool of flow.filter(node => node.type === 'mcp-tool-registry')) {
        assert.strictEqual(tool.endpoint, server.serverPath);
        assert.deepStrictEqual(tool.wires, []);
        assert.match(tool.toolName, /^[a-z][a-z0-9_]*$/);
        JSON.parse(tool.toolSchema);
    }
    for (const node of flow) {
        for (const port of node.wires || []) for (const target of port) assert.ok(byId.has(target), target);
        if (node.z) assert.strictEqual(byId.get(node.z).type, 'tab');
    }
    assert.ok(flow.some(node => node.type === 'comment'));
});

it('keeps editor templates within the Creating Nodes appearance and safety rules', () => {
    const { readFileSync } = require('node:fs');
    for (const file of Object.values(manifest['node-red'].nodes)) {
        const html = readFileSync(resolve(__dirname, '..', file.replace(/\.js$/, '.html')), 'utf8');
        assert.doesNotMatch(html, /class="btn\b/, file + ' uses Bootstrap buttons');
        assert.doesNotMatch(html, /\.(click|change)\(/, file + ' uses deprecated jQuery shorthands');
        assert.doesNotMatch(html, /#(9C27B0|E91E63|e74c3c|f39c12)\b/i, file + ' uses off-palette colours');
        assert.doesNotMatch(html, /<strong>/, file + ' uses styling markup in help');
        assert.doesNotMatch(html, /\.html\(/, file + ' writes HTML strings into the dialog');
        const registrations = html.match(/registerType\('[^']+'/g) || [];
        assert.strictEqual((html.match(/paletteLabel:/g) || []).length, registrations.length, file + ' paletteLabel');
        const helps = html.match(/data-help-name="[^"]+">[\s\S]*?<\/script>/g) || [];
        for (const help of helps) assert.match(help, /<h3>(Inputs|Outputs|Details)<\/h3>/, help.slice(0, 40));
    }
});
