# Changelog

## Unreleased

- Removed the unused `mcp-tool` node and direct JSON-RPC tool method compatibility.
- Expanded runtime metrics to cover all MCP tool calls across endpoints, including failed calls.
- Added generic OIDC auth and auth-storage config nodes for MCP endpoints.
- Added OAuth protected-resource and authorization-server metadata responses.
- Added bearer-token enforcement for protected MCP endpoints.
- Added endpoint and tool scope/group policy checks.
- Added authorization-code exchange with PKCE S256, OIDC ID token validation, and opaque MCP access tokens.
- Added tests for OAuth challenges, token exchange, authorized initialization, tool filtering, and forbidden tool calls.

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
