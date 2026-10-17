# Review marks

Requirements from `docs/spec.md` verified by reading code, documentation or repository files
instead of an automated test. `scripts/check-req-ids.js` requires every `review` requirement
to appear here. Status is one of `done`, `open` or `superseded`; an `open` entry names what is still
missing, a `superseded` entry names the decision that replaced the requirement.

| ID | Status | Evidence |
| --- | --- | --- |
| MCP-ADM-2 | done | `locales/en-US/nr-mcp-endpoint.html` ("Allow Function Code") and `README.md` "Configuration Notes" state that Function code goes to the MCP client and its language model and that secrets in it are not redacted. |
| MCP-DOC-1 | done | `locales/en-US/nr-mcp-endpoint.html` "Details": every request including `server/discover` needs OAuth, Tool Timeout and Max Concurrent Calls are described, notifications return 202. No statement contradicts `README.md`. |
| MCP-DOC-3 | superseded | Owner decision (2026-10-17): no installation below 4.0 exists, so README keeps no 3.x upgrade or rollback notes. `includeCode`, Bind Host and Allowed Origins are described in the current README sections and runtime help. |
| MCP-PKG-3 | done | `SECURITY.md` points to GitHub Private Vulnerability Reporting (security advisories) and lists 4.x as the supported version. |
| MCP-PKG-4 | done | Editor labels and help live in `locales/en-US/*.json|html`; node status texts are resolved through `lib/messages.js` from the same catalogs (`status` sections). Covered by `test/cidr.test.js` "message catalogs". |
| MCP-PKG-5 | done | `README.md` "Kubernetes" covers Bind Host, Trusted Proxies, Allowed Origins, a `preStop` sleep of at least Tool Timeout, readiness/liveness probes and the Redis requirement for several pods. Field names match the editor. |
| MCP-PKG-6 | open | Submit to the Flow Library after the first publish through `release.yml`; the `node-red` keyword is already in `package.json`. This cannot be done before publication. |
| MCP-PROTO-1 | superseded | 4.0 targets MCP 2026-07-28 only: no `initialize` negotiation and no 2025-06-18 or 2025-11-25 support; `server/discover` reports `supportedVersions: ["2026-07-28"]`. |
| MCP-PROTO-2 | superseded | 2026-07-28 requires `MCP-Protocol-Version` on every request; a missing header is no longer accepted. Unsupported versions still get 400, now with `-32022` and the supported versions. |
| MCP-PROTO-7 | superseded | 2026-07-28 Streamable HTTP has no client `notifications/cancelled`; closing the connection cancels the call and frees its concurrency slot. |
| MCP-LIFE-1 | superseded | 4.0 removes the `start`, `stop` and `restart` commands (MCP-NODE-3); the endpoint is a config node without input, so there is no deferred `restart` to finish. |
| MCP-MIG-2 | done | `README.md` "Upgrading to 4.0" gives the `nr-mcp-migrate` steps and a table of manual replacements. The rollback part is dropped by owner decision (2026-10-17): no installation below 4.0 exists. |
