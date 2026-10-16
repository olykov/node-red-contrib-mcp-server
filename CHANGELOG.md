# Changelog

All notable changes, newest first. Each entry names its release date. From 3.1.0 the
package uses plain SemVer and every release gets its own version; earlier versions used
the `-upstream.N` prerelease suffix, and several builds shared `2.0.0-upstream.1`.

## Unreleased

- README: deploy guidance follows Node-RED's deploy modes (Modified Nodes by default) and lists
  what restarts an endpoint.

## 3.3.0 - 2026-10-15

- At most 32 concurrent tool calls per endpoint; further calls get JSON-RPC error `-32000` and
  an audit line with outcome `rejected`.
- Authorization responses (code and error redirects) carry `iss` (RFC 9207); metadata advertises
  `authorization_response_iss_parameter_supported`.
- Editor: Input and Output Schema use the Node-RED code editor in JSON mode.
- README: issuer scope and deploy guidance (Modified Flows, one tab per MCP endpoint).
- Development: ESLint (`npm run lint`), coverage thresholds (`npm run coverage`) and a GitHub
  Actions workflow on Node.js 22 and 24.

## 3.2.0 - 2026-10-15

Breaking for clients that listed tools anonymously.

- Require a valid token for `tools/list`, `tools/call` and every method except the
  `initialize` handshake; answer HTTP 401 with `WWW-Authenticate` instead of an MCP
  `isError` result with `_meta["mcp/www_authenticate"]`.

## 3.1.0 - 2026-10-15

Security and audit review. Breaking for configurations without Base URL or Groups; see
README "Upgrading to 3.1".

- Audit log: one JSON line per sign-in, token issue, refresh, rejected token or access, tool call
  and start/stop/restart command, with subject, client and session hash; the flow receives the
  caller in `msg.mcp`; MCP Metrics telemetry carries `user` (e-mail) and `client` for metric labels.
- `get_flow` config mode redacts named secret keys, URL user information and `env` values.
- Require a runtime Base URL and at least one Group per endpoint (endpoints do not start otherwise).
- Client Hosts match exactly (`*.host` for subdomains); client metadata must name its own URL as
  `client_id`; stricter private-address checks; 8 KiB metadata limit.
- Bind the upstream sign-in `state` to the browser with an HttpOnly cookie.
- Validate PKCE `code_challenge` and `code_verifier` formats.
- Smaller request body limits (JSON 256 KiB, form 16 KiB); memory storage removes expired entries.
- Tool results: `undefined`/`null` become empty content, Buffers become text, error objects keep
  their message; `serverInfo.version` reports the package version.
- Editor: Base URL and Groups required, text inputs, helpers scoped in an IIFE, short status texts,
  documented `payload.command` and `msg.mcp`; registry register/unregister logs at debug.
- Packaging: Node.js >= 22.9 (Node-RED 5 minimum), `proxy-addr` 2.0.8, author/contributors,
  fork copyright, no `sse` keyword. README: audit log, environment variables, rollback.

## 3.0.2-upstream.1 - 2026-10-15

- Editor: mid-tone node colours so the white icons stay visible.

## 3.0.1-upstream.1 - 2026-10-15

- Remove the Reuse Grace editor field; refresh reuse grace is fixed at 30 seconds.
- Editor: short palette labels (MCP Server, MCP Metrics, MCP Tool) and light node colours with readable labels.

## 3.0.0-upstream.1 - 2026-10-15

Breaking; see README "Upgrading to 3.0".

- Rename the package to `@olykov/node-red-mcp-server`; declare `node-red.version >=5.0.0` instead of a `node-red` peer dependency.
- Require the `MCP_` prefix for editor-supplied environment variable names; default storage URL variable is `MCP_REDIS_URL`; invalid names are reported and stop dependent endpoints.
- Bind `mcp-tool-registry` tools to the endpoint MCP path instead of the node ID; `get_flow` reports `endpointPath`.
- Emit only `mcp-tool-execute` on the `mcp-flow-server` output; remove lifecycle events, the `status` reply and the runtime `/health` route.
- Key auth sessions by provider settings and slug instead of the auth node ID, so replacing the node keeps sessions.

## 2.1.2-upstream.1 - 2026-10-15

Breaking: the legacy SSE stream is removed.

Review against the Node-RED Creating Nodes documentation:

- Register the `mcp-runtime` Admin Token as a credential so the editor value is stored.
- Remove the unauthenticated legacy SSE stream; GET answers 401 or 405 and close no longer waits for idle sockets.
- Parse endpoint Groups separated by commas or spaces, as the editor describes.
- Require read permission for the editor server listing and build its status list from text.
- Use the Node-RED 1.0 input signature with `send`/`done`; cancel restart and delayed tool registration timers on close; send nothing while closing.
- Return 503 and log storage failures on OAuth routes; log unknown refresh tokens; keep internal error text out of client responses.
- Redirect provider denials to the client `redirect_uri`; report invalid `mcp-auth` settings instead of throwing, and stop dependent endpoints.
- Route Redis client errors to a rate-limited warning.
- Editor: validators for tool names, schemas, ports and storage modes; live provider selection in validators; palette labels, input label, theme colours and buttons; help rewritten to the help style guide.
- Ship a working example flow; declare Node 18, repository metadata and no longer publish tests or the unused `qs` dependency.

## 2.1.1-upstream.1 - 2026-10-14

- Allow encrypted, idempotent refresh retries within a configurable 30-second grace window; bound it to 0-120 seconds.
- Wait briefly for concurrent refresh completion without revoking legitimate sessions; preserve strict replay rejection outside grace.
- Return retryable 503 responses for provider outages and restore claims atomically; retain definitive identity and policy rejection.
- Preserve encrypted pending results across interrupted token storage/rotation and log only non-sensitive outcome classes.
- Treat provider `invalid_client`/`unauthorized_client` refresh responses as configuration errors: return 503, keep the session and log `provider_config` at error level.

## 2.1.0-upstream.1 - 2026-10-14

Breaking: public and inherited auth modes, custom scope policies and the external-process
server and remote-client nodes are removed.

- Add rotating MCP refresh tokens with client/resource binding, replay rejection and upstream provider revalidation.
- Encrypt provider refresh credentials using the selected provider's password credential key; advertise offline access only when refresh is configured.
- Bound access, refresh inactivity and absolute session lifetimes to 15 minutes, 7 days and 21 days respectively.
- Add atomic auth-code consumption and refresh-session updates to memory and Redis storage.
- Preserve existing callback URLs and provider selection; add local provider, expiry, rotation and HTTP grant tests.
- Remove external-process server and remote-client nodes, their editor forms, client example branch and unused dependencies.
- Keep flow-serving endpoints, tool registration and metrics.
- Require OAuth for every endpoint; remove public/inherited auth modes and custom endpoint/tool scope policies.
- Derive provider scopes automatically instead of exposing Base Scopes fields; retain offline access and anonymous discovery with protected execution.
- Start endpoints automatically on flow startup; remove configurable auto-start and all CORS handling, including SSE headers.
- Remove the auth enable switch and configurable code/state lifetimes; fix both transaction lifetimes at 300 seconds.
- Label the stable OAuth route field Slug and show a live redirect URL template without assuming the server host.
- Use the generic OIDC provider name and credential key; place Microsoft Entra ID first without changing the selected provider.
- Rename the runtime field to Base URL and clarify direct/VPN/proxy deployment wording without changing OAuth URL construction.

## 2.0.2-upstream.1 - 2026-10-14

- Keep initialization and tool discovery available without valid credentials while enforcing authorization before tool execution.
- Advertise OAuth policies on protected flow and admin tools and return tool-level authentication challenges for missing/invalid tokens or insufficient tool scopes.
- Fail closed for unresolved required auth configuration; preserve role/resource denials and authenticated GET/SSE.
- Avoid stale keep-alive socket reuse in the listener-replacement regression test.

## 2.0.1-upstream.1 - 2026-10-13

- Allow registered HTTP loopback redirect ports when CIMD omits `application_type`, as well as for explicit native clients.
- Retain exact host/path/query matching, strict authorization-code exchange and rejection of port changes for explicitly non-native clients.

## 2.0.0-upstream.1 - 2026-09-23 to 2026-10-13 (several builds)

- Added `mcp-runtime` config nodes for shared local MCP listener settings.
- Moved logical MCP endpoint settings onto `mcp-flow-server`.
- Added endpoint dropdown binding and per-tool required scopes to `mcp-tool-registry`.
- Restricted read-only admin tools to the configured runtime admin endpoint path.
- Rebased the fork on upstream `node-red-contrib-mcp-server@1.1.5`.
- Kept upstream node types and flow-server execution behavior.
- Added optional read-only Node-RED flow inspection.
- Added automated tests for local extensions.
- Removed earlier local OAuth registration shim behavior from this package.
- Removed the unused `mcp-tool` node and direct JSON-RPC tool method compatibility.
- Expanded runtime metrics to cover all MCP tool calls across endpoints, including failed calls.
- Added generic OIDC auth and auth-storage config nodes for MCP endpoints.
- Added OAuth protected-resource and authorization-server metadata responses.
- Added bearer-token enforcement for protected MCP endpoints.
- Added endpoint and tool scope/group policy checks.
- Added authorization-code exchange with PKCE S256, OIDC ID token validation, and opaque MCP access tokens.
- Added tests for OAuth challenges, token exchange, authorized initialization, tool filtering, and forbidden tool calls.
