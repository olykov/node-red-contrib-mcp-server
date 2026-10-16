'use strict';

const { message } = require('./lib/messages');

module.exports = function (RED)
{
    function MCPServerMetricsNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;
        const runtime = RED.nodes.getNode(config.runtime);

        if (!runtime || typeof runtime.subscribeToolTelemetry !== 'function')
        {
            node.status({ fill: 'red', shape: 'ring', text: message(node, 'nr-mcp-metrics', 'nr-mcp-metrics.status.runtimeUnavailable') });
            node.error('MCP runtime is required for metrics');
            return;
        }

        const unsubscribe = runtime.subscribeToolTelemetry(function (event)
        {
            node.send({ topic: 'mcp-tool-telemetry', payload: event });
        });

        if (!unsubscribe)
        {
            node.status({ fill: 'red', shape: 'ring', text: message(node, 'nr-mcp-metrics', 'nr-mcp-metrics.status.duplicate') });
            node.error('Only one MCP Server Metrics node is allowed per runtime');
            return;
        }

        node.status({ fill: 'green', shape: 'dot', text: message(node, 'nr-mcp-metrics', 'nr-mcp-metrics.status.listening') });
        node.on('close', unsubscribe);
    }

    RED.nodes.registerType('nr-mcp-metrics', MCPServerMetricsNode);
};
