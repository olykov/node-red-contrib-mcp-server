'use strict';

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const helper = require('node-red-node-test-helper');
const { mcpFetch } = require('./helpers/mcp-request');

helper.init(require.resolve('node-red'));

function registerPackageNodes(RED) {
    require('../nr-mcp-auth')(RED);
    require('../nr-mcp-endpoint')(RED);
    require('../nr-mcp-metrics')(RED);
    require('../nr-mcp-tool')(RED);
}

async function unusedPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function waitFor(predicate) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Timed out waiting for Node-RED integration runtime');
}

describe('Node-RED runtime integration', () => {
    before(async () => {
        await helper.startServer();
    });

    after(async () => {
        await helper.unload();
        await helper.stopServer();
    });

    // MCP-MIG-1
    it('deploys a flow converted by nr-mcp-migrate and serves its tools', async () => {
        const { migrateFlow } = require('../lib/migration');
        const port = await unusedPort();
        const flows = migrateFlow(require('./fixtures/flows-3x.json')).flow
            .filter(node => node.type === 'tab' || node.type.startsWith('nr-mcp-'))
            .map(node => node.type === 'nr-mcp-runtime' ? { ...node, serverPort: port, publicBaseUrl: 'http://127.0.0.1:' + port } :
                node.type === 'nr-mcp-metrics' ? { ...node, wires: [[]] } : node);
        try {
            await helper.load(registerPackageNodes, flows);
            helper.getNode('auth').readAccessToken = async () => ({ groups: ['Sales'], scopes: ['openid'] });
            await waitFor(() => helper.getNode('endpoint-sales').isRunning);
            assert.equal(helper.getNode('tool-list').isRegistered, true);
            assert.equal(helper.getNode('tool-shared').isRegistered, true);
            assert.equal(helper.getNode('tool-orphan').isRegistered, false);
            const list = await mcpFetch('http://127.0.0.1:' + port + '/mcp/sales', {
                method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer migrated' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
            });
            assert.deepEqual((await list.json()).result.tools.map(tool => tool.name), ['list_items', 'ping']);
        } finally {
            await helper.unload();
        }
    });

    // MCP-NAME-1
    it('loads next to the upstream node-red-contrib-mcp-server node types', async () => {
        const upstreamTypes = ['mcp-server', 'mcp-client', 'mcp-tool', 'mcp-flow-server', 'mcp-tool-registry'];
        function registerUpstreamTypes(RED) {
            for (const type of upstreamTypes) RED.nodes.registerType(type, function (config) { RED.nodes.createNode(this, config); });
        }
        try {
            await helper.load([registerUpstreamTypes, registerPackageNodes], [
                { id: 'up-tab', type: 'tab', label: 'Upstream' },
                ...upstreamTypes.map(type => ({ id: 'up-' + type, type, z: 'up-tab', wires: [] })),
                { id: 'own-runtime', type: 'nr-mcp-runtime', serverPort: await unusedPort(), bindHost: '127.0.0.1',
                    publicBaseUrl: 'http://127.0.0.1' }
            ]);
            for (const type of upstreamTypes) assert.equal(helper.getNode('up-' + type).type, type);
            assert.equal(helper.getNode('own-runtime').type, 'nr-mcp-runtime');
        } finally {
            await helper.unload();
        }
    });

    // MCP-NODE-4, MCP-NODE-5
    it('lists tools right after deploy and reopens the runtime port exactly once on redeploy', async () => {
        const http = require('node:http');
        const port = await unusedPort();
        const flows = [
            { id: 'rt-tab', type: 'tab', label: 'Runtime' },
            { id: 'rt-runtime', type: 'nr-mcp-runtime', name: 'Runtime', serverPort: port,
                bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:' + port },
            { id: 'rt-storage', type: 'nr-mcp-auth-storage', mode: 'memory' },
            { id: 'rt-auth', type: 'nr-mcp-auth', oauthSlug: 'runtime-login', provider: 'oidc', issuerUrl: 'https://idp.example.test',
                clientId: 'client', allowedClientHosts: 'client.example.test', redis: 'rt-storage' },
            { id: 'rt-endpoint', type: 'nr-mcp-endpoint', runtime: 'rt-runtime', auth: 'rt-auth',
                serverName: 'runtime', serverPath: '/mcp/runtime', allowedGroups: 'runtime-users' },
            ...['alpha', 'beta'].map(name => ({ id: 'rt-' + name, type: 'nr-mcp-tool', z: 'rt-tab', toolName: name,
                scope: 'endpoint', endpoint: 'rt-endpoint', toolSchema: '{"type":"object","properties":{}}', wires: [[]] }))
        ];
        const listen = http.Server.prototype.listen;
        const close = http.Server.prototype.close;
        const calls = [];
        http.Server.prototype.listen = function (...args) {
            if (args[0] === port) calls.push('listen');
            return listen.apply(this, args);
        };
        http.Server.prototype.close = function (...args) {
            const address = this.address();
            if (address && address.port === port) calls.push('close');
            return close.apply(this, args);
        };
        try {
            await helper.load(registerPackageNodes, flows);
            const auth = helper.getNode('rt-auth');
            auth.readAccessToken = async token => token === 'runtime-token' ? { groups: ['runtime-users'], scopes: ['openid'] } : null;
            await waitFor(() => helper.getNode('rt-endpoint').isRunning);
            const list = await mcpFetch('http://127.0.0.1:' + port + '/mcp/runtime', {
                method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer runtime-token' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
            });
            assert.deepEqual((await list.json()).result.tools.map(tool => tool.name), ['alpha', 'beta']);
            assert.deepEqual(calls, ['listen']);

            await helper.setFlows(flows.map(node => node.id === 'rt-runtime' ? { ...node, name: 'Runtime renamed' } : node), 'full');
            await waitFor(() => helper.getNode('rt-endpoint').isRunning);
            assert.deepEqual(calls, ['listen', 'close', 'listen']);
        } finally {
            http.Server.prototype.listen = listen;
            http.Server.prototype.close = close;
            await helper.unload();
        }
    });

    it('deploys runtime, config and tool nodes; handles auth, admin listing, modified nodes and close', async () => {
        const port = await unusedPort();
        const flows = [
            { id: 'it-tab', type: 'tab', label: 'Integration' },
            { id: 'it-runtime', type: 'nr-mcp-runtime', name: 'Integration runtime',
                serverPort: port, bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:' + port,
                allowedOrigins: 'https://trusted.example.test',
                adminPort: '', adminEndpointPath: '' },
            { id: 'it-storage', type: 'nr-mcp-auth-storage', name: 'Integration storage', mode: 'memory',
                redisUrlEnv: 'MCP_REDIS_URL', host: '127.0.0.1', port: 6379, db: 0, tls: false,
                username: '', passwordEnv: '', keyPrefix: 'mcp_auth:' },
            { id: 'it-auth', type: 'nr-mcp-auth', name: 'Integration auth', oauthSlug: 'integration',
                provider: 'oidc', issuerUrl: 'https://idp.example.test', clientId: 'integration-client',
                clientSecretEnv: '', microsoftTenantId: '', microsoftClientId: '', microsoftClientSecretEnv: '',
                allowedClientHosts: 'client.example.test', groupClaim: 'groups', userClaim: 'email',
                redis: 'it-storage', accessTokenTtl: 900, refreshTokenTtl: 604800, sessionTtl: 1814400 },
            { id: 'it-endpoint', type: 'nr-mcp-endpoint', name: 'Integration endpoint',
                runtime: 'it-runtime', auth: 'it-auth', serverName: 'integration',
                serverPath: '/mcp/integration', allowedGroups: 'integration-users' },
            { id: 'it-tool', type: 'nr-mcp-tool', z: 'it-tab', name: 'Integration tool',
                toolName: 'integration_tool', toolDescription: 'A test tool', scope: 'endpoint', endpoint: 'it-endpoint',
                toolBehavior: 'read', worldAccess: 'closed',
                toolSchema: '{"type":"object","properties":{}}', outputSchema: '', timeoutMs: 1000,
                cancelOutput: true, outputs: 2, wires: [['it-output'], ['it-cancel']] },
            { id: 'it-output', type: 'helper', z: 'it-tab', wires: [] },
            { id: 'it-cancel', type: 'helper', z: 'it-tab', wires: [] },
            { id: 'it-response', type: 'nr-mcp-tool-response', z: 'it-tab', wires: [] }
        ];

        await helper.load(registerPackageNodes, flows, {
            'it-runtime': { adminToken: 'credential-test-value' }
        });
        const endpoint = helper.getNode('it-endpoint');
        const runtime = helper.getNode('it-runtime');
        const auth = helper.getNode('it-auth');
        const output = helper.getNode('it-output');
        assert.ok(endpoint && runtime && auth && output);
        assert.equal(runtime.credentials.adminToken, 'credential-test-value');
        await waitFor(() => endpoint.isRunning);
        assert.equal(endpoint.httpServer.address().address, '127.0.0.1');

        const adminListing = await helper.request().get('/nr-mcp-endpoints').expect(200);
        assert.ok(adminListing.body.servers.some(item => item.endpointId === 'it-endpoint'));

        auth.readAccessToken = async token => token === 'integration-token' ?
            { groups: ['integration-users'], scopes: ['openid'], subject: 'integration-user' } : null;
        const discovered = await mcpFetch('http://127.0.0.1:' + port + '/mcp/integration', {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer integration-token' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' })
        });
        assert.equal(discovered.status, 200);
        assert.equal((await discovered.json()).result._meta['io.modelcontextprotocol/serverInfo'].name, 'integration');

        for (const origin of ['http://127.0.0.1:' + port, 'https://trusted.example.test', undefined]) {
            const headers = { 'content-type': 'application/json', authorization: 'Bearer integration-token' };
            if (origin) headers.origin = origin;
            const accepted = await mcpFetch('http://127.0.0.1:' + port + '/mcp/integration', {
                method: 'POST', headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'server/discover' })
            });
            assert.equal(accepted.status, 200);
            await accepted.json();
        }

        const rejectedOrigin = await mcpFetch('http://127.0.0.1:' + port + '/mcp/integration', {
            method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.test' },
            body: '{invalid-json'
        });
        assert.equal(rejectedOrigin.status, 403);

        const anonymousList = await mcpFetch('http://127.0.0.1:' + port + '/mcp/integration', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        });
        assert.equal(anonymousList.status, 401);

        await waitFor(() => helper.getNode('it-tool').isRegistered);
        const authorizedList = await mcpFetch('http://127.0.0.1:' + port + '/mcp/integration', {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer integration-token' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
        });
        assert.equal(authorizedList.status, 200);
        assert.ok((await authorizedList.json()).result.tools.some(tool => tool.name === 'integration_tool'));

        const originalServer = endpoint.httpServer;
        const modifiedFlows = flows.map(node => node.id === 'it-tool' ?
            { ...node, toolDescription: 'Modified integration tool' } : node);
        await helper.setFlows(modifiedFlows, 'nodes');
        await waitFor(() => helper.getNode('it-tool').isRegistered);
        assert.equal(helper.getNode('it-endpoint').httpServer, originalServer);
        assert.equal(helper.getNode('it-endpoint').isRunning, true);

        // MCP-NODE-3
        await helper.setFlows(modifiedFlows.map(node => node.id === 'it-tool' ? { ...node, toolDescription: 'Flows deploy' } : node), 'flows');
        await waitFor(() => helper.getNode('it-tool').isRegistered);
        assert.equal(helper.getNode('it-endpoint'), endpoint);
        assert.equal(helper.getNode('it-endpoint').httpServer, originalServer);
        assert.equal(helper.getNode('it-endpoint').isRunning, true);
        assert.equal(helper.getNode('it-tool').toolDescription, 'Flows deploy');

        const callTool = (id, signal) => mcpFetch('http://127.0.0.1:' + port + '/mcp/integration', {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer integration-token' },
            body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'integration_tool', arguments: { q: 1 } } }),
            signal
        });
        const nextMessage = node => new Promise(resolve => node.once('input', resolve));
        const callOutput = helper.getNode('it-output');
        const cancelOutput = helper.getNode('it-cancel');

        // MCP-NODE-1, MCP-NODE-2
        let delivered = nextMessage(callOutput);
        const answered = callTool(4);
        const call = await delivered;
        assert.deepEqual(call.payload, { q: 1 });
        assert.deepEqual(Object.keys(call.mcp).sort(), ['client', 'email', 'executionId', 'groups', 'subject', 'toolName']);
        assert.equal(call.mcp.toolName, 'integration_tool');
        assert.equal(call.mcp.subject, 'integration-user');
        helper.getNode('it-response').receive({ ...call, payload: 'done' });
        assert.equal((await (await answered).json()).result.content[0].text, 'done');

        // MCP-NODE-6
        delivered = nextMessage(callOutput);
        let cancelled = nextMessage(cancelOutput);
        const abort = new AbortController();
        const aborted = callTool(5, abort.signal).catch(error => error);
        const started = await delivered;
        abort.abort();
        await aborted;
        assert.deepEqual((await cancelled).mcp, { executionId: started.mcp.executionId, toolName: 'integration_tool', reason: 'cancelled' });

        delivered = nextMessage(callOutput);
        cancelled = nextMessage(cancelOutput);
        const timedOut = callTool(6);
        const slow = await delivered;
        assert.deepEqual((await cancelled).mcp, { executionId: slow.mcp.executionId, toolName: 'integration_tool', reason: 'timeout' });
        assert.equal((await (await timedOut).json()).result.content[0].text, 'Tool execution timeout');

        delivered = nextMessage(callOutput);
        const pendingCall = callTool(7);
        await delivered;
        await helper.unload();
        const closedResponse = await pendingCall;
        assert.equal(closedResponse.status, 200);
        const closedBody = await closedResponse.json();
        assert.equal(closedBody.result.isError, true);
        assert.equal(closedBody.result.content[0].text, 'MCP server stopped before tool execution completed');
    });
});
