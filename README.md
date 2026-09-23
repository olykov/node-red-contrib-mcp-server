# Node-RED MCP Server Readonly

Upstream-first fork of `node-red-contrib-mcp-server@1.1.5` for MCP tool runtimes.

The package keeps the upstream node model and adds endpoint-scoped MCP flow serving, read-only admin helpers, and package-level OAuth support for MCP endpoints.

## Scope

Included nodes:

- `mcp-server`
- `mcp-client`
- `mcp-tool`
- `mcp-flow-server`
- `mcp-tool-registry`
- `mcp-runtime` config node
- `mcp-redis` config node
- `mcp-auth` config node

Local extensions:

- Runtime config nodes for local MCP listener settings.
- Endpoint nodes for logical MCP names, paths, and base scopes.
- Endpoint-scoped and shared tool registration.
- Per-tool required scopes in `_meta.securitySchemes`.
- Optional read-only `get_flow` tool gated by runtime admin settings and an exact endpoint path.
- OIDC-backed MCP authorization configuration.
- Memory or Redis-backed storage for short-lived auth state and opaque access tokens.
- Bearer token enforcement for protected MCP endpoints.
- Authorization-code flow bridge with PKCE S256, OIDC ID token validation, and userinfo claim extraction.
- Tests for the read-only admin boundary and flow-server execution path.

Not included yet:

- Verified interoperability with hosted MCP clients.
- Refresh token support.
- Removed local compatibility nodes from earlier fork revisions.

## Architecture

Node-RED runs MCP tools and exposes MCP endpoints from this package. Authorization routes are registered by the package on the same MCP runtime port; they are not modeled as Node-RED HTTP-in flows.

Expected boundary:

```text
MCP client -> Node-RED MCP package auth layer -> Node-RED MCP flow server -> Node-RED flows
```

## Installation

From a Git reference:

```bash
cd ~/.node-red
npm install git+ssh://git@example.com/org/node-red-contrib-mcp-server.git#<commit>
```

For local development:

```bash
cd /path/to/node-red-contrib-mcp-server
npm install
npm test
npm link
cd ~/.node-red
npm link <package-name>
```

## Flow Server Extensions

`mcp-runtime` owns the local HTTP listener: port, public base URL, auto-start, CORS, and optional admin API settings.

`mcp-redis` defines storage for short-lived authorization state and opaque access tokens. Memory mode is for local development only. Redis-backed modes are intended for shared or restarted runtimes.

`mcp-auth` defines OIDC settings, storage selection, and token TTLs. Secrets are stored as Node-RED credentials or read from environment variables.

Client metadata hosts must be allow-listed. This prevents the authorization endpoint from fetching arbitrary user-provided URLs during client metadata validation.

`mcp-flow-server` defines one logical MCP endpoint on a selected runtime: MCP name, HTTP path, optional auth config, endpoint groups/scopes, and base scopes. A runtime is required.

One runtime owns one local port. Multiple endpoints may share that runtime port when their MCP paths differ.

Tool execution request emitted by the flow server:

```js
msg.topic = 'mcp-tool-execute';
msg.payload = { toolName, arguments, executionId };
```

Tool response returned to the same flow server node:

```js
msg.topic = 'mcp-tool-response';
msg.payload = { executionId, result };
```

`result` can be a standard MCP result object. Plain strings and plain objects are normalized into text responses.

## Configuration Notes

`mcp-flow-server` endpoint scopes and `mcp-tool-registry` required scopes are both enforced when an endpoint requires OAuth. Tool descriptors also advertise the combined scopes in `_meta.securitySchemes`.

`mcp-tool-registry` can bind a tool to one endpoint. Leaving the endpoint empty exposes the tool on every endpoint in the same Node-RED runtime.


Admin tools expose read-only `get_flow` only when the selected runtime has Admin Port, Admin Token, and Admin Endpoint Path configured, and the endpoint path exactly matches that Admin Endpoint Path.

Protected endpoints return `401` with `WWW-Authenticate` pointing to OAuth protected-resource metadata. Access decisions combine endpoint groups, endpoint scopes, and tool scopes.

The authorization endpoint requires PKCE S256, validates the client metadata host allow-list, checks the exact redirect URI against the client metadata document, delegates login to the configured OIDC issuer, validates the returned ID token through JWKS, and issues short-lived opaque MCP access tokens.

## Verification

Run before commit:

```bash
npm test
npm pack --dry-run
```

Run source scans before publishing to confirm that sensitive material and environment-specific names are absent.

## Upstream Updates

Keep upstream as the base. Pull new upstream releases into a candidate branch, then reapply the documented local patch set and run the verification suite.

## License

MIT. See `LICENSE`.
