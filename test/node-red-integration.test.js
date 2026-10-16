'use strict';

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const helper = require('node-red-node-test-helper');

helper.init(require.resolve('node-red'));

function registerPackageNodes(RED) {
    require('../mcp-auth')(RED);
    require('../mcp-flow-server')(RED);
    require('../mcp-server-metrics')(RED);
    require('../mcp-tool-registry')(RED);
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

    it('deploys runtime, config and tool nodes; handles auth, admin listing, modified nodes and close', async () => {
        const port = await unusedPort();
        const flows = [
            { id: 'it-tab', type: 'tab', label: 'Integration' },
            { id: 'it-runtime', type: 'mcp-runtime', name: 'Integration runtime', runtimeName: 'integration',
                serverPort: port, bindHost: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:' + port,
                allowedOrigins: 'https://trusted.example.test',
                adminPort: '', adminEndpointPath: '' },
            { id: 'it-storage', type: 'mcp-redis', name: 'Integration storage', mode: 'memory',
                redisUrlEnv: 'MCP_REDIS_URL', host: '127.0.0.1', port: 6379, db: 0, tls: false,
                username: '', passwordEnv: '', keyPrefix: 'mcp_auth:' },
            { id: 'it-auth', type: 'mcp-auth', name: 'Integration auth', oauthSlug: 'integration',
                provider: 'oidc', issuerUrl: 'https://idp.example.test', clientId: 'integration-client',
                clientSecretEnv: '', microsoftTenantId: '', microsoftClientId: '', microsoftClientSecretEnv: '',
                allowedClientHosts: 'client.example.test', groupClaim: 'groups', userClaim: 'email',
                redis: 'it-storage', accessTokenTtl: 900, refreshTokenTtl: 604800, sessionTtl: 1814400 },
            { id: 'it-endpoint', type: 'mcp-flow-server', z: 'it-tab', name: 'Integration endpoint',
                runtime: 'it-runtime', auth: 'it-auth', serverName: 'integration',
                serverPath: '/mcp/integration', allowedGroups: 'integration-users', wires: [] },
            { id: 'it-tool', type: 'mcp-tool-registry', z: 'it-tab', name: 'Integration tool',
                toolName: 'integration_tool', toolDescription: 'A test tool', endpoint: '/mcp/integration',
                toolBehavior: 'read', worldAccess: 'closed',
                toolSchema: '{"type":"object","properties":{}}', outputSchema: '', wires: [] },
            { id: 'it-output', type: 'helper', z: 'it-tab', wires: [] }
        ];
        flows.find(node => node.id === 'it-endpoint').wires = [['it-output']];

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

        const adminListing = await helper.request().get('/mcp-flow-servers').expect(200);
        assert.ok(adminListing.body.servers.some(item => item.endpointId === 'it-endpoint'));

        const initialized = await fetch('http://127.0.0.1:' + port + '/mcp/integration', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })
        });
        assert.equal(initialized.status, 200);
        assert.equal((await initialized.json()).result.serverInfo.name, 'integration');

        for (const origin of ['http://127.0.0.1:' + port, 'https://trusted.example.test', undefined]) {
            const headers = { 'content-type': 'application/json' };
            if (origin) headers.origin = origin;
            const accepted = await fetch('http://127.0.0.1:' + port + '/mcp/integration', {
                method: 'POST', headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize' })
            });
            assert.equal(accepted.status, 200);
            await accepted.json();
        }

        const rejectedOrigin = await fetch('http://127.0.0.1:' + port + '/mcp/integration', {
            method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.test' },
            body: '{invalid-json'
        });
        assert.equal(rejectedOrigin.status, 403);

        const anonymousList = await fetch('http://127.0.0.1:' + port + '/mcp/integration', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        });
        assert.equal(anonymousList.status, 401);

        auth.readAccessToken = async token => token === 'integration-token' ?
            { groups: ['integration-users'], scopes: ['openid'], subject: 'integration-user' } : null;
        await waitFor(() => helper.getNode('it-tool').isRegistered);
        const authorizedList = await fetch('http://127.0.0.1:' + port + '/mcp/integration', {
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

        const executeMessage = new Promise(resolve => output.once('input', resolve));
        const pendingCall = fetch('http://127.0.0.1:' + port + '/mcp/integration', {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer integration-token' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call',
                params: { name: 'integration_tool', arguments: {} } })
        });
        const message = await executeMessage;
        assert.equal(message.topic, 'mcp-tool-execute');
        await helper.unload();
        const closedResponse = await pendingCall;
        assert.equal(closedResponse.status, 200);
        const closedBody = await closedResponse.json();
        assert.equal(closedBody.result.isError, true);
        assert.equal(closedBody.result.content[0].text, 'MCP server stopped before tool execution completed');
    });
});
