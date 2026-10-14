# Changelog

## 2.1.2-upstream.1

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

## 2.1.1-upstream.1

- Allow encrypted, idempotent refresh retries within a configurable 30-second grace window; bound it to 0-120 seconds.
- Wait briefly for concurrent refresh completion without revoking legitimate sessions; preserve strict replay rejection outside grace.
- Return retryable 503 responses for provider outages and restore claims atomically; retain definitive identity and policy rejection.
- Preserve encrypted pending results across interrupted token storage/rotation and log only non-sensitive outcome classes.
- Treat provider `invalid_client`/`unauthorized_client` refresh responses as configuration errors: return 503, keep the session and log `provider_config` at error level.

## Unreleased

- Remove external-process server and remote-client nodes, their editor forms, client example branch and unused dependencies.
- Keep flow-serving endpoints, tool registration and metrics.
- Require OAuth for every endpoint; remove public/inherited auth modes and custom endpoint/tool scope policies.
- Derive provider scopes automatically instead of exposing Base Scopes fields; retain offline access and anonymous discovery with protected execution.
- Start endpoints automatically on flow startup; remove configurable auto-start and all CORS handling, including SSE headers.
- Remove the auth enable switch and configurable code/state lifetimes; fix both transaction lifetimes at 300 seconds.
- Label the stable OAuth route field Slug and show a live redirect URL template without assuming the server host.
- Use the generic OIDC provider name and credential key; place Microsoft Entra ID first without changing the selected provider.
- Rename the runtime field to Base URL and clarify direct/VPN/proxy deployment wording without changing OAuth URL construction.

## Unreleased

- Removed the unused `mcp-tool` node and direct JSON-RPC tool method compatibility.
- Expanded runtime metrics to cover all MCP tool calls across endpoints, including failed calls.
- Added generic OIDC auth and auth-storage config nodes for MCP endpoints.
- Added OAuth protected-resource and authorization-server metadata responses.
- Added bearer-token enforcement for protected MCP endpoints.
- Added endpoint and tool scope/group policy checks.
- Added authorization-code exchange with PKCE S256, OIDC ID token validation, and opaque MCP access tokens.
- Added tests for OAuth challenges, token exchange, authorized initialization, tool filtering, and forbidden tool calls.

## 2.1.0-upstream.1

- Add rotating MCP refresh tokens with client/resource binding, replay rejection and upstream provider revalidation.
- Encrypt provider refresh credentials using the selected provider's password credential key; advertise offline access only when refresh is configured.
- Bound access, refresh inactivity and absolute session lifetimes to 15 minutes, 7 days and 21 days respectively.
- Add atomic auth-code consumption and refresh-session updates to memory and Redis storage.
- Preserve existing callback URLs and provider selection; add local provider, expiry, rotation and HTTP grant tests.

## 2.0.2-upstream.1

- Keep initialization and tool discovery available without valid credentials while enforcing authorization before tool execution.
- Advertise OAuth policies on protected flow and admin tools and return tool-level authentication challenges for missing/invalid tokens or insufficient tool scopes.
- Fail closed for unresolved required auth configuration; preserve role/resource denials and authenticated GET/SSE.
- Avoid stale keep-alive socket reuse in the listener-replacement regression test.

## 2.0.1-upstream.1

- Allow registered HTTP loopback redirect ports when CIMD omits `application_type`, as well as for explicit native clients.
- Retain exact host/path/query matching, strict authorization-code exchange and rejection of port changes for explicitly non-native clients.

## 2.0.0-upstream.1

- Added `mcp-runtime` config nodes for shared local MCP listener settings.
- Moved logical MCP endpoint settings onto `mcp-flow-server`.
- Added endpoint dropdown binding and per-tool required scopes to `mcp-tool-registry`.
- Restricted read-only admin tools to the configured runtime admin endpoint path.
- Rebased the fork on upstream `node-red-contrib-mcp-server@1.1.5`.
- Kept upstream node types and flow-server execution behavior.
- Added optional read-only Node-RED flow inspection.
- Added automated tests for local extensions.
- Removed earlier local OAuth registration shim behavior from this package.
