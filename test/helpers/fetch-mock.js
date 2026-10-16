'use strict';

const fetchMock = {
    get: async () => { throw new Error('Unexpected GET request'); },
    post: async () => { throw new Error('Unexpected POST request'); }
};

const realFetch = globalThis.fetch;

// Only intercept calls to the mocked upstream OAuth provider; requests to a test's own local
// HTTP server (127.0.0.1/localhost) must reach the real network, not the provider mock.
function isLocalTestServer(url)
{
    try
    {
        const hostname = new URL(String(url)).hostname;
        return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
    } catch { return false; }
}

globalThis.fetch = async (url, options = {}) =>
{
    if (isLocalTestServer(url)) return realFetch(url, options);
    const method = String(options.method || 'GET').toLowerCase();
    const result = method === 'post' ?
        await fetchMock.post(String(url), options.body, { headers: options.headers }) :
        await fetchMock.get(String(url), { headers: options.headers });
    return new Response(JSON.stringify(result.data), {
        status: result.status || 200,
        headers: result.headers || { 'content-type': 'application/json' }
    });
};

class MockHttpError extends Error
{
    constructor(message, code, response)
    {
        super(message);
        this.code = code;
        this.response = response;
    }
}

fetchMock.MockHttpError = MockHttpError;

module.exports = fetchMock;

