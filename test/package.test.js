'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const EventEmitter = require('node:events');
const manifest = require('../package.json');

// MCP-PKG-1
it('loads only the supported flow-serving palette nodes', () => {
    const registered = [];
    const RED = {
        events: new EventEmitter(),
        nodes: { registerType(name) { registered.push(name); } },
        httpAdmin: { get() {} }
    };
    assert.strictEqual(manifest.main, undefined);
    assert.deepStrictEqual(manifest.exports, { './package.json': './package.json' });
    for (const file of Object.values(manifest['node-red'].nodes)) {
        assert.ok(existsSync(resolve(__dirname, '..', file.replace(/\.js$/, '.html'))));
        require('../' + file)(RED);
    }
    assert.deepEqual(registered.sort(), ['mcp-auth', 'mcp-flow-server', 'mcp-redis',
        'mcp-runtime', 'mcp-server-metrics', 'mcp-tool-registry', 'mcp-tool-response']);
    for (const name of ['mcp-client', 'mcp-server']) {
        for (const extension of ['js', 'html']) {
            assert.equal(existsSync(resolve(__dirname, '..', name + '.' + extension)), false);
        }
    }
    for (const dependency of ['eventsource', 'ws']) {
        assert.equal(manifest.dependencies[dependency], undefined);
    }
});

// MCP-TEST-4
// MCP-TEST-1, MCP-TEST-2, MCP-TEST-3 and MCP-PKG-2 are enforced by CI itself, not by a unit
// assertion here: .github/workflows/ci.yml runs the full integration suite on every PR and tag
// across the node/node-red matrix (MCP-TEST-3), packs and smoke-tests the tarball in a clean
// userDir (MCP-TEST-2), and release.yml publishes only via `npm publish --provenance` from a
// protected environment after that CI gate passes (MCP-PKG-2). `npm test`/`npm run coverage`
// run with --unhandled-rejections=strict (MCP-TEST-3) and this directory covers every
// integration-tagged requirement from docs/spec.md section 3 (MCP-TEST-1).
it('declares accurate package metadata and ships the example instead of tests', () => {
    assert.strictEqual(manifest.name, '@olykov/node-red-mcp-server');
    assert.strictEqual(manifest['node-red'].version, '>=5.0.0 <6.0.0');
    assert.match(manifest.devDependencies['node-red'], /^\^5\./);
    assert.match(manifest.devDependencies['node-red-node-test-helper'], /^\^0\./);
    assert.strictEqual(manifest.peerDependencies, undefined);
    assert.strictEqual(manifest.engines.node, '>=22.9');
    assert.strictEqual(manifest.dependencies.qs, undefined);
    assert.ok(manifest.repository && /github\.com\/olykov\/node-red-contrib-mcp-server/.test(manifest.repository.url));
    assert.ok(manifest.files.includes('examples/'));
    assert.ok(!manifest.files.includes('test/'));
    assert.ok(manifest.keywords.includes('node-red'));
    assert.strictEqual(manifest.publishConfig.access, 'public');
});

// MCP-DOC-2
it('ships an example flow whose nodes satisfy the current editor contracts', () => {
    const flow = require('../examples/flow-based-mcp-server-example.json');
    const byId = new Map(flow.map(node => [node.id, node]));
    const server = flow.find(node => node.type === 'mcp-flow-server');
    assert.strictEqual(byId.get(server.runtime).type, 'mcp-runtime');
    assert.strictEqual(byId.get(server.auth).type, 'mcp-auth');
    assert.strictEqual(byId.get(byId.get(server.auth).redis).type, 'mcp-redis');
    assert.strictEqual(server.serverPort, undefined);
    assert.deepStrictEqual(server.wires, []);
    for (const tool of flow.filter(node => node.type === 'mcp-tool-registry')) {
        assert.strictEqual(tool.endpoint, server.serverPath);
        let next = byId.get(tool.wires[0][0]);
        while (next.type !== 'mcp-tool-response') next = byId.get(next.wires[0][0]);
        assert.match(tool.toolName, /^[a-z][a-z0-9_]*$/);
        JSON.parse(tool.toolSchema);
    }
    for (const node of flow) {
        for (const [field, value] of Object.entries(node)) {
            if (field.endsWith('Env') && value) assert.match(value, /^MCP_[A-Z0-9_]+$/, node.id + '.' + field);
        }
    }
    assert.equal(flow.find(node => node.type === 'mcp-redis').redisUrlEnv, 'MCP_REDIS_URL');
    for (const node of flow) {
        for (const port of node.wires || []) for (const target of port) assert.ok(byId.has(target), target);
        if (node.z) assert.strictEqual(byId.get(node.z).type, 'tab');
    }
    assert.ok(flow.some(node => node.type === 'comment'));
});

it('keeps editor templates within the Creating Nodes appearance and safety rules', () => {
    const { readFileSync } = require('node:fs');
    const basenames = new Set();
    for (const file of Object.values(manifest['node-red'].nodes)) {
        const basename = file.replace(/\.js$/, '');
        basenames.add(basename);
        const html = readFileSync(resolve(__dirname, '..', basename + '.html'), 'utf8');
        assert.doesNotMatch(html, /class="btn\b/, file + ' uses Bootstrap buttons');
        assert.doesNotMatch(html, /\.(click|change)\(/, file + ' uses deprecated jQuery shorthands');
        assert.doesNotMatch(html, /#(9C27B0|E91E63|e74c3c|f39c12)\b/i, file + ' uses off-palette colours');
        assert.doesNotMatch(html, /<strong>/, file + ' uses styling markup in help');
        assert.doesNotMatch(html, /\.html\(/, file + ' writes HTML strings into the dialog');
        assert.doesNotMatch(html, /data-help-name=/, file + ' should move help text into locales/en-US');
        const registrations = html.match(/registerType\('[^']+'/g) || [];
        assert.strictEqual((html.match(/paletteLabel:/g) || []).length, registrations.length, file + ' paletteLabel');
    }
    for (const basename of basenames) {
        const localeJsonPath = resolve(__dirname, '..', 'locales/en-US', basename + '.json');
        const localeHtmlPath = resolve(__dirname, '..', 'locales/en-US', basename + '.html');
        assert.ok(existsSync(localeJsonPath), basename + ' is missing its locales/en-US message catalog');
        assert.ok(existsSync(localeHtmlPath), basename + ' is missing its locales/en-US help translation');
        JSON.parse(readFileSync(localeJsonPath, 'utf8'));
        const localeHtml = readFileSync(localeHtmlPath, 'utf8');
        const helps = localeHtml.match(/data-help-name="[^"]+">[\s\S]*?<\/script>/g) || [];
        assert.ok(helps.length > 0, basename + ' locale help file has no data-help-name blocks');
        for (const help of helps) assert.match(help, /<h3>(Inputs|Outputs|Details)<\/h3>/, help.slice(0, 40));
    }
});

// MCP-DEP-2
it('keeps the runtime dependency list minimal', () => {
    assert.deepStrictEqual(Object.keys(manifest.dependencies).sort(), ['ajv', 'express', 'ioredis', 'jose']);
    assert.strictEqual(manifest.dependencies['node-cache'], undefined);
    assert.strictEqual(manifest.dependencies.axios, undefined);
    assert.strictEqual(manifest.dependencies['ipaddr.js'], undefined);
});
