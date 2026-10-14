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
