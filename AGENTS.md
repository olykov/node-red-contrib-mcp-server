# Repository Instructions

This is an upstream-first product fork of `node-red-contrib-mcp-server`.

## Boundaries

- Do not push without separate explicit approval in the current conversation.
- Do not deploy from this repository; deployment is handled from the infra repository.
- Do not commit secrets, `.env`, tokens, sensitive credentials, or screenshots containing secrets.
- Keep application configuration in environment variables.
- Keep supported upstream node types as the base whenever pulling upstream changes.

## Upstream-First Direction

The package is based on upstream `node-red-contrib-mcp-server` and keeps supported upstream nodes:

- `mcp-server`
- `mcp-client`
- `mcp-flow-server`
- `mcp-tool-registry`

Do not restore the removed `mcp-tool` client node or direct JSON-RPC tool methods. Tools are called through `tools/call`.

Do not reintroduce removed local compatibility nodes unless explicitly requested. Existing flows should migrate to upstream `mcp-flow-server` and `mcp-tool-registry`.

## OAuth Boundary

Node-RED is the MCP tool runtime, not the public OAuth authorization server. Do not add a dynamic client registration shim or client-registration endpoint here. Public OAuth/CIMD/PKCE belongs in the gateway layer in front of Node-RED.

## Verification

Run before presenting work as ready:

```bash
npm test
npm pack --dry-run
```

Also run a source search for removed authorization-server shim route names. It should be empty.
