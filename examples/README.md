# Examples

`flow-based-mcp-server-example.json` is shipped with the package and appears in
Node-RED under Import > Examples. It defines one MCP endpoint with one tool
(`add_numbers`): the MCP Tool node starts the flow and MCP Tool Response
returns its result.

Before deploying it, set the identity provider in the **MCP example auth**
configuration and register the callback URL with the provider. The example uses
in-memory auth storage, so every restart signs users out; use Redis for real use.
