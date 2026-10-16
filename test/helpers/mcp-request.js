'use strict';

const PROTOCOL_VERSION = '2026-07-28';
const RAW = 'x-test-raw';

function isRpcRequest(body)
{
    return body && typeof body === 'object' && !Array.isArray(body) && typeof body.method === 'string';
}

function modernBody(body)
{
    const params = body.params && typeof body.params === 'object' ? body.params : {};
    const meta = { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION, ...(params._meta || {}) };
    return { ...body, params: { ...params, _meta: meta } };
}

function modernHeaders(body, headers = {})
{
    const result = { 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': body.method, ...headers };
    if (body.method === 'tools/call' && body.params && typeof body.params.name === 'string' && !('mcp-name' in result))
        result['mcp-name'] = body.params.name;
    return result;
}

function lowerCase(headers = {})
{
    return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function prepare(body, headers = {})
{
    const lower = lowerCase(headers);
    if (lower[RAW] || !isRpcRequest(body)) return { body, headers: lower };
    return { body: modernBody(body), headers: modernHeaders(body, lower) };
}

function mcpFetch(url, init = {})
{
    if (!init || String(init.method || 'GET').toUpperCase() !== 'POST' || typeof init.body !== 'string' ||
        String(url).includes('/oauth/')) return fetch(url, init);
    let body;
    try
    {
        body = JSON.parse(init.body);
    } catch
    {
        return fetch(url, init);
    }
    const prepared = prepare(body, init.headers);
    return fetch(url, { ...init, headers: prepared.headers, body: JSON.stringify(prepared.body) });
}

module.exports = { PROTOCOL_VERSION, RAW, prepare, mcpFetch };
