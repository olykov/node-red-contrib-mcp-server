'use strict';

// Converts a 3.x flow to the 4.0 node contract. Node ids and credential field names are kept, so
// flows_cred.json stays valid without decryption. Tool-call routing (switch, link and function
// nodes) is not rewritten; those nodes are reported for manual replacement.

const TYPE_MAP = {
    'mcp-runtime': 'nr-mcp-runtime',
    'mcp-flow-server': 'nr-mcp-endpoint',
    'mcp-tool-registry': 'nr-mcp-tool',
    'mcp-server-metrics': 'nr-mcp-metrics',
    'mcp-auth': 'nr-mcp-auth',
    'mcp-redis': 'nr-mcp-auth-storage'
};

const OLD_PROTOCOL = /mcp-tool-response|mcp-tool-execute|payload\.executionId|payload\.arguments|payload\.toolName/;
const MESSAGE_FORMAT = 'Update the message format: arguments are in msg.payload, executionId in msg.mcp.executionId; ' +
    'answer with an nr-mcp-tool-response node, result in msg.payload, error in msg.mcp.error';

function normalizePath(value)
{
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return '';
    return raw.startsWith('/') ? raw : '/' + raw;
}

// 3.x split group lists on spaces and commas; 4.0 splits only on commas and new lines.
function commaGroups(value)
{
    return typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean).join(', ') : value;
}

function targets(node)
{
    return Array.isArray(node.wires) ? node.wires.flat().filter(id => typeof id === 'string') : [];
}

function migrateFlow(input)
{
    const wrapped = !Array.isArray(input);
    const source = wrapped ? input && input.flows : input;
    if (!Array.isArray(source)) throw new Error('Flow must be an array of nodes or an object with a flows array');
    const nodes = source.map(node => structuredClone(node));
    const manualReview = [];
    const reported = new Set();
    const review = (id, action) =>
    {
        const key = id + '\n' + action;
        if (reported.has(key)) return;
        reported.add(key);
        manualReview.push({ id, action });
    };

    const endpoints = nodes.filter(node => node.type === 'mcp-flow-server');
    const endpointIds = new Set(endpoints.map(node => node.id));
    const runtimes = nodes.filter(node => node.type === 'mcp-runtime');
    const routers = nodes.filter(node => node.type === 'switch' && node.property === 'payload.toolName');
    let converted = 0;

    for (const node of nodes)
    {
        if (node.credentials !== undefined)
        {
            delete node.credentials;
            review(node.id, 'Credentials were not copied; keep flows_cred.json next to the migrated flow');
        }

        if (node.type === 'mcp-runtime')
        {
            delete node.runtimeName;
            if (typeof node.adminCa === 'string' && node.adminCa.trim())
                review(node.id, 'Admin API CA was removed; start Node-RED with NODE_EXTRA_CA_CERTS set to that CA file');
            delete node.adminCa;
            node.codeGroups = commaGroups(node.codeGroups);
            if (node.adminEndpointPath && !node.adminTokenEnv)
                review(node.id, 'Confirm the Admin Token credential is set: NODE_RED_ADMIN_API_TOKEN is no longer read');
        }

        if (node.type === 'mcp-flow-server')
        {
            for (const target of targets(node))
                review(target, 'Remove this branch entry: it received tool calls from endpoint ' + node.id +
                    '; start the tool flow from its nr-mcp-tool node');
            for (const field of ['z', 'g', 'x', 'y', 'wires', 'inputLabels', 'outputLabels']) delete node[field];
            node.allowedGroups = commaGroups(node.allowedGroups);
            if (node.toolTimeoutMs === undefined) node.toolTimeoutMs = 30000;
            if (node.maxConcurrentCalls === undefined) node.maxConcurrentCalls = 32;
        }

        if (node.type === 'mcp-tool-registry')
        {
            const endpoint = typeof node.endpoint === 'string' ? node.endpoint : '';
            delete node.endpoint;
            // 3.x offered a tool without an endpoint on every endpoint, like __shared__.
            if (endpoint === '__shared__' || !endpoint.trim())
            {
                node.scope = 'shared';
                node.endpoint = '';
                if (runtimes.length === 1) node.runtime = runtimes[0].id;
                else
                {
                    node.runtime = '';
                    review(node.id, 'Select the runtime of this Shared tool: the flow has ' + runtimes.length + ' runtimes');
                }
            } else
            {
                const matches = endpoints.filter(candidate =>
                    normalizePath(candidate.serverPath || '/mcp') === normalizePath(endpoint));
                node.scope = 'endpoint';
                node.runtime = '';
                node.endpoint = matches.length === 1 ? matches[0].id : '';
                if (!matches.length) review(node.id, 'Select the endpoint of this tool: no endpoint serves ' + (endpoint || 'an empty path'));
                else if (matches.length > 1)
                    review(node.id, 'Select the endpoint of this tool: ' + matches.map(match => match.id).join(', ') + ' serve ' + endpoint);
            }
            const route = routers.filter(router => (router.rules || []).some(rule => rule && rule.v === node.toolName));
            review(node.id, 'Wire this tool to its flow' +
                (route.length ? ', the branch of switch ' + route.map(router => router.id).join(', ') : ''));
            node.cancelOutput = node.cancelOutput === true;
            node.outputs = node.cancelOutput ? 2 : 1;
            if (!targets(node).length) node.wires = node.cancelOutput ? [[], []] : [[]];
        }

        if (TYPE_MAP[node.type])
        {
            node.type = TYPE_MAP[node.type];
            converted++;
            continue;
        }

        if (Array.isArray(node.wires) && node.wires.some(port => Array.isArray(port) && port.some(id => endpointIds.has(id))))
        {
            node.wires = node.wires.map(port => Array.isArray(port) ? port.filter(id => !endpointIds.has(id)) : port);
            review(node.id, 'Replace the wire to the endpoint with an nr-mcp-tool-response node');
        }
        if (['catch', 'status', 'complete'].includes(node.type) && Array.isArray(node.scope) &&
            node.scope.some(id => endpointIds.has(id)))
            review(node.id, 'Its scope includes an endpoint, which is a configuration node in 4.0 and reports nothing; ' +
                'scope the tool flow nodes instead');
        if (node.type === 'group' && Array.isArray(node.nodes))
            node.nodes = node.nodes.filter(id => !endpointIds.has(id));
        if (routers.includes(node))
            review(node.id, 'Remove this switch: tool calls no longer need routing by payload.toolName');
        else if (OLD_PROTOCOL.test(JSON.stringify({ ...node, name: undefined, info: undefined })))
            review(node.id, MESSAGE_FORMAT);
    }

    return {
        flow: wrapped ? { ...input, flows: nodes } : nodes,
        converted,
        unchanged: nodes.length - converted,
        manualReview
    };
}

module.exports = { migrateFlow, TYPE_MAP };
