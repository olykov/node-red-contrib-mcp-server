# Security Policy

## Supported Versions

Security fixes are released for the latest published `3.x` release of
`@olykov/node-red-mcp-server`. Older releases do not receive patches; please
upgrade to the latest version before reporting an issue.

| Version | Supported          |
| ------- | ------------------ |
| 3.x     | :white_check_mark: |
| < 3.0   | :x:                |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report suspected vulnerabilities privately using one of the
following channels:

- [GitHub Security Advisories](https://github.com/olykov/node-red-contrib-mcp-server/security/advisories/new)
  for this repository (preferred).
- Open a [private security issue](https://github.com/olykov/node-red-contrib-mcp-server/issues/new)
  only if the advisory form above is unavailable, and mark it clearly as
  security-sensitive so maintainers can restrict visibility.

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
