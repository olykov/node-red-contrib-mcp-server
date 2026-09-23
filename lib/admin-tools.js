'use strict';

const http = require('http');

const PAGE_SIZE = 40;
const EDGE_LIMIT = 80;
const CODE_LIMIT = 2000;
const TEXT_LIMIT = 120;
const ID_LIMIT = 128;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_GRAPH_NODES = 20000;
const MAX_GRAPH_EDGES = 100000;

function defaultHttpRequest(method, hostname, port, path, headers) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            method, hostname, port, path,
            headers: Object.assign({ 'Node-RED-API-Version': 'v2' }, headers),
            timeout: 15000
        }, response => {
            if (Number(response.headers['content-length']) > MAX_RESPONSE_BYTES) {
                request.destroy(new Error('Node-RED Admin API response exceeds size limit'));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_RESPONSE_BYTES) {
                    request.destroy(new Error('Node-RED Admin API response exceeds size limit'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: response.statusCode, body: JSON.parse(raw) }); }
                catch { resolve({ status: response.statusCode, body: raw }); }
            });
        });
        request.on('timeout', () => request.destroy(new Error('Node-RED Admin API timed out')));
        request.on('error', reject);
        request.end();
    });
}

const MODES = ['tab_summary', 'group', 'chain', 'node', 'subflows', 'subflow'];
const TOOLS = [{
    name: 'get_flow',
    description: 'Read-only Node-RED navigation. Provide a tab id to summarize one tab. Use group, chain, node, subflows or subflow for focused inspection. Results are paginated; Function code requires includeCode in node mode.',
    inputSchema: {
        type: 'object',
        properties: {
            mode: { type: 'string', enum: MODES },
            id: { type: 'string', description: 'Tab ID for tab modes; optional tab ID for subflow usages' },
            groupId: { type: 'string', description: 'Group ID in group mode' },
            nodeId: { type: 'string', description: 'Node ID in node or chain mode' },
            subflowId: { type: 'string', description: 'Definition ID in subflow mode' },
            offset: { type: 'integer', minimum: 0, description: 'Zero-based offset; fixed page size of 40' },
            includeCode: { type: 'boolean', description: 'Return at most 2000 Function code characters in node mode' }
        },
        additionalProperties: false
    },
    outputSchema: {
        type: 'object',
        properties: {
            mode: { type: 'string', enum: MODES },
            source: { type: 'string' },
            meta: {
                type: 'object',
                properties: {
                    scannedNodes: { type: 'integer' },
                    returnedNodes: { type: 'integer' },
                    truncated: { type: 'boolean' },
                    codeOmitted: { type: 'boolean' },
                    offset: { type: 'integer' },
                    nextOffset: { type: ['integer', 'null'] },
                    limits: { type: 'object' }
                },
                required: ['scannedNodes', 'returnedNodes', 'truncated', 'codeOmitted', 'offset', 'nextOffset', 'limits'],
                additionalProperties: false
            },
            tab: { type: 'object' },
            groups: { type: 'array', items: { type: 'object' } },
            chains: { type: 'array', items: { type: 'object' } },
            keyNodes: { type: 'array', items: { type: 'object' } },
            keyNodeCount: { type: 'integer' },
            group: { type: 'object' },
            chain: { type: 'object' },
            nodes: { type: 'array', items: { type: 'object' } },
            edges: { type: 'array', items: { type: 'object' } },
            node: { type: 'object' },
            incoming: { type: 'array', items: { type: 'object' } },
            outgoing: { type: 'array', items: { type: 'object' } },
            incomingCount: { type: 'integer' },
            outgoingCount: { type: 'integer' },
            subflows: { type: 'array', items: { type: 'object' } },
            totalSubflows: { type: 'integer' },
            subflow: { type: 'object' },
            usages: { type: 'array', items: { type: 'object' } },
            totalUsages: { type: 'integer' },
            usageTabId: { type: 'string' },
            totalNodes: { type: 'integer' },
            typeCounts: { type: 'object' },
            error: { type: 'object' }
        },
        required: ['mode', 'source', 'meta'],
        additionalProperties: false
    }
}];

const TOOL_NAMES = new Set(TOOLS.map(tool => tool.name));

function invalid(message) {
    const error = new Error(message);
    error.rpcCode = -32602;
    throw error;
}

function safeId(value, field) {
    if (typeof value !== 'string' || value.length > ID_LIMIT || !/^[A-Za-z0-9._-]+$/.test(value)) {
        invalid('Invalid ' + field);
    }
    return value;
}

function short(value) {
    return typeof value === 'string' ? value.slice(0, TEXT_LIMIT) : '';
}

function compactNode(node) {
    const config = {};
    for (const field of ['inputs', 'outputs']) {
        if (Number.isSafeInteger(node[field]) && node[field] >= 0) config[field] = node[field];
    }
    if (['http in', 'http request'].includes(node.type) && typeof node.method === 'string') {
        config.method = short(node.method);
    }
    if (node.type === 'http in' && typeof node.url === 'string' && /^\/[A-Za-z0-9/_:.{}-]*$/.test(node.url)) {
        config.route = short(node.url);
    }
    if (['switch', 'change'].includes(node.type) && Array.isArray(node.rules)) {
        config.ruleCount = node.rules.length;
    }
    return {
        id: String(node.id).slice(0, ID_LIMIT),
        type: short(node.type),
        name: short(node.name || node.label || node.toolName),
        ...(node.type === 'mcp-tool-registry' && typeof node.toolName === 'string' ? { toolName: short(node.toolName) } : {}),
        ...(node.type === 'mcp-tool-registry' && typeof node.endpoint === 'string' ? { endpointId: node.endpoint.slice(0, ID_LIMIT) } : {}),
        ...(typeof node.g === 'string' ? { groupId: node.g.slice(0, ID_LIMIT) } : {}),
        ...(node.d === true ? { disabled: true } : {}),
        ...(Object.keys(config).length ? { config } : {})
    };
}

function page(items, offset) {
    const slice = items.slice(offset, offset + PAGE_SIZE);
    return { items: slice, nextOffset: offset + slice.length < items.length ? offset + slice.length : null };
}

function result(mode, source, data, scannedNodes, returnedNodes, offset, nextOffset, options = {}) {
    const structuredContent = {
        mode, source,
        meta: {
            scannedNodes,
            returnedNodes,
            truncated: nextOffset !== null || Boolean(options.truncated),
            codeOmitted: options.codeOmitted !== false,
            offset,
            nextOffset,
            limits: {
                pageSize: PAGE_SIZE,
                edgeLimit: EDGE_LIMIT,
                codeCharacters: CODE_LIMIT,
                graphNodes: MAX_GRAPH_NODES,
                graphWireVisits: MAX_GRAPH_EDGES,
                responseBytes: MAX_RESPONSE_BYTES
            }
        },
        ...data
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent,
        ...(options.error ? { isError: true } : {})
    };
}

function errorResult(mode, source, code, message, scannedNodes = 0) {
    return result(mode, source, { error: { code, message } }, scannedNodes, 0, 0, null, { error: true });
}

function nodesOf(flow) {
    if (!flow || !Array.isArray(flow.nodes)) throw new Error('Invalid Node-RED flow response');
    if (flow.nodes.length > MAX_GRAPH_NODES) throw new Error('Node-RED tab exceeds inspection node limit');
    return flow.nodes.filter(node => node && typeof node.id === 'string' && typeof node.type === 'string');
}

function graph(nodes) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const adjacency = new Map(nodes.map(node => [node.id, new Set()]));
    const edges = [];
    let visited = 0;
    for (const node of nodes) {
        if (!Array.isArray(node.wires)) continue;
        for (let port = 0; port < node.wires.length; port++) {
            if (++visited > MAX_GRAPH_EDGES) throw new Error('Node-RED tab exceeds inspection wire limit');
            const targets = node.wires[port];
            if (!Array.isArray(targets)) continue;
            for (const target of targets) {
                if (++visited > MAX_GRAPH_EDGES) throw new Error('Node-RED tab exceeds inspection wire limit');
                if (!byId.has(target)) continue;
                if (edges.length >= MAX_GRAPH_EDGES) throw new Error('Node-RED tab exceeds inspection edge limit');
                edges.push({ from: node.id.slice(0, ID_LIMIT), to: target.slice(0, ID_LIMIT), port });
                adjacency.get(node.id).add(target);
                adjacency.get(target).add(node.id);
            }
        }
    }
    return { byId, adjacency, edges };
}

function components(nodes, adjacency) {
    const visited = new Set();
    const chains = [];
    for (const node of nodes) {
        if (node.type === 'group' || visited.has(node.id)) continue;
        const members = [];
        const queue = [node.id];
        visited.add(node.id);
        for (let i = 0; i < queue.length; i++) {
            const current = queue[i];
            members.push(current);
            for (const neighbor of adjacency.get(current) || []) {
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    queue.push(neighbor);
                }
            }
        }
        chains.push(members);
    }
    return chains;
}

function edgesFor(nodes, allEdges) {
    const ids = new Set(nodes.map(node => node.id));
    const matching = allEdges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
    return { edges: matching.slice(0, EDGE_LIMIT), truncated: matching.length > EDGE_LIMIT };
}

function createAdminTools({ adminPort, getAdminToken, httpRequest = defaultHttpRequest }) {
    function adminApi(path) {
        const token = process.env.NODE_RED_ADMIN_API_TOKEN || (getAdminToken && getAdminToken()) || '';
        const headers = token ? { Authorization: 'Bearer ' + token } : {};
        return httpRequest('GET', '127.0.0.1', adminPort, path, headers);
    }

    async function read(path) {
        const response = await adminApi(path);
        if (response.status === 404) return null;
        if (response.status < 200 || response.status >= 300) {
            throw new Error('Node-RED Admin API failed (' + response.status + ')');
        }
        return response.body;
    }

    async function callTool(toolName, args = {}) {
        if (toolName !== 'get_flow') return undefined;
        if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('Arguments must be an object');
        const allowed = new Set(['mode', 'id', 'groupId', 'nodeId', 'subflowId', 'offset', 'includeCode']);
        if (Object.keys(args).some(key => !allowed.has(key))) invalid('Unknown get_flow argument');
        const mode = args.mode === undefined ? 'tab_summary' : args.mode;
        if (!MODES.includes(mode)) invalid('Invalid get_flow mode');
        const modeFields = {
            tab_summary: ['id'], group: ['id', 'groupId'],
            chain: ['id', 'nodeId'], node: ['id', 'nodeId'],
            subflows: [], subflow: ['id', 'subflowId']
        };
        if (Object.keys(args).some(key =>
            ['id', 'groupId', 'nodeId', 'subflowId'].includes(key) && !modeFields[mode].includes(key))) {
            invalid('Argument is not available in ' + mode + ' mode');
        }
        const offset = args.offset === undefined ? 0 : args.offset;
        if (!Number.isSafeInteger(offset) || offset < 0) invalid('Invalid offset');
        if (args.includeCode !== undefined && typeof args.includeCode !== 'boolean') invalid('Invalid includeCode');
        if (args.includeCode && mode !== 'node') invalid('includeCode is available in node mode only');
        for (const field of ['id', 'groupId', 'nodeId', 'subflowId']) {
            if (args[field] !== undefined) safeId(args[field], field);
        }

        if (mode === 'subflows' || mode === 'subflow') {
            if (mode === 'subflow' && !args.subflowId) invalid('subflowId is required');
            const globalFlow = await read('/flow/global');
            if (!globalFlow || !Array.isArray(globalFlow.subflows)) throw new Error('Invalid Node-RED global flow response');
            const definitions = globalFlow.subflows;
            const globalNodeCount = (Array.isArray(globalFlow.nodes) ? globalFlow.nodes.length : 0) +
                definitions.reduce((sum, def) => sum + (Array.isArray(def.nodes) ? def.nodes.length : 0), 0);
            if (mode === 'subflows') {
                const p = page(definitions, offset);
                return result(mode, '/flow/global', {
                    subflows: p.items.map(def => ({
                        id: String(def.id).slice(0, ID_LIMIT),
                        name: short(def.name),
                        nodeCount: Array.isArray(def.nodes) ? def.nodes.length : 0
                    })),
                    totalSubflows: definitions.length
                }, globalNodeCount, 0, offset, p.nextOffset);
            }
            const def = definitions.find(item => item.id === args.subflowId);
            if (!def) return errorResult(mode, '/flow/global', 'SUBFLOW_NOT_FOUND', 'Subflow not found', globalNodeCount);
            const members = nodesOf(def);
            const p = page(members, offset);
            let usages = [];
            let scanned = globalNodeCount;
            let source = '/flow/global';
            if (args.id) {
                const flow = await read('/flow/' + args.id);
                if (!flow) return errorResult(mode, '/flow/' + args.id, 'FLOW_NOT_FOUND', 'Tab not found');
                const tabNodes = nodesOf(flow);
                scanned += tabNodes.length;
                source += ',/flow/' + args.id;
                usages = tabNodes.filter(node => node.type === 'subflow:' + def.id);
            }
            const usagePage = page(usages, offset);
            const nextOffset = p.nextOffset === null && usagePage.nextOffset === null ? null : offset + PAGE_SIZE;
            return result(mode, source, {
                subflow: {
                    id: String(def.id).slice(0, ID_LIMIT),
                    name: short(def.name),
                    nodeCount: members.length,
                    inputs: Array.isArray(def.in) ? def.in.length : 0,
                    outputs: Array.isArray(def.out) ? def.out.length : 0
                },
                nodes: p.items.map(compactNode),
                totalNodes: members.length,
                ...(args.id ? { usages: usagePage.items.map(compactNode), totalUsages: usages.length, usageTabId: args.id } : {})
            }, scanned, p.items.length + usagePage.items.length, offset, nextOffset);
        }

        if (!args.id) invalid('Tab id is required');
        if (mode === 'group' && !args.groupId) invalid('groupId is required');
        if ((mode === 'node' || mode === 'chain') && !args.nodeId) invalid('nodeId is required');
        const source = '/flow/' + args.id;
        const flow = await read(source);
        if (!flow) return errorResult(mode, source, 'FLOW_NOT_FOUND', 'Tab not found');
        const nodes = nodesOf(flow);
        const scanned = nodes.length;

        if (mode === 'group') {
            const group = nodes.find(node => node.id === args.groupId && node.type === 'group');
            if (!group) return errorResult(mode, source, 'GROUP_NOT_FOUND', 'Group not found', scanned);
            const memberIds = new Set(Array.isArray(group.nodes) ? group.nodes : []);
            const members = nodes.filter(node => node.g === group.id || memberIds.has(node.id));
            const p = page(members, offset);
            const connections = edgesFor(p.items, graph(nodes).edges);
            return result(mode, source, {
                group: { id: group.id, name: short(group.name), nodeCount: members.length },
                nodes: p.items.map(compactNode), edges: connections.edges, totalNodes: members.length
            }, scanned, p.items.length, offset, p.nextOffset, { truncated: connections.truncated });
        }

        if (mode === 'node') {
            if (offset !== 0) invalid('offset is not available in node mode');
            const target = nodes.find(node => node.id === args.nodeId);
            if (!target) return errorResult(mode, source, 'NODE_NOT_FOUND', 'Node not found', scanned);
            const connections = graph(nodes).edges;
            const incoming = connections.filter(edge => edge.to === target.id);
            const outgoing = connections.filter(edge => edge.from === target.id);
            const node = compactNode(target);
            if (target.type === 'function' && args.includeCode) {
                node.code = typeof target.func === 'string' ? target.func.slice(0, CODE_LIMIT) : '';
                node.codeTruncated = typeof target.func === 'string' && target.func.length > CODE_LIMIT;
            }
            if (['link in', 'link out', 'link call'].includes(target.type)) {
                node.linkIds = Array.isArray(target.links) ?
                    target.links.slice(0, PAGE_SIZE).filter(value => typeof value === 'string').map(value => value.slice(0, ID_LIMIT)) : [];
                node.linkIdsTruncated = Array.isArray(target.links) && target.links.length > PAGE_SIZE;
            }
            return result(mode, source, {
                node,
                incoming: incoming.slice(0, PAGE_SIZE),
                outgoing: outgoing.slice(0, PAGE_SIZE),
                incomingCount: incoming.length,
                outgoingCount: outgoing.length
            }, scanned, 1, 0, null, {
                codeOmitted: !(target.type === 'function' && args.includeCode),
                truncated: incoming.length > PAGE_SIZE || outgoing.length > PAGE_SIZE || Boolean(node.codeTruncated) || Boolean(node.linkIdsTruncated)
            });
        }

        const topology = graph(nodes);
        const chains = components(nodes, topology.adjacency);
        if (mode === 'chain') {
            const memberIds = chains.find(chain => chain.includes(args.nodeId));
            if (!memberIds) return errorResult(mode, source, 'NODE_NOT_FOUND', 'Node not found', scanned);
            const members = memberIds.map(memberId => topology.byId.get(memberId));
            const p = page(members, offset);
            const connections = edgesFor(p.items, topology.edges);
            return result(mode, source, {
                chain: { anchorId: memberIds[0].slice(0, ID_LIMIT), nodeCount: members.length },
                nodes: p.items.map(compactNode), edges: connections.edges, totalNodes: members.length
            }, scanned, p.items.length, offset, p.nextOffset, { truncated: connections.truncated });
        }

        const groups = nodes.filter(node => node.type === 'group');
        const keyTypes = new Set(['function', 'debug', 'link in', 'link out', 'link call', 'mcp-tool-registry']);
        const keyNodes = nodes.filter(node => keyTypes.has(node.type));
        const groupPage = page(groups, offset);
        const chainPage = page(chains, offset);
        const keyPage = page(keyNodes, offset);
        const groupCounts = new Map();
        for (const node of nodes) if (node.g) groupCounts.set(node.g, (groupCounts.get(node.g) || 0) + 1);
        const typeCounts = {};
        for (const type of keyTypes) typeCounts[type] = 0;
        for (const node of nodes) if (keyTypes.has(node.type)) typeCounts[node.type]++;
        const nextOffset = [groupPage, chainPage, keyPage].some(item => item.nextOffset !== null) ? offset + PAGE_SIZE : null;
        return result(mode, source, {
            tab: {
                id: String(flow.id).slice(0, ID_LIMIT),
                label: short(flow.label),
                disabled: Boolean(flow.disabled),
                nodeCount: nodes.length,
                groupCount: groups.length,
                chainCount: chains.length
            },
            groups: groupPage.items.map(group => ({
                id: group.id.slice(0, ID_LIMIT),
                name: short(group.name),
                nodeCount: groupCounts.get(group.id) || 0
            })),
            chains: chainPage.items.map(members => ({
                anchorId: members[0].slice(0, ID_LIMIT),
                nodeCount: members.length,
                firstNode: compactNode(topology.byId.get(members[0]))
            })),
            keyNodes: keyPage.items.map(compactNode),
            keyNodeCount: keyNodes.length,
            typeCounts
        }, scanned, chainPage.items.length + keyPage.items.length, offset, nextOffset);
    }

    return { TOOLS, TOOL_NAMES, callTool };
}

module.exports = { createAdminTools, TOOLS, TOOL_NAMES };
