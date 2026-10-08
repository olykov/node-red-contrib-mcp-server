# Node-RED MCP Server

Upstream-first fork of `node-red-contrib-mcp-server@1.1.5` for MCP tool runtimes.

The package keeps the upstream node model and adds endpoint-scoped MCP flow serving, read-only admin helpers, and package-level OAuth support for MCP endpoints.

## Scope

Included nodes:

- `mcp-server`
- `mcp-client`
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

`mcp-auth` selects its active identity provider using the Authentik or Microsoft Entra ID tab.
Each provider keeps separate client settings and secrets. Shared settings select storage, client metadata hosts and token TTLs.
Secrets are stored as Node-RED credentials or read from environment variables.

Authentik uses an HTTPS issuer URL, client ID, scopes and UserInfo claim names.
Microsoft uses a tenant GUID and application client GUID; its tenant-specific v2 issuer,
`openid profile email` scopes and `roles` claim are fixed. Microsoft permissions come only
from the verified ID token; at least one assigned app role is required. Endpoint Allowed Groups
must match the role values used for that endpoint. No Graph directory permissions are needed.

Authorization state, codes and access tokens are isolated by auth node, provider, issuer,
client ID and claim settings, even when storage is shared. Switching provider/configuration
requires a new login. Existing configurations must explicitly select a provider and be saved;
there is no legacy-provider inference. Switching back to an identical configuration can reuse
its unexpired tokens; switching is not a token-revocation mechanism.

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

The `mcp-flow-server` output emits tool execution and status messages. Return matching `mcp-tool-response` messages to the node input.

`mcp-server-metrics` is a source node with no input and one output. Select the same `mcp-runtime` used by the MCP endpoints, then connect its output to metric writers. Use one metrics node per runtime. It emits one `mcp-tool-telemetry` message for each `tools/call` request across those endpoints, including failed calls and authentication failures. Its payload contains `endpoint`, `tool`, `mode`, `status`, `durationMs`, `responseBytes`, `scannedNodes`, and `cached`. Unknown and unauthenticated tool names are reported as `unknown` to bound metric cardinality. It does not poll Node-RED or expose a metrics route.

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
| `mode: "configs", id` | Paginated config-node IDs, types and names for one tab | `/flow/:id` |
| `mode: "configs", subflowId` | Paginated config-node index for one subflow definition | `/flow/global` |
| `mode: "configs"` | Paginated global config-node index | `/flow/global` |
| `mode: "config", configId` with optional `id` or `subflowId` | Ordinary properties of one config node in the selected scope | `/flow/global` or `/flow/:id` |
| `mode: "node_configs", nodeId` with `id` or `subflowId` | Config references of one node, including the property name and scope | `/flow/:id`, `/flow/global` for tabs; `/flow/global` for subflows |

Use `offset` from `meta.nextOffset` to continue a paginated response. A chain follows direct wires within one tab; link nodes expose target IDs but are not traversed into other tabs. Node details include only an allowlist of identifiers and labels. `includeCode: true` works only with `mode: "node"` and returns at most 10,000 Function code characters.

Use `includeConfig: true` with `mode: "node"` to inspect supported execution settings:

| Node type | Settings |
| --- | --- |
| `inject` | Payload, topic, properties and scheduling |
| `link in`, `link out`, `link call` | Links, output mode, call type and timeout as applicable |
| `switch` | Property/type, rules, check-all, repair and outputs |
| `catch` | Scoped node IDs and uncaught setting |
| `mongodb4` | Operation mode, collection, operation, output, timeout and ID handling |
| `mcp-flow-server` | Route, auth mode, groups and required/advertised scopes |
| `mcp-tool-registry` | Description, input/output schemas, endpoint, behavior, world access and scopes |

Settings retain their configured types; absent fields are not filled with inferred defaults.
`node.configSupported` identifies supported types. Values over 32 KiB, excessive nested structures
or settings beyond the 64 KiB config budget are omitted, listed in `configOmittedProperties`, and
set `meta.truncated`. Nested values are limited to 16 levels and 2,000 visited values per request.
Credentials and arbitrary top-level properties are excluded. Named secret keys inside supported
structures, including JSON schema strings, are replaced with `[REDACTED]` and identified in
`configRedactedProperties`; invalid JSON schema text is omitted. Literal strings may still contain
secrets stored outside credential fields: this is not a general-purpose secret detector.
Default node, tab, group and chain inspection remain compact. Config references remain available
through `node_configs`; no credential API is called.

Config-node details retain ordinary property types and values. Node-RED's flow API excludes declared credential values; an unexpected `credentials` container is replaced with `[REDACTED]` defensively. No credential API is called. A property over 32 KiB is listed in `omittedProperties` instead of being returned; config properties are paginated by 40 fields and 64 KiB of values. Properties that a node author stored outside Node-RED's credential mechanism remain ordinary properties and are not automatically redacted.

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
