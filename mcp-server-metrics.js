'use strict';

module.exports = function (RED)
{
    function MCPServerMetricsNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;
        const runtime = RED.nodes.getNode(config.runtime);

        if (!runtime || typeof runtime.subscribeAdminTelemetry !== 'function')
        {
            node.status({ fill: 'red', shape: 'ring', text: 'runtime unavailable' });
            node.error('MCP runtime is required for metrics');
            return;
        }

        const unsubscribe = runtime.subscribeAdminTelemetry(function (event)
        {
            node.send({ topic: 'mcp-admin-telemetry', payload: event });
        });

        if (!unsubscribe)
        {
            node.status({ fill: 'red', shape: 'ring', text: 'duplicate metrics node' });
            node.error('Only one MCP Server Metrics node is allowed per runtime');
            return;
        }

        node.status({ fill: 'green', shape: 'dot', text: 'listening' });
        node.on('close', unsubscribe);
    }

    RED.nodes.registerType('mcp-server-metrics', MCPServerMetricsNode);
};
