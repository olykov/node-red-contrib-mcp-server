# Local Patch Set

Base: upstream `node-red-contrib-mcp-server@1.1.5`.

## Carried Local Changes

- package metadata is sanitized for this fork;
- `npm test` uses Node's built-in test runner instead of upstream's missing `test.js`;
- `mcp-runtime` config nodes hold local listener settings: port and optional admin API settings; endpoints start automatically on flow startup and do not emit CORS headers;
- `mcp-flow-server` defines a logical MCP endpoint on a selected runtime and keeps the upstream request/response flow contract;
- multiple `mcp-flow-server` nodes can share one HTTP port while serving separate endpoint paths;
- one local port can be owned by only one `mcp-runtime` instance;
- `mcp-tool-registry` requires an explicit endpoint selection, with `Shared (All MCPs)` for intentionally shared tools;
- provider scopes are fixed in code and advertised automatically on tools and OAuth metadata;
- optional read-only `get_flow` is available only when runtime admin settings are complete and the endpoint path matches the configured admin endpoint path;
- `mcp-server-metrics` emits bounded telemetry for every tool call on its runtime; the flow-server second output remains admin-only;
- removed the unused `mcp-tool` client node and nonstandard direct JSON-RPC tool methods; tool execution uses `tools/call`;
- removed the unused external-process server and remote-client nodes and their client-only dependencies;
- `mcp-redis` defines memory or Redis-backed storage for OAuth state, authorization codes, and opaque access tokens;
- `mcp-auth` defines generic OIDC settings, auth storage, and token TTLs;
- all `mcp-flow-server` endpoints require OAuth and enforce endpoint roles/groups; public/inherited modes and custom scope policies are removed;
- package-level OAuth routes support authorization-code flow with PKCE S256, OIDC ID token validation, userinfo claims, client metadata host allow-listing, and opaque MCP access tokens;
- rotating refresh tokens use provider-specific encrypted credentials, atomic consumption and finite idle/absolute session lifetimes;
- local tests cover the read-only admin boundary and flow-server execution contracts.

## Deliberately Not Carried

- removed local compatibility nodes;
- dynamic client registration shim;
- hosted-client interoperability verification.
