'use strict';
// Read-only Node-RED admin tools exposed over MCP, implemented against Node-RED's
// own Admin HTTP API. httpRequest is injectable so this is unit-testable without a
// running Node-RED admin API.

const http = require('http');

function defaultHttpRequest(method, hostname, port, path, headers, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const hdrs = Object.assign({ 'Content-Type': 'application/json', 'Node-RED-API-Version': 'v2' }, headers);
        if (data) hdrs['Content-Length'] = Buffer.byteLength(data);
        const req = http.request({ method, hostname, port, path, headers: hdrs }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode, body: raw }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const TOOLS = [
    {
        name        : 'get_flow',
        description : 'Lists all Node-RED tabs (ID and node count) when called without arguments. ' +
                      'Returns full JSON configuration for a specific tab when called with an id.',
        inputSchema : {
            type       : 'object',
            properties : {
                id : { type: 'string', description: 'Flow/tab ID — omit to list all flows' }
            }
        },
        outputSchema : {
            type       : 'object',
            properties : {
                mode  : { type: 'string', enum: ['list', 'flow'] },
                flows : {
                    type  : 'array',
                    items : {
                        type       : 'object',
                        properties : {
                            id        : { type: 'string' },
                            label     : { type: 'string' },
                            disabled  : { type: 'boolean' },
                            nodeCount : { type: 'number' }
                        },
                        required             : ['id', 'label', 'disabled', 'nodeCount'],
                        additionalProperties : false
                    }
                },
                id    : { type: 'string' },
                flow  : { type: 'object' },
                error : {
                    type       : 'object',
                    properties : {
                        code    : { type: 'string' },
                        message : { type: 'string' }
                    },
                    required             : ['code', 'message'],
                    additionalProperties : false
                }
            },
            required             : ['mode'],
            additionalProperties : false
        }
    }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

function createAdminTools({ adminPort, getAdminToken, httpRequest = defaultHttpRequest }) {

    function adminApi(method, path, body) {
        const token = process.env.NODE_RED_ADMIN_API_TOKEN || (getAdminToken && getAdminToken()) || '';
        const hdrs  = token ? { Authorization: 'Bearer ' + token } : {};
        return httpRequest(method, '127.0.0.1', adminPort, path, hdrs, body);
    }

    async function callTool(toolName, args) {
        // Flow IDs go straight into the admin HTTP path; constrain to the Node-RED id
        // charset so a crafted id can't traverse or inject into it.
        if (args.id !== undefined && !/^[A-Za-z0-9._-]+$/.test(String(args.id))) {
            const err = new Error('Invalid flow id');
            err.rpcCode = -32602;
            throw err;
        }

        if (toolName === 'get_flow') {
            if (!args.id) {
                const r        = await adminApi('GET', '/flows');
                if (r.status < 200 || r.status >= 300) {
                    return 'Admin API failed (' + r.status + '): ' + JSON.stringify(r.body);
                }
                const allNodes = Array.isArray(r.body) ? r.body
                    : (Array.isArray(r.body && r.body.flows) ? r.body.flows : []);
                const tabs  = allNodes.filter(n => n.type === 'tab');
                // Labels are interpolated into markdown shown to the calling model as-is.
                // They come from the flow author via the editor, who is already trusted with
                // far more than formatting, so no escaping here.
                const lines = ['**Node-RED flow tabs:**', ''];
                const flows = tabs.map(tab => {
                    const count = allNodes.filter(n => n.z === tab.id).length;
                    lines.push('- **' + tab.label + '**' + (tab.disabled ? ' [disabled]' : ''));
                    lines.push('  ID: `' + tab.id + '`  |  Nodes: ' + count);
                    return {
                        id        : tab.id,
                        label     : tab.label || '',
                        disabled  : Boolean(tab.disabled),
                        nodeCount : count
                    };
                });
                return {
                    content           : [{ type: 'text', text: lines.join('\n') }],
                    structuredContent : { mode: 'list', flows }
                };
            }
            const r = await adminApi('GET', '/flow/' + args.id);
            if (r.status === 404) {
                const structuredContent = {
                    mode  : 'flow',
                    id    : String(args.id),
                    error : { code: 'FLOW_NOT_FOUND', message: 'Flow not found.' }
                };
                return {
                    content : [{
                        type : 'text',
                        text : 'Flow \'' + args.id + '\' not found.'
                    }],
                    structuredContent
                };
            }
            if (r.status < 200 || r.status >= 300) {
                return 'Admin API failed (' + r.status + '): ' + JSON.stringify(r.body);
            }
            return {
                content           : [{ type: 'text', text: JSON.stringify(r.body, null, 2) }],
                structuredContent : { mode: 'flow', id: String(args.id), flow: r.body || {} }
            };
        }

        return undefined;
    }

    return { TOOLS, TOOL_NAMES, callTool };
}

module.exports = { createAdminTools, TOOLS, TOOL_NAMES };
