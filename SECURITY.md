# Security Policy

## Supported Versions

Security fixes are released for the latest published `4.x` release of
`@olykov/node-red-mcp-server`. Older releases do not receive patches.

| Version | Supported          |
| ------- | ------------------ |
| 4.x     | :white_check_mark: |
| < 4.0   | :x:                |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report suspected vulnerabilities privately through
[GitHub Private Vulnerability Reporting](https://github.com/olykov/node-red-contrib-mcp-server/security/advisories/new)
for this repository.

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, including a minimal flow/configuration if possible.
- The package version, Node.js version and Node-RED version affected.

## Response Process

- We aim to acknowledge reports within **5 business days**.
- We will keep you informed of remediation progress and coordinate a
  disclosure timeline with you.
- Fixes are published as new npm releases together with a `CHANGELOG.md`
  entry; credit is given to reporters who wish to be acknowledged.

## Scope

This policy covers the Node-RED nodes, admin API, and MCP protocol handling
shipped in this package. Vulnerabilities in upstream dependencies (for
example `express`, `ajv`, `ioredis`, `jose`) should also be reported to their
respective maintainers; we will update this package's dependency pins once
fixes are available.
