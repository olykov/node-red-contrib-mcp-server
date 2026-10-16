module.exports = function (RED)
{
    "use strict";
    const { compileInputSchema, compileOutputSchema } = require('./lib/tool-validation');
    const { message } = require('./lib/messages');
    const executions = require('./lib/executions');
    const statusText = (node, key) => message(node, 'nr-mcp-tool', 'nr-mcp-tool.status.' + key);

    function toolAnnotations(behavior, worldAccess)
    {
        const annotations = {};
        if (behavior === 'read')
        {
            annotations.readOnlyHint = true;
            annotations.destructiveHint = false;
        }
        else if (behavior === 'write' || behavior === 'destructive')
        {
            annotations.readOnlyHint = false;
            annotations.destructiveHint = behavior === 'destructive';
        }
        if (worldAccess === 'closed' || worldAccess === 'open')
        {
            annotations.openWorldHint = worldAccess === 'open';
        }
        return Object.keys(annotations).length ? annotations : null;
    }

    function MCPToolRegistryNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;

        node.toolName = config.toolName || '';
        node.toolDescription = config.toolDescription || '';
        node.scope = config.scope;
        node.toolBehavior = config.toolBehavior || '';
        node.worldAccess = config.worldAccess || '';
        node.toolSchema = config.toolSchema || '{"type":"object"}';
        node.outputSchema = config.outputSchema || '';
        node.timeoutMs = config.timeoutMs === undefined || config.timeoutMs === '' ? 0 : Number(config.timeoutMs);
        node.cancelOutput = config.cancelOutput === true;
        node.isRegistered = false;
        node.toolState = '';

        node.status({ fill: 'grey', shape: 'ring', text: statusText(node, 'unregistered') });

        let parsedSchema;
        let parsedOutputSchema = null;
        let validateArguments;
        let endpoint = null;
        let runtime = null;
        try
        {
            if (node.scope === 'endpoint')
            {
                endpoint = RED.nodes.getNode(config.endpoint);
                if (!endpoint) throw new Error('MCP endpoint is required for an Endpoint tool');
                runtime = endpoint.runtime;
                if (!runtime) throw new Error('MCP endpoint has no runtime');
            } else if (node.scope === 'shared')
            {
                runtime = RED.nodes.getNode(config.runtime);
                if (!runtime) throw new Error('MCP runtime is required for a Shared tool');
            } else throw new Error('Scope is required: Endpoint or Shared');
            if (!/^[a-z][a-z0-9_]{0,63}$/.test(node.toolName))
                throw new Error('Tool name must start with a lowercase letter and contain at most 64 lowercase letters, digits or underscores');
            if (node.timeoutMs && (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1000 || node.timeoutMs > 600000))
                throw new Error('Tool timeout must be between 1000 and 600000 milliseconds');
            if (node.timeoutMs && endpoint && node.timeoutMs > endpoint.toolTimeoutMs)
                throw new Error('Tool timeout cannot exceed its MCP endpoint timeout');
            const input = compileInputSchema(node.toolSchema);
            parsedSchema = input.schema;
            validateArguments = input.validateArguments;
            parsedOutputSchema = compileOutputSchema(node.outputSchema);
        } catch (error)
        {
            node.validationError = error;
            node.status({ fill: 'red', shape: 'dot', text: statusText(node, 'invalid') });
            node.warn(error.message);
        }

        node.setStatus = function (state)
        {
            if (node.toolState === state) return;
            node.toolState = state;
            if (state === 'duplicate') node.status({ fill: 'red', shape: 'dot', text: statusText(node, 'duplicate') });
            else if (state === 'error') node.status({ fill: 'red', shape: 'ring', text: statusText(node, 'endpointError') });
            else node.status({ fill: 'green', shape: 'dot', text: statusText(node, endpoint ? 'registered' : 'shared') });
        };

        node.registerTool = function ()
        {
            if (node.validationError || node.isRegistered) return;
            const annotations = toolAnnotations(node.toolBehavior, node.worldAccess);
            runtime.registerTool({
                name: node.toolName,
                description: node.toolDescription || `Tool: ${node.toolName}`,
                inputSchema: parsedSchema,
                validateArguments,
                timeoutMs: node.timeoutMs || undefined,
                ...(parsedOutputSchema ? { outputSchema: parsedOutputSchema } : {}),
                ...(annotations ? { annotations } : {}),
                endpointId: endpoint ? endpoint.id : '',
                registeredBy: node.id,
                deliver: msg => node.send(msg),
                cancel(mcp)
                {
                    if (node.cancelOutput) node.send([null, { mcp }]);
                },
                setStatus: node.setStatus
            });
            node.isRegistered = true;
            if (!node.toolState) node.setStatus('ok');
            node.debug(`Tool "${node.toolName}" registered`);
        };

        if (!node.validationError) node.registerTool();

        node.on('close', function (done)
        {
            if (node.isRegistered) runtime.unregisterTool(node.id);
            node.isRegistered = false;
            done();
        });
    }

    function MCPToolResponseNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;

        node.on('input', function (msg, send, done)
        {
            const executionId = msg.mcp && msg.mcp.executionId;
            if (!executionId) return done(new Error('msg.mcp.executionId is required'));
            const pending = executions.take(executionId);
            if (!pending)
            {
                if (executions.isRetired(executionId))
                {
                    node.debug('Ignoring late MCP tool response for executionId: ' + executionId);
                    return done();
                }
                return done(new Error('Unknown MCP executionId: ' + executionId));
            }
            clearTimeout(pending.timeout);
            if (msg.mcp.error) pending.reject(new Error(executions.errorText(msg.mcp.error)));
            else pending.resolve(msg.payload);
            done();
        });
    }

    RED.nodes.registerType('nr-mcp-tool', MCPToolRegistryNode);
    RED.nodes.registerType('nr-mcp-tool-response', MCPToolResponseNode);
};
