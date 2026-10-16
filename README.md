# Node-RED MCP Server

`@olykov/node-red-mcp-server` is an upstream-first fork of `node-red-contrib-mcp-server@1.1.5`
for MCP tool runtimes. The scoped name keeps an accidental install of the upstream package from
replacing it. The source repository keeps the upstream name `node-red-contrib-mcp-server`; the
npm package is `@olykov/node-red-mcp-server`. All node types use the `nr-mcp-` prefix, so the
package installs next to the upstream package without type conflicts. Requires Node-RED 5.0 or
later and Node.js 22.9 or later.

The package exposes Node-RED flows as endpoint-scoped MCP servers with read-only admin helpers and package-level OAuth support.

## Scope

Included nodes:

- `nr-mcp-tool`
- `nr-mcp-tool-response`
- `nr-mcp-metrics`
- `nr-mcp-runtime` config node
- `nr-mcp-endpoint` config node
- `nr-mcp-auth` config node
- `nr-mcp-auth-storage` config node

Local extensions:

- Runtime config nodes for local MCP listener settings.
- Endpoint nodes for logical MCP names and paths.
- Endpoint-scoped and shared tool registration.
- Automatic provider scopes in `_meta.securitySchemes`.
- Optional read-only `get_flow` tool gated by runtime admin settings and an exact endpoint path.
- OIDC-backed MCP authorization configuration.
- Memory or Redis-backed storage for short-lived auth state and opaque access tokens.
- Bearer token enforcement for protected MCP endpoints.
- Authorization-code flow bridge with PKCE S256, OIDC ID token validation, and userinfo claim extraction.
- Tests for the read-only admin boundary and flow-server execution path.

Not included yet:

- Verified interoperability with hosted MCP clients.
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
npm install git+ssh://git@github.com/olykov/node-red-contrib-mcp-server.git#<commit>
```

For local development:

```bash
cd /path/to/node-red-contrib-mcp-server
npm install
npm test
npm link
cd ~/.node-red
npm link @olykov/node-red-mcp-server
```

## Upgrading to 3.5

The package now declares `node-red: ">=5.0.0 <6.0.0"` (was open-ended). Reinstall dependencies:
`axios` and `node-cache` are gone, replaced by the built-in `fetch` (identity-provider HTTP
calls) and a plain `Map` (in-memory token/session storage); `ajv` and `ipaddr.js` are new
dependencies.

Tool **Input Schema** and **Output Schema** are now compiled with Ajv (JSON Schema 2020-12) when
the tool registers. A tool with an invalid schema, an invalid name (must match
`^[a-z][a-z0-9_]{0,63}$`) or a **Tool Timeout** above its endpoint's **Tool Timeout** no longer
registers; its status turns red (`invalid`) and the reason is logged with `node.warn`. At call
time, arguments that fail the compiled Input Schema are rejected before the flow runs. To roll
back a tool that no longer registers, fix its name, schema or timeout, or pin the 3.4.x release.

`mcp-runtime` **Admin Token** resolution order changed: the **Admin Token** credential, then
**Admin Token Env**, then the deprecated `NODE_RED_ADMIN_API_TOKEN` environment variable (which
now logs a deprecation warning and no longer overrides the credential). Update any deployment
that relied on `NODE_RED_ADMIN_API_TOKEN` taking priority.

Behind a reverse proxy, set **Trusted Proxies** (CIDR list) on `mcp-runtime` so audit log and
metrics `client` IPs use `X-Forwarded-For` only from those addresses; without it, every client is
reported by the socket address.

The MCP endpoint advertises `tools.listChanged: false` (the palette does not send
`notifications/tools/list_changed`); `isError: true` tool results no longer include a
JSON-RPC `error` object, matching the specification's distinction between protocol errors and
tool execution errors. `notifications/cancelled` for an in-flight call now frees its concurrency
slot immediately; a flow response that arrives after cancellation or timeout is dropped with a
debug log line instead of a `warn` "Orphan response" line. A `restart` command whose 1-second
timer is still pending when the node closes now calls its deferred `done()` exactly once instead
of leaving it uncalled.

Editor labels and help panels now come from `locales/en-US/*.json` and `*.html` message
catalogs instead of inline HTML; non-English translations can be added under `locales/<lang>/`
without touching the node definitions.

See `README.md` "Kubernetes" below for `bindHost`, `trustedProxies`, `allowedOrigins` and probe
guidance when running more than one pod. To roll back, pin the 3.4.x release; no other
configuration changes are required.

## Upgrading to 3.2

`tools/list` now requires a token. Clients that listed tools anonymously must sign in first;
Claude Code and Codex do this on the HTTP 401. To roll back, pin the 3.1.0 commit.

## Upgrading to 3.4

New runtime nodes bind to `127.0.0.1` by default. Existing runtimes without a saved **Bind
Host** keep listening on all interfaces for compatibility and log a warning; set the address
explicitly after upgrade. If a browser-based MCP client connects from an origin different from
the runtime **Base URL**, add that exact origin to **Allowed Origins**. Requests without an
`Origin` header are unaffected.

`get_flow` no longer advertises Function code by default. To allow it, enable **Allow Function
Code** on the runtime and specify **Code Groups**. Only callers in those groups can request the
code. Function code is passed to the MCP client without secret redaction, so enable this only
for trusted users. To roll back, restore the previous runtime fields and pin the 3.3.x release.

## Upgrading to 3.1

1. Set the `mcp-runtime` **Base URL**. Endpoints no longer derive OAuth URLs from request
   headers and do not start without it.
2. Give every `mcp-flow-server` at least one **Group**. An endpoint without groups no longer
   admits every identity-provider user; it does not start.
3. Check **Client Hosts**: entries now match exactly. Use `*.example.com` to allow subdomains.
   Client metadata documents must contain a `client_id` equal to their URL.
4. Users sign in once more: sign-in now binds the upstream `state` to the browser with a
   cookie, so sign-ins started before the upgrade are rejected.

## Upgrading to 3.0

3.0 renames the package and changes three contracts. Before deploying it:

1. Uninstall `node-red-contrib-mcp-server` from the Node-RED user directory and install
   `@olykov/node-red-mcp-server`; the node types keep their names.
2. Rename editor-supplied environment variables to the `MCP_` prefix, for example
   `REDIS_URL` to `MCP_REDIS_URL`, in the runtime environment and in the `mcp-redis` and
   `mcp-auth` configuration nodes. A configuration with another name is reported as
   invalid and its endpoints do not start.
3. Open every `mcp-tool-registry` node and select its endpoint again: tools now bind by
   MCP path, not by node ID.
4. The `mcp-flow-server` output now carries only `mcp-tool-execute` messages; the
   `mcp-server-started`, `mcp-server-stopped` and `status` replies were removed, and the
   runtime no longer serves `/health`. Endpoint state is shown in the node status.

Existing sessions end once after the upgrade because session storage is no longer keyed by
the auth node ID; users sign in again.

## Flow Server Extensions

`mcp-runtime` owns the local HTTP listener: port, bind host, base URL and optional admin API settings. New runtimes bind to loopback; use a reverse proxy or configure an explicit address when remote clients must connect. Endpoints start automatically on Node-RED's `flows:started` event. Browser requests are restricted to the Base URL origin and explicitly allowed origins.

Base URL is required. It is the address clients and their browsers use to reach the MCP runtime,
directly or through a proxy. It may be VPN-only; public internet exposure is not
required. Changing that address requires updating the runtime configuration,
provider callback registration and client endpoint URLs, not OAuth code.
The runtime listener currently serves HTTP. HTTPS must terminate outside that
listener; removing TLS termination entirely requires separate HTTPS runtime
support. This is independent of whether the endpoint is VPN-only or internet-facing.

`mcp-redis` defines storage for short-lived authorization state and opaque access tokens. Memory mode is for local development only. Redis-backed modes are intended for shared or restarted runtimes.

`mcp-auth` selects its active identity provider using the Microsoft Entra ID or OIDC tab.
Each provider keeps separate client settings and secrets. Shared settings select storage, client metadata hosts and token TTLs. Provider scopes are fixed in code, not editable fields.
Secrets are stored as Node-RED credentials or read from environment variables.
Authorization state and one-time authorization codes expire after a fixed 300
seconds. Auth configurations have no separate enable/disable switch.

Set an explicit shared **OAuth slug**, for example `team-login`. It must start with a
lowercase letter and contain only lowercase letters, digits or hyphens (1-63 characters).
Register `https://mcp.example.test/oauth/team-login/callback` with the selected provider.
Authorize, token and authorization-server metadata routes use the same slug, not the
Node-RED node ID. Keep the slug when replacing an auth node; the registered callback
stays unchanged and, with the same provider settings, existing sessions continue. Separate auth configurations cannot
share a slug on the same listener or base URL. Multiple endpoints can share
one auth configuration. There is no fallback or alias for node-ID routes.

OIDC uses an HTTPS issuer URL, client ID and UserInfo claim names;
its base scopes are fixed to `openid profile email groups`.
Microsoft uses a tenant GUID and application client GUID; its tenant-specific v2 issuer,
`openid profile email` scopes and `roles` claim are fixed. Microsoft permissions come only
from the verified ID token; at least one assigned app role is required. Endpoint Groups
(separated by commas; names may contain spaces) must match the role values used for that endpoint. No Graph directory permissions are needed.

Authorization state, codes and access tokens are isolated by auth node, provider, issuer,
client ID, claim settings and OAuth slug, even when storage is shared. Switching provider/configuration
requires a new login. Existing configurations must explicitly select a provider and be saved;
there is no legacy-provider inference. Switching back to an identical configuration can reuse
its unexpired tokens; switching is not a token-revocation mechanism.

Client metadata hosts must be allow-listed. Entries match the host exactly; `*.example.com` allows its subdomains. This prevents the authorization endpoint from fetching arbitrary user-provided URLs during client metadata validation. Private and loopback addresses (including bracketed IPv6 and IPv4-mapped forms) are rejected, documents are limited to 8 KiB, and the document's `client_id` must equal its URL. Host names are not resolved, so allow only hosts you trust.

`mcp-flow-server` is a configuration node that defines one logical MCP endpoint: MCP name, HTTP path and allowed groups. It has no wires and no commands; it starts when flows start. Both runtime and OAuth auth configurations are required. There is no public or inherited authorization mode.

One runtime owns one local port. Multiple endpoints may share that runtime port when their MCP paths differ.

Each `mcp-tool-registry` (MCP Tool) node starts the flow of its tool. A call leaves the node with:

```js
msg.payload = arguments;
msg.mcp = { executionId, toolName, subject, email, groups, client };
```

The flow puts the result in `msg.payload` and ends with an `mcp-tool-response` (MCP Tool Response) node, keeping `msg.mcp`. Set `msg.mcp.error` (string or Error) to return an error result. `msg.payload` can be a standard MCP result object; strings and other values are normalized into text responses. A message without `msg.mcp.executionId` or with an unknown one fails the response node for a Catch node; a response after cancellation or timeout is ignored.

With **Cancel Output** enabled, the MCP Tool node gets a second output that receives `msg.mcp = { executionId, toolName, reason }` when the client closes the request (`cancelled`) or the tool timeout expires (`timeout`).

Configuration nodes have no status of their own: an endpoint that cannot start logs the error and its tools show `endpoint error`. Tool telemetry comes from `mcp-server-metrics`.

`mcp-server-metrics` is a source node with no input and one output. Select the same `mcp-runtime` used by the MCP endpoints, then connect its output to metric writers. Use one metrics node per runtime. It emits one `mcp-tool-telemetry` message for each `tools/call` request across those endpoints, including failed calls and authentication failures. Its payload contains `endpoint`, `tool`, `user`, `client`, `mode`, `status`, `durationMs`, `responseBytes`, `scannedNodes`, and `cached`. `user` is the caller's e-mail (subject when no e-mail is known) and `client` the MCP client (`claude`, `codex`, `chatgpt` or the client host); unauthenticated calls report `unknown`. Unknown and unauthenticated tool names are reported as `unknown` to bound metric cardinality. `user` is personal data: use it as a metric label only while the set of users is small and the metrics store is access-controlled. It does not poll Node-RED or expose a metrics route.

## Configuration Notes

Tool execution always requires OAuth and checks endpoint roles/groups. Provider scopes are advertised automatically in `securitySchemes` and `_meta.securitySchemes`; custom endpoint/tool scope policies are not supported. `offline_access` is advertised only when refresh is configured.

`mcp-tool-registry` requires a Scope. **Endpoint** offers the tool on the selected `mcp-flow-server` only. **Shared** offers it on every endpoint of the selected `mcp-runtime`. A tool without a Scope or without the selected node is shown as `invalid` and not registered. An Endpoint tool replaces a Shared tool with the same name on its endpoint; two tools with the same name on one level are both shown as `duplicate` and neither is offered.

Editor-supplied environment variable names (`URL Env`, `Password Env`, `Secret Env`) must start with `MCP_`, so a flow editor cannot point a configuration at other process secrets such as `NODE_RED_CREDENTIAL_SECRET`.


The authorization server issuer is the Base URL origin. Authorization responses carry it as `iss`
(RFC 9207). Keep one `mcp-auth` configuration per runtime port: the root
`/.well-known/oauth-authorization-server` document answers only while a single configuration
serves the port.

Deploy with **Modified Nodes** or **Modified Flows**: endpoints are configuration nodes without
wires, so changing a tool flow never restarts its endpoint; a call that is inside a restarted node
is lost and times out. Wider restarts follow a change
to a shared configuration node (`mcp-runtime`, `mcp-auth`, `mcp-redis`: every endpoint that uses
it), a subflow (all its instances), tab environment variables (the whole tab) and global
environment variables (a full deploy). Stopping an endpoint fails its pending tool calls;
requests already being answered, such as `get_flow` or a token exchange, finish in the
background, and the port stays open while any endpoint on it is running.

Each endpoint runs at most 32 tool calls at once; further calls get JSON-RPC error `-32000`
until one finishes. Tool arguments are validated against the compiled Input Schema before the
flow runs; a tool whose Input or Output Schema fails to compile, or whose Tool Timeout exceeds
its endpoint's Tool Timeout, does not register.

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
| `mcp-flow-server` | Route and allowed groups |
| `mcp-tool-registry` | Description, input/output schemas, endpoint, behavior and world access |

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

Config-node details retain ordinary property types and values. Node-RED's flow API excludes declared credential values; an unexpected `credentials` container is replaced with `[REDACTED]` defensively. No credential API is called. Named secret keys (at any depth), user information in URLs and all `env` values are replaced with `[REDACTED]` and listed in `redactedProperties`. A property over 32 KiB is listed in `omittedProperties` instead of being returned; config properties are paginated by 40 fields and 64 KiB of values.

`get_flow` never requests the full `/flows` export. The tab index walks Node-RED's in-memory configuration once and caches only compact tab metadata until the next runtime deploy; it does not serialize or transfer full flows. `meta.cached` indicates whether the index was reused. The index excludes undeployed editor changes. Tab detail modes read `/flow/:id`; subflow modes read `/flow/global` and optionally the specified tab. These endpoints still make Node-RED prepare the selected flow before the palette applies its response limits. Responses cap lists at 40 items and edges at 80; Admin API reads have a 15-second timeout and a 32 MiB response limit. Tab indexing stops above 100,000 configuration nodes; graph inspection stops above 20,000 nodes or 100,000 wire visits. `meta` reports the source, scan count, returned node count and truncation.

The endpoint speaks MCP 2026-07-28 only: there is no `initialize` handshake and no session. Every
request carries `MCP-Protocol-Version`, `Mcp-Method` (and `Mcp-Name` for `tools/call`) matching its
body and `_meta`; a mismatch is `400` with `-32020`, any other revision is `400` with `-32022` and
the supported versions. Every request, `server/discover` included, needs a valid token; without
one the endpoint answers HTTP 401 with `WWW-Authenticate` pointing to the protected resource
metadata, which starts sign-in in MCP clients (MCP authorization spec). Closing the connection
cancels a running tool call. GET and DELETE answer 405. Tools advertise `securitySchemes` and the
matching `_meta.securitySchemes`.

All tool calls validate credentials before flow or admin execution. Missing, invalid or
expired tokens return HTTP 401 with `WWW-Authenticate`. Endpoint role and resource failures
remain HTTP 403. Unresolved required auth
configuration fails closed, and an invalid `mcp-auth` configuration is reported
in the log and stops its endpoints from starting. GET on an MCP path requires
authentication (HTTP 401 with `WWW-Authenticate`) and otherwise answers 405; the
legacy SSE stream was removed, so only JSON-RPC POST is served. If the provider
returns an error instead of a code, the callback redirects that error to the
client `redirect_uri` (RFC 6749 4.1.2.1). Storage failures on OAuth routes return
503 `temporarily_unavailable` and are logged; responses never include internal
error text. Client support for an in-chat OAuth linking UI must be
verified separately; emitting the challenge does not guarantee that UI.

The authorization endpoint requires PKCE S256, validates the client metadata host allow-list, checks the exact redirect URI against the client metadata document, delegates login to the configured OIDC issuer, validates the returned ID token through JWKS, and issues short-lived opaque MCP access tokens.

The RFC 8252 loopback exception permits a different port for a registered HTTP
callback on `127.0.0.1`, `[::1]` or `localhost` when CIMD declares `native` or omits
`application_type`. The host, path and query must remain identical; credentials,
fragments and invalid ports are rejected by this exception. Explicitly non-native
clients retain exact matching. The token endpoint always requires the exact URI,
including the port, used in the authorization request. This relaxation is a deliberate
deviation from exact matching: Claude Code publishes `http://localhost/callback` and
`http://127.0.0.1/callback` without `application_type` and listens on a random port.

PKCE `code_challenge` must be 43 base64url characters and `code_verifier` 43-128
RFC 7636 characters. The upstream `state` is bound to the browser that started sign-in
with an HttpOnly, SameSite=Lax cookie (`__Host-` prefixed on HTTPS); a callback without
that cookie is rejected. Request bodies are limited (JSON 256 KiB, form 16 KiB).
The package has no request rate limiter; apply one in the reverse proxy for
internet-facing deployments.

## Refresh Tokens

Refresh is enabled only when the selected provider's Refresh Key credential contains
a 32-byte key encoded as 64 hexadecimal characters. Each provider tab has its own
password field; generate a key with `openssl rand -hex 32`. Keep it stable across
restarts and out of packages/logs. Replacing it requires new
sign-ins for existing refresh sessions. Without it, discovery advertises only the
authorization-code grant. Clients requesting `offline_access` receive a separate
opaque MCP refresh token; the upstream provider credential stays encrypted on the
server with AES-256-GCM, bound to the auth configuration namespace.

Default and maximum lifetimes are 900 seconds for access, 604800 seconds of refresh
inactivity and 1814400 seconds from initial sign-in for the absolute session.
Shorter values can be configured for testing. Each successful refresh resets only
the inactivity window; neither rotation nor continuous use extends the absolute
deadline. Access issuance is capped to the remaining session lifetime.

The token endpoint accepts `grant_type=refresh_token`, `refresh_token`, `client_id`,
and optional `resource`/`scope`. Client, resource and endpoint remain bound; scope
can be narrowed but never increased. Refresh tokens are hashed in storage, rotated
atomically and checked for reuse. Reuse grace is fixed at 30 seconds and is not
configurable in the editor. Within grace, an identical retry receives the same
token pair without calling the provider again. The cached response is encrypted
with AES-256-GCM and bound to the namespace, session and previous token hash.
Its storage TTL is bounded by grace and the original access/session expiry;
returned `expires_in` decreases with the remaining access lifetime. Scope changes
cannot reuse a response issued for a different scope set.

Concurrent requests poll shared storage every 25 milliseconds for at most five
seconds. If the first request has not finished, the waiter receives HTTP 503
`temporarily_unavailable`; it does not revoke the session. Reuse outside grace,
client/resource/endpoint mismatches and definitive provider authorization or
identity/policy failures revoke the session and return `invalid_grant`.

Network errors, timeouts, provider 429/5xx and unavailable discovery/JWKS return
HTTP 503 `temporarily_unavailable`, with a validated upstream `Retry-After` when
present. The claim is restored using compare-and-set, without extending expiry.
A provider `invalid_client` or `unauthorized_client` response (for example an
expired client secret) is a configuration error, not a user failure: it also
returns 503, keeps the session and logs `provider_config` at error level.
Once a provider response has been verified, an encrypted pending result permits
retrying interrupted access storage or rotation without refreshing the provider
again. Claims have a 60-second ownership deadline so retries can recover after
an interrupted worker or a failed rollback; stale workers cannot commit rotation.
A permanently unavailable storage backend cannot guarantee claim recovery.
Microsoft permits reuse of its previous provider refresh credential after a lost
response; a generic OIDC provider that consumes it immediately may still require
sign-in after an ambiguous network failure.

Grace is a bounded replay-detection tradeoff: possession of the old bearer token
and its public client bindings can retrieve the cached pair during this window.
Grace is fixed at 30 seconds and is not configurable. Refresh outcomes are logged as
`success`, `transient`, `provider_config`, `unknown`, `revoked`, `replay` or `grace_reuse`
(see Audit Log), never with credential payloads.

Every new rotation contacts the selected provider. Microsoft requires a freshly signed
ID token with the expected issuer, audience, tenant, subject and current app roles.
For OIDC providers, current UserInfo groups are checked, and a returned ID token is
validated when present. No cached role/group fallback is used. Account and role
administration remain the identity administrator's responsibility.

Use the existing Redis-backed auth storage for persistence and protect its network
access, credentials and backups. Memory storage loses sessions on restart. Local
tests use synthetic providers and a Redis adapter double; real provider, Redis
restart and native client silent-refresh acceptance are separate rollout checks.
No callback or proxy route change is needed for the refresh grant.

## Audit Log

Security events are written to the Node-RED log as one JSON line each, through the node that
handled them. Lines never contain tokens, authorization codes, PKCE values or tool arguments;
sessions appear only as a 12-character hash.

| `event` | When | Main fields |
| --- | --- | --- |
| `oauth.sign_in` | callback completes or is refused | `outcome`, `reason`, `subject`, `client`, `endpoint` |
| `oauth.token` | authorization code exchange | `outcome`, `reason`, `subject`, `client`, `session` |
| `oauth.refresh` | refresh grant | `outcome`, `subject`, `client`, `session` |
| `mcp.auth` | rejected token or insufficient access (missing tokens are not logged) | `reason`, `subject`, `client`, `ip` |
| `mcp.tool_call` | every `tools/call` | `outcome`, `tool`, `subject`, `client`, `session`, `durationMs` |

The flow also receives the caller in `msg.mcp` (`subject`, `email`, `groups`, `client`) with
each tool call. Retention and forwarding of the Node-RED log belong to the
deployment.

## Kubernetes

The MCP listener runs inside the Node-RED pod on the `mcp-runtime` port, separate from the
editor port. Expose it through a Service port and route only the MCP and OAuth paths to it:

- each MCP endpoint path (POST);
- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/*`;
- `/.well-known/oauth-authorization-server` and `/.well-known/oauth-authorization-server/*`;
- `/oauth/*/authorize`, `/oauth/*/callback` (GET) and `/oauth/*/token` (POST).

| Setting | Value |
|---|---|
| **Bind Host** | The pod IP or `0.0.0.0`, not `127.0.0.1`: traffic from the Service arrives on the pod address |
| **Base URL** | The public origin that clients use |
| **Trusted Proxies** | CIDR ranges of the ingress, load balancer and mesh proxies, so the audit log and metrics record the real client address |
| **Allowed Origins** | Origins of browser-based MCP clients other than the Base URL origin, if any |
| `mcp-redis` | Redis mode. Memory mode keeps authorization state and opaque access tokens in process memory, so a second pod, a restarted pod or a rolling update loses sessions and tokens issued by another pod |
| Retries on `/oauth/*/token` | Off in the ingress and mesh, or only on connect failures: a retried authorization code or refresh token counts as reuse, and reuse revokes the session |
| Route timeout | Longer than **Tool Timeout** |

Probes and shutdown, with the example endpoint `/mcp/example` on port 8001:

```yaml
ports:
  - containerPort: 1880
  - containerPort: 8001
readinessProbe:
  httpGet:
    path: /.well-known/oauth-protected-resource/mcp/example
    port: 8001
livenessProbe:
  tcpSocket:
    port: 1880
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 30"]
terminationGracePeriodSeconds: 60
```

The readiness path returns 200 only while that endpoint runs with a valid auth configuration.
Do not probe the endpoint path itself: it answers 401 without a token, and an HTTP probe treats
only 200 to 399 as success. The `preStop` pause must be at least the endpoint **Tool Timeout**
(`toolTimeoutMs`, default 30000 ms) so that calls in flight finish before Node-RED closes the
endpoint; `terminationGracePeriodSeconds` must exceed the pause.

## Environment Variables

| Variable | Used by | Notes |
| --- | --- | --- |
| `MCP_REDIS_URL` (default name) | `mcp-redis` in env mode | Any `MCP_*` name can be configured. |
| `MCP_*` | `mcp-redis` Password Env, `mcp-auth` Secret Env | Names outside `MCP_` are rejected. |

## Rollback

Production pins the palette by commit. To roll back, pin the previous commit and redeploy,
then undo the configuration that the newer version required:

- 3.2 -> 3.1: no configuration change.
- 3.1 -> 3.0: no configuration change is required; Base URL, Groups and exact Client Hosts
  remain valid. Users sign in again.
- 3.0 -> 2.x: install `node-red-contrib-mcp-server` instead of `@olykov/node-red-mcp-server`,
  restore `REDIS_URL` in `mcp-redis`, re-select registry endpoints (2.x binds by node ID),
  and sign in again.

## Verification

Run before commit:

```bash
npm run lint
npm run coverage
npm pack --dry-run
npm audit --omit=dev
```

`npm run coverage` runs the tests and fails below 90% lines, 80% branches or 85% functions.
GitHub Actions (`.github/workflows/ci.yml`) runs the same checks on Node.js 22 and 24 for every
push to `main`, release tag and pull request.

Run source scans before publishing to confirm that sensitive material and environment-specific names are absent.

## Upstream Updates

Keep upstream as the base. Pull new upstream releases into a candidate branch, then reapply the documented local patch set and run the verification suite.

## License

MIT. See `LICENSE`.
