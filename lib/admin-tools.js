'use strict';

const http = require('http');
const { performance } = require('node:perf_hooks');

const PAGE_SIZE = 40;
const EDGE_LIMIT = 80;
const CODE_LIMIT = 2000;
const TEXT_LIMIT = 120;
const ID_LIMIT = 128;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_GRAPH_NODES = 20000;
const MAX_GRAPH_EDGES = 100000;
const MAX_TAB_INDEX_DURATION_MS = 250;
const MAX_TAB_INDEX_SCOPES = 10000;
const TAB_INDEX_RETRY_MS = 5000;
const MAX_CONFIG_VALUE_BYTES = 32 * 1024;
const MAX_CONFIG_PAGE_BYTES = 64 * 1024;

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

const MODES = ['tabs', 'tab_summary', 'group', 'chain', 'node', 'subflows', 'subflow', 'configs', 'config', 'node_configs'];
const TOOLS = [{
    name: 'get_flow',
    description: 'Read-only Node-RED navigation. No arguments lists tabs; a tab id summarizes one tab. Use configs to list configuration nodes in a tab, subflow or global scope; config inspects one; node_configs resolves a node\'s configuration references. Other modes inspect groups, chains, nodes and subflows. Results are paginated; Function code requires includeCode in node mode.',
    inputSchema: {
        type: 'object',
        properties: {
            mode: { type: 'string', enum: MODES },
            id: { type: 'string', description: 'Tab ID for tab modes; optional tab ID for subflow usages' },
            groupId: { type: 'string', description: 'Group ID in group mode' },
            nodeId: { type: 'string', description: 'Node ID in node or chain mode' },
            subflowId: { type: 'string', description: 'Definition ID in subflow mode' },
            configId: { type: 'string', description: 'Configuration node ID in config mode' },
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
                    limits: { type: 'object' },
                    cached: { type: 'boolean' }
                },
                required: ['scannedNodes', 'returnedNodes', 'truncated', 'codeOmitted', 'offset', 'nextOffset', 'limits'],
                additionalProperties: false
            },
            tabs: { type: 'array', items: { type: 'object' } },
            totalTabs: { type: 'integer' },
            tab: { type: 'object' },
            groups: { type: 'array', items: { type: 'object' } },
            chains: { type: 'array', items: { type: 'object' } },
            keyNodes: { type: 'array', items: { type: 'object' } },
            keyNodeCount: { type: 'integer' },
            group: { type: 'object' },
            chain: { type: 'object' },
            nodes: { type: 'array', items: { type: 'object' } },
            edges: { type: 'array', items: { type: 'object' } },
            totalEdges: { type: 'integer' },
            inputConnections: { type: 'array', items: { type: 'object' } },
            totalInputConnections: { type: 'integer' },
            outputConnections: { type: 'array', items: { type: 'object' } },
            totalOutputConnections: { type: 'integer' },
            node: { type: 'object' },
            incoming: { type: 'array', items: { type: 'object' } },
            outgoing: { type: 'array', items: { type: 'object' } },
            incomingCount: { type: 'integer' },
            outgoingCount: { type: 'integer' },
            subflows: { type: 'array', items: { type: 'object' } },
            totalSubflows: { type: 'integer' },
            subflow: { type: 'object' },
            configs: { type: 'array', items: { type: 'object' } },
            totalConfigs: { type: 'integer' },
            config: { type: 'object' },
            totalProperties: { type: 'integer' },
            configRefs: { type: 'array', items: { type: 'object' } },
            totalConfigRefs: { type: 'integer' },
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
                tabIndexMilliseconds: MAX_TAB_INDEX_DURATION_MS,
                tabIndexScopes: MAX_TAB_INDEX_SCOPES,
                tabIndexRetryMilliseconds: TAB_INDEX_RETRY_MS,
                responseBytes: MAX_RESPONSE_BYTES,
                configValueBytes: MAX_CONFIG_VALUE_BYTES,
                configPageBytes: MAX_CONFIG_PAGE_BYTES
            },
            ...(options.cached === undefined ? {} : { cached: options.cached })
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

function configsOf(flow) {
    if (!flow || (flow.configs !== undefined && !Array.isArray(flow.configs))) {
        throw new Error('Invalid Node-RED config response');
    }
    if (!flow.configs) return [];
    return flow.configs.filter(node => node && typeof node.id === 'string' && typeof node.type === 'string');
}

function configSummary(node) {
    return { id: node.id.slice(0, ID_LIMIT), type: short(node.type), name: short(node.name) };
}

function configDetail(node, offset) {
    const names = Object.keys(node).filter(key => !['id', 'type', 'credentials'].includes(key));
    const properties = Object.create(null);
    const omittedProperties = [];
    let usedBytes = 0;
    let returnedProperties = 0;
    for (const name of names.slice(offset, offset + PAGE_SIZE)) {
        const value = node[name];
        const encoded = JSON.stringify(value);
        const bytes = encoded === undefined ? 0 : Buffer.byteLength(encoded);
        if (encoded === undefined || bytes > MAX_CONFIG_VALUE_BYTES) {
            omittedProperties.push(name);
        } else {
            if (returnedProperties > 0 && usedBytes + bytes > MAX_CONFIG_PAGE_BYTES) break;
            properties[name] = value;
            usedBytes += bytes;
        }
        returnedProperties++;
    }
    return {
        config: { ...configSummary(node), properties, omittedProperties,
            ...(Object.prototype.hasOwnProperty.call(node, 'credentials') ? { credentials: '[REDACTED]' } : {}) },
        totalProperties: names.length,
        returnedProperties,
        nextOffset: offset + returnedProperties < names.length ? offset + returnedProperties : null
    };
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

function subflowConnections(def, members, offset) {
    const ids = new Set(members.map(node => node.id));
    const connections = {
        edges: [], totalEdges: 0,
        inputConnections: [], totalInputConnections: 0,
        outputConnections: [], totalOutputConnections: 0
    };
    let visited = 0;
    function visit() {
        if (++visited > MAX_GRAPH_EDGES) throw new Error('Node-RED subflow exceeds inspection wire limit');
    }
    function add(field, total, connection) {
        if (connections[total] >= offset && connections[total] < offset + PAGE_SIZE) {
            connections[field].push(connection);
        }
        connections[total]++;
    }

    for (const node of members) {
        if (!Array.isArray(node.wires)) continue;
        for (let port = 0; port < node.wires.length; port++) {
            visit();
            if (!Array.isArray(node.wires[port])) continue;
            for (const target of node.wires[port]) {
                visit();
                if (ids.has(target)) {
                    add('edges', 'totalEdges', { from: node.id.slice(0, ID_LIMIT), to: target.slice(0, ID_LIMIT), port });
                }
            }
        }
    }
    for (const [input, descriptor] of (Array.isArray(def.in) ? def.in : []).entries()) {
        if (!descriptor || !Array.isArray(descriptor.wires)) continue;
        for (const wire of descriptor.wires) {
            visit();
            if (wire && ids.has(wire.id)) {
                add('inputConnections', 'totalInputConnections', { input, to: wire.id.slice(0, ID_LIMIT) });
            }
        }
    }
    for (const [output, descriptor] of (Array.isArray(def.out) ? def.out : []).entries()) {
        if (!descriptor || !Array.isArray(descriptor.wires)) continue;
        for (const wire of descriptor.wires) {
            visit();
            if (wire && ids.has(wire.id) && Number.isSafeInteger(wire.port) && wire.port >= 0) {
                add('outputConnections', 'totalOutputConnections',
                    { from: wire.id.slice(0, ID_LIMIT), port: wire.port, output });
            }
        }
    }
    return connections;
}

function createAdminTools({ adminPort, getAdminToken, eachNode, events, httpRequest = defaultHttpRequest,
    now = () => performance.now() }) {
    let tabsCache = null;
    let tabsRetryAt = 0;
    let subscribed = false;
    const canSubscribe = events && typeof events.on === 'function' && typeof events.removeListener === 'function';

    function onRuntimeEvent(event) {
        if (event && event.id === 'runtime-deploy') {
            tabsCache = null;
            tabsRetryAt = 0;
        }
    }

    function dispose() {
        if (subscribed) events.removeListener('runtime-event', onRuntimeEvent);
        subscribed = false;
        tabsCache = null;
        tabsRetryAt = 0;
    }

    function tabs() {
        if (tabsCache) return { ...tabsCache, cached: true };
        if (typeof eachNode !== 'function') throw new Error('Node-RED runtime tab listing is unavailable');
        if (canSubscribe && !subscribed) {
            events.on('runtime-event', onRuntimeEvent);
            subscribed = true;
        }
        const startedAt = now();
        if (startedAt < tabsRetryAt) throw new Error('Node-RED runtime tab index is temporarily unavailable');
        const entries = [];
        const counts = new Map();
        let scannedNodes = 0;
        try {
            eachNode(node => {
                if (++scannedNodes % 1024 === 0 && now() - startedAt > MAX_TAB_INDEX_DURATION_MS) {
                    throw new Error('Node-RED runtime exceeds tab index time limit');
                }
                if (!node || typeof node !== 'object') return;
                if (node.type === 'tab' && typeof node.id === 'string') {
                    if (entries.length >= MAX_TAB_INDEX_SCOPES) throw new Error('Node-RED runtime exceeds tab index scope limit');
                    entries.push({ id: node.id.slice(0, ID_LIMIT), label: short(node.label), disabled: node.disabled === true, nodeCount: 0 });
                } else if (typeof node.z === 'string') {
                    if (!counts.has(node.z) && counts.size >= MAX_TAB_INDEX_SCOPES) {
                        throw new Error('Node-RED runtime exceeds tab index scope limit');
                    }
                    counts.set(node.z, (counts.get(node.z) || 0) + 1);
                }
            });
            if (now() - startedAt > MAX_TAB_INDEX_DURATION_MS) {
                throw new Error('Node-RED runtime exceeds tab index time limit');
            }
        } catch (error) {
            tabsRetryAt = now() + TAB_INDEX_RETRY_MS;
            throw error;
        }
        for (const entry of entries) entry.nodeCount = counts.get(entry.id) || 0;
        const index = { entries, scannedNodes };
        if (canSubscribe) tabsCache = index;
        return { ...index, cached: false };
    }
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
        const allowed = new Set(['mode', 'id', 'groupId', 'nodeId', 'subflowId', 'configId', 'offset', 'includeCode']);
        if (Object.keys(args).some(key => !allowed.has(key))) invalid('Unknown get_flow argument');
        const mode = args.mode === undefined ? (args.id ? 'tab_summary' : 'tabs') : args.mode;
        if (!MODES.includes(mode)) invalid('Invalid get_flow mode');
        const modeFields = {
            tabs: [], tab_summary: ['id'], group: ['id', 'groupId'],
            chain: ['id', 'nodeId'], node: ['id', 'nodeId'],
            subflows: [], subflow: ['id', 'subflowId'],
            configs: ['id', 'subflowId'], config: ['id', 'subflowId', 'configId'],
            node_configs: ['id', 'subflowId', 'nodeId']
        };
        if (Object.keys(args).some(key =>
            ['id', 'groupId', 'nodeId', 'subflowId', 'configId'].includes(key) && !modeFields[mode].includes(key))) {
            invalid('Argument is not available in ' + mode + ' mode');
        }
        const offset = args.offset === undefined ? 0 : args.offset;
        if (!Number.isSafeInteger(offset) || offset < 0) invalid('Invalid offset');
        if (args.includeCode !== undefined && typeof args.includeCode !== 'boolean') invalid('Invalid includeCode');
        if (args.includeCode && mode !== 'node') invalid('includeCode is available in node mode only');
        for (const field of ['id', 'groupId', 'nodeId', 'subflowId', 'configId']) {
            if (args[field] !== undefined) safeId(args[field], field);
        }

        if (['configs', 'config', 'node_configs'].includes(mode)) {
            if (args.id && args.subflowId) invalid('Select a tab or subflow, not both');
            if (mode === 'config' && !args.configId) invalid('configId is required');
            if (mode === 'node_configs' && (!args.nodeId || (!args.id && !args.subflowId))) {
                invalid('nodeId and a tab or subflow ID are required');
            }
            let source = args.id ? '/flow/' + args.id : '/flow/global';
            const flow = await read(source);
            if (!flow) return errorResult(mode, source, 'FLOW_NOT_FOUND', 'Flow not found');
            let scope = flow;
            if (args.subflowId) {
                if (!Array.isArray(flow.subflows)) throw new Error('Invalid Node-RED global flow response');
                scope = flow.subflows.find(def => def.id === args.subflowId);
                if (!scope) return errorResult(mode, source, 'SUBFLOW_NOT_FOUND', 'Subflow not found');
            }
            const configs = configsOf(scope);
            if (mode === 'configs') {
                const p = page(configs, offset);
                return result(mode, source, { configs: p.items.map(configSummary), totalConfigs: configs.length },
                    configs.length, p.items.length, offset, p.nextOffset);
            }
            if (mode === 'config') {
                const config = configs.find(node => node.id === args.configId);
                if (!config) return errorResult(mode, source, 'CONFIG_NOT_FOUND', 'Config node not found', configs.length);
                const detail = configDetail(config, offset);
                return result(mode, source, { config: detail.config, totalProperties: detail.totalProperties },
                    configs.length, detail.returnedProperties, offset, detail.nextOffset,
                    { truncated: detail.config.omittedProperties.length > 0 });
            }
            const nodes = nodesOf(scope);
            const node = nodes.find(item => item.id === args.nodeId);
            if (!node) return errorResult(mode, source, 'NODE_NOT_FOUND', 'Node not found', nodes.length);
            let globalConfigs = args.subflowId ? configsOf(flow) : configs;
            if (args.id) {
                const globalFlow = await read('/flow/global');
                if (!globalFlow) throw new Error('Node-RED global flow is unavailable');
                globalConfigs = configsOf(globalFlow);
                source += ',/flow/global';
            }
            const byId = new Map(globalConfigs.map(item => [item.id, { node: item, scope: 'global' }]));
            for (const item of configs) byId.set(item.id, { node: item, scope: args.subflowId ? 'subflow' : 'tab' });
            const refs = [];
            for (const [property, value] of Object.entries(node)) {
                if (property === 'credentials' || typeof value !== 'string') continue;
                const match = byId.get(value);
                if (match) refs.push({ property, scope: match.scope, ...configSummary(match.node) });
            }
            const p = page(refs, offset);
            return result(mode, source, { node: compactNode(node), configRefs: p.items, totalConfigRefs: refs.length },
                nodes.length + configs.length + globalConfigs.length, p.items.length, offset, p.nextOffset);
        }

        if (mode === 'tabs') {
            const index = tabs();
            const p = page(index.entries, offset);
            return result(mode, 'runtime:nodes', { tabs: p.items, totalTabs: index.entries.length },
                index.scannedNodes, p.items.length, offset, p.nextOffset, { cached: index.cached });
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
            const connections = subflowConnections(def, members, offset);
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
            const nextOffset = [p.nextOffset, usagePage.nextOffset].some(value => value !== null) ||
                [connections.totalEdges, connections.totalInputConnections, connections.totalOutputConnections]
                    .some(total => total > offset + PAGE_SIZE) ? offset + PAGE_SIZE : null;
            return result(mode, source, {
                subflow: {
                    id: String(def.id).slice(0, ID_LIMIT),
                    name: short(def.name),
                    nodeCount: members.length,
                    inputs: Array.isArray(def.in) ? def.in.length : 0,
                    outputs: Array.isArray(def.out) ? def.out.length : 0,
                    configCount: Array.isArray(def.configs) ? def.configs.length : 0
                },
                nodes: p.items.map(compactNode),
                totalNodes: members.length,
                ...connections,
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
                chainCount: chains.length,
                configCount: Array.isArray(flow.configs) ? flow.configs.length : 0
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

    return { TOOLS, TOOL_NAMES, callTool, dispose };
}

module.exports = { createAdminTools, TOOLS, TOOL_NAMES };
