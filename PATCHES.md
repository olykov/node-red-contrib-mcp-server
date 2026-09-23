# Local Patch Set

Base: upstream `node-red-contrib-mcp-server@1.1.5`.

## Carried Local Changes

- package metadata is sanitized for this fork;
- `npm test` uses Node's built-in test runner instead of upstream's missing `test.js`;
- `mcp-runtime` config nodes hold local listener settings: port, auto-start, CORS, and optional admin API settings;
- `mcp-flow-server` defines a logical MCP endpoint on a selected runtime and keeps the upstream request/response flow contract;
- multiple `mcp-flow-server` nodes can share one HTTP port while serving separate endpoint paths;
- one local port can be owned by only one `mcp-runtime` instance;
- `mcp-tool-registry` requires an explicit endpoint selection, with `Shared (All MCPs)` for intentionally shared tools;
- `mcp-tool-registry` can add per-tool required scopes to descriptor metadata;
- optional read-only `get_flow` is available only when runtime admin settings are complete and the endpoint path matches the configured admin endpoint path;
- `mcp-redis` defines memory or Redis-backed storage for OAuth state, authorization codes, and opaque access tokens;
- `mcp-auth` defines generic OIDC settings, auth storage, and token TTLs;
- protected `mcp-flow-server` endpoints return OAuth protected-resource metadata challenges and enforce endpoint/tool group and scope policy;
- package-level OAuth routes support authorization-code flow with PKCE S256, OIDC ID token validation, userinfo claims, client metadata host allow-listing, and opaque MCP access tokens;
- local tests cover the read-only admin boundary and flow-server execution contracts.

## Deliberately Not Carried

- removed local compatibility nodes;
- dynamic client registration shim;
- refresh token support;
- hosted-client interoperability verification.
