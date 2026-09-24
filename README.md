# Node-RED MCP Server

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

The first `mcp-flow-server` output keeps tool execution and status messages. The second output emits one `mcp-admin-telemetry` message per admin tool call for optional flow-based metrics. Its payload contains `tool`, `mode`, `status` (`success` or `failed`), `durationMs`, `responseBytes`, `scannedNodes`, and `cached`. Duration covers server-side tool execution and response serialization, not client network time. Response bytes cover the MCP JSON response body when a Content-Length header is available; unavailable values are `null`. No tool arguments, node IDs, flow content, or credentials are emitted. An unwired second output does not change MCP responses.

`mcp-server-metrics` is a source node with no input and one output. Select the same `mcp-runtime` used by the MCP endpoints, then connect its output to metric writers. Use one metrics node per runtime. It emits the same admin telemetry with the configured endpoint name in `payload.endpoint`; it does not poll Node-RED or expose a metrics route. The flow server's second output remains available during migration. Do not connect both outputs to the same metric writer, or calls will be counted twice.

## Configuration Notes

`mcp-flow-server` endpoint scopes and `mcp-tool-registry` required scopes are both enforced when an endpoint requires OAuth. Tool descriptors also advertise the combined scopes in `_meta.securitySchemes`.

`mcp-tool-registry` requires an explicit endpoint choice. Select a specific endpoint for endpoint-scoped tools, or select `Shared (All MCPs)` only for tools intentionally exposed on every endpoint in the same Node-RED runtime.


Admin tools expose read-only `get_flow` only when the selected runtime has Admin Port, Admin Token, and Admin Endpoint Path configured, and the endpoint path exactly matches that Admin Endpoint Path.

### Inspecting Node-RED flows

`get_flow` returns compact `structuredContent` and a matching text result. It never returns a raw tab export.

| Arguments | Result | Admin API read |
| --- | --- | --- |
| none, or `mode: "tabs"` | Paginated tab IDs, labels, disabled state and node counts | In-process runtime index |
| `id`, or `mode: "tab_summary", id` | Groups, wired chains, key nodes, counts | `/flow/:id` |
| `mode: "group", id, groupId` | Group members and their direct wires | `/flow/:id` |
| `mode: "chain", id, nodeId` | Wired component containing the node | `/flow/:id` |
| `mode: "node", id, nodeId` | Selected node and direct incoming/outgoing wires | `/flow/:id` |
| `mode: "subflows"` | Definition index | `/flow/global` |
| `mode: "subflow", subflowId` | Definition and contained node index | `/flow/global` |
| `mode: "subflow", subflowId, id` | Definition and usages on one specified tab | `/flow/global`, `/flow/:id` |

Use `offset` from `meta.nextOffset` to continue a paginated response. A chain follows direct wires within one tab; link nodes expose target IDs but are not traversed into other tabs. Node details include only an allowlist of identifiers and labels. `includeCode: true` works only with `mode: "node"` and returns at most 2,000 Function code characters.

`get_flow` never requests the full `/flows` export. The tab index walks Node-RED's in-memory configuration once and caches only compact tab metadata until the next runtime deploy; it does not serialize or transfer full flows. `meta.cached` indicates whether the index was reused. The index excludes undeployed editor changes. Tab detail modes read `/flow/:id`; subflow modes read `/flow/global` and optionally the specified tab. These endpoints still make Node-RED prepare the selected flow before the palette applies its response limits. Responses cap lists at 40 items and edges at 80; Admin API reads have a 15-second timeout and a 32 MiB response limit. Tab indexing stops above 100,000 configuration nodes; graph inspection stops above 20,000 nodes or 100,000 wire visits. `meta` reports the source, scan count, returned node count and truncation.

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
