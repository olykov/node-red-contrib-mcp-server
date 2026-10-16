'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-red-mcp-smoke-'));
const packDirectory = path.join(temporaryRoot, 'pack');
const userDirectory = path.join(temporaryRoot, 'user');
const requestedNodeRed = process.env.NODE_RED_TEST_VERSION || 'latest';
fs.mkdirSync(packDirectory);
fs.mkdirSync(userDirectory);

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

function waitForChild(child, timeoutMs) {
    return new Promise(resolve => {
        const timeout = setTimeout(() => resolve(false), timeoutMs);
        child.once('close', () => {
            clearTimeout(timeout);
            resolve(true);
        });
    });
}

async function main() {
    const packedName = execFileSync('npm', ['pack', '--pack-destination', packDirectory], {
        cwd: repository, encoding: 'utf8'
    }).trim().split(/\r?\n/).at(-1);
    const tarball = path.join(packDirectory, packedName);
    const port = await freePort();
    const flow = JSON.parse(fs.readFileSync(path.join(repository, 'examples/flow-based-mcp-server-example.json'), 'utf8'));
    const runtime = flow.find(node => node.type === 'mcp-runtime');
    runtime.serverPort = port;
    runtime.bindHost = '127.0.0.1';
    runtime.publicBaseUrl = 'http://127.0.0.1:' + port;
    fs.writeFileSync(path.join(userDirectory, 'flows.json'), JSON.stringify(flow));
    fs.writeFileSync(path.join(userDirectory, 'settings.js'), [
        "'use strict';",
        'module.exports = { uiPort: 0, userDir: __dirname, flowFile: "flows.json", credentialSecret: "smoke-test-only", logging: { console: { level: "off" } } };'
    ].join('\n'));

    execFileSync('npm', [
        'install', '--prefix', userDirectory, '--no-save', '--no-package-lock', '--omit=dev',
        tarball, 'node-red@' + requestedNodeRed
    ], { cwd: repository, stdio: 'inherit' });

    const executable = path.join(userDirectory, 'node_modules', '.bin', 'node-red');
    const child = spawn(executable, ['--userDir', userDirectory, '--settings', path.join(userDirectory, 'settings.js')], {
        cwd: userDirectory, env: process.env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-12000); });

    try {
        const deadline = Date.now() + 30000;
        let initialized = false;
        while (Date.now() < deadline && child.exitCode === null && !spawnError) {
            try {
                const response = await fetch('http://127.0.0.1:' + port + '/mcp/example', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })
                });
                if (response.status === 200) {
                    const body = await response.json();
                    if (body.result && body.result.serverInfo.version === require('../package.json').version) {
                        initialized = true;
                        break;
                    }
                }
            } catch {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        if (!initialized) throw new Error(
            (spawnError ? 'Node-RED failed to start: ' + spawnError.message : 'Node-RED did not serve the packed example.') +
            '\n' + output
        );

        const unauthorized = await fetch('http://127.0.0.1:' + port + '/mcp/example', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        });
        if (unauthorized.status !== 401) throw new Error('Expected tools/list to require authentication.');

        const malformed = await fetch('http://127.0.0.1:' + port + '/mcp/example', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid-json'
        });
        const malformedBody = await malformed.json();
        if (malformed.status !== 400 || malformedBody.error.code !== -32700)
            throw new Error('Invalid JSON smoke request returned an unexpected response.');

        const tooLarge = await fetch('http://127.0.0.1:' + port + '/mcp/example', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', pad: 'x'.repeat(300 * 1024) })
        });
        const tooLargeBody = await tooLarge.json();
        if (tooLarge.status !== 413 || tooLargeBody.error.code !== -32600)
            throw new Error('Oversized JSON smoke request returned an unexpected response.');
    } finally {
        child.kill('SIGTERM');
        if (!await waitForChild(child, 5000)) child.kill('SIGKILL');
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
