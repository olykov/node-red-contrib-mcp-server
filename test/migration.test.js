'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { migrateFlow } = require('../lib/migration');

const FIXTURE = path.join(__dirname, 'fixtures', 'flows-3x.json');
const CLI = path.join(__dirname, '..', 'bin', 'nr-mcp-migrate.js');
const fixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

function actions(report, id) {
    return report.manualReview.filter(item => item.id === id).map(item => item.action);
}

describe('migrateFlow', () => {
    // MCP-MIG-1
    it('converts every 3.x configuration and tool node and keeps node ids', () => {
        const input = fixture();
        const report = migrateFlow(input);
        const byId = new Map(report.flow.map(node => [node.id, node]));
        assert.deepEqual(report.flow.map(node => node.id), input.map(node => node.id).filter(id => id !== 'endpoint-ops'));
        assert.equal(report.converted, 9);
        assert.equal(report.unchanged, input.length - 1 - 9);
        assert.ok(report.flow.every(node => !String(node.type).startsWith('mcp-')));

        const runtime = byId.get('runtime');
        assert.equal(runtime.type, 'nr-mcp-runtime');
        assert.equal(runtime.runtimeName, undefined);
        assert.equal(runtime.adminCa, undefined);
        assert.ok(!('adminEndpointPath' in runtime));
        assert.deepEqual(pick(runtime, ['adminTools', 'adminPath', 'adminAuth', 'adminGroups']),
            { adminTools: true, adminPath: '/mcp/ops', adminAuth: 'auth', adminGroups: 'Ops, Admins, Auditors' });
        assert.equal(byId.get('storage').type, 'nr-mcp-auth-storage');
        assert.equal(byId.get('auth').type, 'nr-mcp-auth');
        assert.equal(byId.get('auth').redis, 'storage');
        assert.equal(byId.get('metrics').type, 'nr-mcp-metrics');
        assert.deepEqual(byId.get('metrics').wires, [['metrics-debug']]);

        const endpoint = byId.get('endpoint-sales');
        assert.equal(endpoint.type, 'nr-mcp-endpoint');
        for (const field of ['z', 'g', 'x', 'y', 'wires']) assert.equal(endpoint[field], undefined, field);
        assert.equal(endpoint.toolTimeoutMs, 60000);
        assert.equal(byId.get('endpoint-ops'), undefined);
        assert.equal(endpoint.allowedGroups, 'Sales');
        assert.equal(runtime.codeGroups, 'Code, Readers');
        assert.deepEqual(byId.get('group-sales').nodes, ['tool-list']);

        assert.deepEqual(pick(byId.get('tool-list'), ['type', 'scope', 'endpoint', 'runtime', 'outputs', 'wires', 'timeoutMs']),
            { type: 'nr-mcp-tool', scope: 'endpoint', endpoint: 'endpoint-sales', runtime: '', outputs: 1, wires: [[]], timeoutMs: 5000 });
        assert.deepEqual(pick(byId.get('tool-shared'), ['scope', 'endpoint', 'runtime']), { scope: 'shared', endpoint: '', runtime: 'runtime' });
        assert.deepEqual(pick(byId.get('tool-orphan'), ['scope', 'endpoint']), { scope: 'endpoint', endpoint: '' });
        assert.deepEqual(pick(byId.get('tool-unbound'), ['scope', 'endpoint', 'runtime']), { scope: 'shared', endpoint: '', runtime: 'runtime' });

        assert.deepEqual(byId.get('restart').wires, [[]]);
        assert.deepEqual(byId.get('answers-in').wires, [[]]);
        assert.deepEqual(byId.get('unrelated'), input.find(node => node.id === 'unrelated'));
    });

    it('moves a 4.x admin endpoint into the runtime Admin Tools unless tools still use it', () => {
        const flow = [
            { id: 'rt', type: 'nr-mcp-runtime', adminEndpointPath: '/internal/ops' },
            { id: 'ops', type: 'nr-mcp-endpoint', runtime: 'rt', auth: 'auth', serverPath: '/internal/ops', allowedGroups: 'Operators' },
            { id: 'other', type: 'nr-mcp-endpoint', runtime: 'rt', auth: 'auth', serverPath: '/mcp/other', allowedGroups: 'Users' }
        ];
        const moved = migrateFlow(flow);
        assert.deepEqual(moved.flow.map(node => node.id), ['rt', 'other']);
        assert.deepEqual(pick(moved.flow[0], ['adminTools', 'adminPath', 'adminAuth', 'adminGroups']),
            { adminTools: true, adminPath: '/internal/ops', adminAuth: 'auth', adminGroups: 'Operators' });

        const used = migrateFlow([...flow, { id: 'tool', type: 'nr-mcp-tool', scope: 'endpoint', endpoint: 'ops' }]);
        assert.ok(used.flow.some(node => node.id === 'ops'));
        assert.match(actions(used, 'ops')[0], /Move its tools to another endpoint/);

        const missing = migrateFlow([{ id: 'rt', type: 'nr-mcp-runtime', adminEndpointPath: '/internal/none' }]);
        assert.match(actions(missing, 'rt')[0], /Select Auth and Groups of Admin Tools/);
        assert.equal(migrateFlow([{ id: 'rt', type: 'nr-mcp-runtime' }]).flow[0].adminTools, false);
    });

    // MCP-MIG-1
    it('lists every routing node and setting that needs a manual step', () => {
        const report = migrateFlow(fixture());
        assert.deepEqual(report.manualReview.map(item => item.id).sort(), ['answers-in', 'calls-out', 'list-items', 'restart',
            'route-list', 'runtime', 'runtime', 'tool-list', 'tool-orphan', 'tool-orphan', 'tool-shared', 'tool-unbound',
            'catch-endpoint'].sort());
        assert.match(actions(report, 'catch-endpoint')[0], /scope includes an endpoint/);
        assert.match(actions(report, 'tool-list')[0], /Wire this tool to its flow, the branch of switch route-list/);
        assert.match(actions(report, 'route-list')[0], /Remove this switch/);
        assert.match(actions(report, 'calls-out')[0], /received tool calls from endpoint endpoint-sales/);
        assert.match(actions(report, 'answers-in')[0], /nr-mcp-tool-response/);
        assert.match(actions(report, 'restart')[0], /nr-mcp-tool-response/);
        assert.match(actions(report, 'list-items')[0], /msg\.mcp\.executionId/);
        assert.match(actions(report, 'tool-orphan').join('\n'), /no endpoint serves \/mcp\/missing/);
        assert.match(actions(report, 'runtime').join('\n'), /NODE_EXTRA_CA_CERTS/);
        assert.match(actions(report, 'runtime').join('\n'), /NODE_RED_ADMIN_API_TOKEN is no longer read/);
    });

    it('asks for an endpoint or runtime choice when the 3.x binding is ambiguous', () => {
        const flow = fixture();
        flow.push({ id: 'runtime-2', type: 'mcp-runtime', serverPort: 8002 },
            { id: 'endpoint-sales-2', type: 'mcp-flow-server', runtime: 'runtime-2', serverPath: 'mcp/sales', wires: [] });
        const report = migrateFlow(flow);
        const byId = new Map(report.flow.map(node => [node.id, node]));
        assert.equal(byId.get('tool-list').endpoint, '');
        assert.match(actions(report, 'tool-list').join('\n'), /endpoint-sales, endpoint-sales-2 serve \/mcp\/sales/);
        assert.equal(byId.get('tool-shared').runtime, '');
        assert.match(actions(report, 'tool-shared').join('\n'), /the flow has 2 runtimes/);
    });

    it('never copies credentials and accepts the Admin API flows object', () => {
        const flows = fixture();
        flows.find(node => node.id === 'runtime').credentials = { adminToken: 'secret-value' };
        const report = migrateFlow({ rev: 'abc', flows });
        assert.equal(report.flow.rev, 'abc');
        assert.ok(!JSON.stringify(report.flow).includes('secret-value'));
        assert.match(actions(report, 'runtime').join('\n'), /flows_cred\.json/);
        assert.throws(() => migrateFlow({ nodes: [] }), /array of nodes/);
    });

    it('leaves a 4.0 flow unchanged', () => {
        const migrated = migrateFlow(fixture()).flow;
        const again = migrateFlow(migrated);
        assert.equal(again.converted, 0);
        assert.deepEqual(again.flow, migrated);
        assert.deepEqual(again.manualReview.map(item => item.id), ['route-list', 'list-items']);
    });
});

// MCP-MIG-1
it('keeps the 3.x credential field names, so flows_cred.json stays valid', () => {
    const options = {};
    const RED = { events: { on() {}, removeListener() {} }, httpAdmin: { get() {}, post() {} },
        nodes: { registerType(type, ctor, opts) { options[type] = Object.keys((opts && opts.credentials) || {}); } } };
    require('../nr-mcp-auth')(RED);
    require('../nr-mcp-endpoint')(RED);
    assert.deepEqual(options['nr-mcp-runtime'], ['adminToken']);
    assert.deepEqual(options['nr-mcp-auth-storage'], ['password']);
    assert.deepEqual(options['nr-mcp-auth'], ['clientSecret', 'microsoftClientSecret', 'oidcRefreshKey', 'microsoftRefreshKey']);
});

function pick(node, fields) {
    return Object.fromEntries(fields.map(field => [field, node[field]]));
}

describe('nr-mcp-migrate', () => {
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

    // MCP-MIG-1
    it('writes a new file, prints the JSON report and exits 1 when manual review is needed', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-mcp-migrate-'));
        try {
            const output = path.join(dir, 'flows-4.json');
            const result = run('--input', FIXTURE, '--output', output);
            assert.equal(result.status, 1, result.stderr);
            const report = JSON.parse(result.stdout);
            assert.deepEqual(Object.keys(report), ['input', 'output', 'converted', 'unchanged', 'manualReview']);
            assert.equal(report.output, output);
            assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), migrateFlow(fixture()).flow);

            const again = run('--input', FIXTURE, '--output', output);
            assert.equal(again.status, 2);
            assert.match(again.stderr, /already exists/);
            assert.match(run('--input', FIXTURE, '--output', FIXTURE).stderr, /must differ/);

            const clean = path.join(dir, 'clean.json');
            fs.writeFileSync(clean, JSON.stringify([{ id: 'tab', type: 'tab' }]));
            assert.equal(run('--input', clean, '--output', path.join(dir, 'clean-4.json')).status, 0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('rejects incomplete arguments and prints usage on --help', () => {
        assert.equal(run('--input', FIXTURE).status, 2);
        assert.equal(run('--input').status, 2);
        assert.equal(run('--force').status, 2);
        const help = run('--help');
        assert.equal(help.status, 0);
        assert.match(help.stdout, /--input <flows.json> --output <new-flows.json>/);
    });
});
