# Changelog

All notable changes, newest first. Each entry names its release date. From 3.1.0 the
package uses plain SemVer and every release gets its own version; earlier versions used
the `-upstream.N` prerelease suffix, and several builds shared `2.0.0-upstream.1`.

## 4.2.0 - 2026-10-19

Breaking release; convert 3.x flows with `nr-mcp-migrate` (README "Upgrading to 4.0").

- Protocol: MCP 2025-06-18, 2025-11-25 and 2026-07-28. 2025 clients start with `initialize`
  (answered with the requested revision or `2025-11-25`), send `MCP-Protocol-Version` on every
  request, may use `ping` and cancel calls with `notifications/cancelled`; their results carry no
  2026 fields. 2026-07-28 clients use `server/discover`, `resultType`, cache hints and
  `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` checks (`-32020`). Unknown revisions get `-32022`
  with the supported list. Every request, `initialize` included, needs a token. Closing the
  connection cancels a running tool call.
- Nodes: types use the `nr-mcp-` prefix (`nr-mcp-runtime`, `nr-mcp-endpoint`, `nr-mcp-tool`,
  `nr-mcp-tool-response`, `nr-mcp-metrics`, `nr-mcp-auth`, `nr-mcp-auth-storage`) and install next
  to the upstream package. A call leaves `nr-mcp-tool` with the arguments in `msg.payload` and the
  call data in `msg.mcp`; `nr-mcp-tool-response` answers. An optional second tool output receives
  cancellation and timeout. Tools need a Scope: Endpoint or Shared.
- Endpoint: a configuration node without wires; `start`, `stop` and `restart` are removed.
  Endpoint failures show as `endpoint error` on its tools.
- Runtime: owns the listener and the tool registry; tools register synchronously, a runtime
  redeploy closes and opens its port once. `runtimeName`, the Admin API CA field and the
  `NODE_RED_ADMIN_API_TOKEN` fallback are removed.
- Admin Tools: the runtime serves `get_flow` itself when **Admin Tools** is enabled, on its Admin
  Path with its own Auth and Groups; no endpoint configuration node is needed, so none shows as
  unused. Admin fields appear only when Admin Tools is enabled.
- Migration: `nr-mcp-migrate --input --output` converts a 3.x flow, keeps node ids and credential
  field names, moves the admin endpoint into the runtime Admin Tools and lists the routing nodes
  that need manual changes.
- Fixes: group names split only on commas and new lines; tool schemas valid under JSON Schema
  2020-12 are no longer rejected by Ajv lint rules; the annotation label is Open World.

## 3.5.0 - 2026-10-17

- Dependencies: `ipaddr.js` is no longer a direct dependency; Trusted Proxies matching uses
  `node:net` (`lib/cidr.js`). Runtime dependencies are `ajv`, `express`, `ioredis` and `jose`.
- Node status texts come from the `locales/en-US` catalogs (`lib/messages.js`).
- Release: `release.yml` reuses the CI matrix, publishes with npm trusted publishing and
  provenance from the protected `npm` environment (no token), and creates the GitHub Release
  only after a successful publish. CI also runs `npm run check:spec`; `REVIEW.md` records the
  requirements verified by review.
- Tests: fixed the MCP-PROTO-2 test (it now sends a token), added requirement markers for the
  3.4 and 3.5 requirements and the section 6 invariants.
- Validation: tool Input and Output Schema are compiled with Ajv (JSON Schema 2020-12) at
  registration; invalid schemas, invalid tool names or a Tool Timeout above its endpoint's Tool
  Timeout stop the tool from registering; call-time arguments are validated against the compiled
  Input Schema.
- Security: `mcp-runtime` Trusted Proxies (CIDR list) gate which `X-Forwarded-For` addresses are
  trusted for audit/metrics `client`; Admin Token resolution now prefers the credential, then
  Admin Token Env, then the deprecated `NODE_RED_ADMIN_API_TOKEN` (logs a warning instead of
  silently overriding the credential); admin HTTP requests support HTTPS and a CA override.
- Protocol: advertise `tools.listChanged: false`; `isError: true` tool results no longer carry a
  JSON-RPC `error` object; `notifications/cancelled` frees the concurrency slot immediately and a
  late flow response is dropped with a debug log instead of a warn "Orphan response".
- Lifecycle: a deferred `restart` whose 1-second timer is still pending when the node closes now
  calls `done()` exactly once; the Node-RED 0.x `done` shim is removed (Node-RED `>=5.0.0 <6.0.0`
  always supplies `done`).
- Storage/dependencies: in-memory auth storage uses a plain `Map` instead of `node-cache`;
  identity-provider HTTP calls use the built-in `fetch` with response size/time limits instead of
  `axios`; Redis client sets connect/command timeouts and disables offline queueing/retries so a
  down Redis fails fast instead of hanging; `ipaddr.js` added for CIDR parsing.
- i18n: editor labels, placeholders, tips, status texts and help panels moved from inline HTML to
  `locales/en-US/*.json` and `*.html` message catalogs for all four nodes, enabling future
  translations without touching node definitions.
- Packaging: `package.json` gains `exports`, `publishConfig.access`, the `node-red` keyword, a
  pinned `node-red: ">=5.0.0 <6.0.0"` range, `locales/` in `files`; `SECURITY.md` added; a tagged
  release GitHub Actions workflow (`release.yml`) publishes to npm.
- Documentation: "Upgrading to 3.5" migration guidance, a "Kubernetes" deployment section
  (bindHost, trustedProxies, allowedOrigins, preStop pause, readiness/liveness, mandatory Redis
  with multiple pods), and corrected the Admin Token precedence and tool-argument-validation notes.
- Tests: Ajv validation, trusted-proxy client IP resolution, deferred-restart-close and
  cancellation/concurrency-slot/late-response coverage, i18n catalog structure checks.

## 3.4.0 - 2026-10-16

- HTTP: normalize malformed and oversized JSON responses, include request IDs for internal
  failures, avoid logging request bodies, and return retryable MCP storage failures.
- Security: bind new runtimes to loopback, restrict browser origins, preserve legacy bind behavior
  with a warning, and make Function code available only to explicitly permitted groups.
- Registry: track tool ownership, omit duplicate names with a single conflict warning, and return
  tools in deterministic order.
- Tests and packaging: add real Node-RED integration coverage, a clean-userDir tarball smoke test,
  strict unhandled-rejection handling, and a Node 22/24 × Node-RED 5.0/latest CI matrix.
- Documentation: update the 3.4 migration guidance, deploy guidance, runtime help, and example
  environment names.

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
