module.exports = function (RED)
{
    "use strict";

    function normalizePath(value)
    {
        const raw = typeof value === 'string' ? value.trim() : '';
        if (!raw) return '';
        return raw.startsWith('/') ? raw : '/' + raw;
    }

    // Endpoint binding is the MCP path of an mcp-flow-server; '__shared__' exposes the tool everywhere.
    function normalizeEndpoint(value)
    {
        return value === '__shared__' ? '' : normalizePath(value);
    }

    function endpointName(RED, endpointPath)
    {
        let name = '';
        if (endpointPath && RED.nodes && typeof RED.nodes.eachNode === 'function')
        {
            RED.nodes.eachNode(candidate =>
            {
                if (!name && candidate.type === 'mcp-flow-server' && normalizePath(candidate.serverPath || '/mcp') === endpointPath)
                    name = candidate.serverName || candidate.name || endpointPath;
            });
        }
        return name;
    }

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
        node.endpoint = normalizeEndpoint(config.endpoint);
        node.toolBehavior = config.toolBehavior || '';
        node.worldAccess = config.worldAccess || '';
        node.toolSchema = config.toolSchema || '{}';
        node.outputSchema = config.outputSchema || '';
        node.isRegistered = false;

        node.status({ fill: 'grey', shape: 'ring', text: 'unregistered' });

        let parsedSchema = {};
        try
        {
            parsedSchema = JSON.parse(node.toolSchema);
        } catch (error)
        {
            node.warn(`Invalid tool schema JSON: ${error.message}`);
            parsedSchema = { type: 'object', properties: {}, required: [] };
        }

        let parsedOutputSchema = null;
        if (node.outputSchema)
        {
            try
            {
                parsedOutputSchema = JSON.parse(node.outputSchema);
            } catch (error)
            {
                node.warn(`Invalid output schema JSON: ${error.message}`);
                parsedOutputSchema = null;
            }
        }

        node.binding = function ()
        {
            if (node.endpoint)
            {
                return { endpointPath: node.endpoint, serverName: endpointName(RED, node.endpoint) || node.endpoint };
            }
            return { endpointPath: '', serverName: '' };
        };

        node.registerTool = function ()
        {
            if (!node.toolName)
            {
                node.warn('Tool name is required for registration');
                return;
            }

            if (node.isRegistered)
            {
                node.warn('Tool is already registered');
                return;
            }

            const binding = node.binding();
            const annotations = toolAnnotations(node.toolBehavior, node.worldAccess);
            const toolDefinition = {
                name: node.toolName,
                description: node.toolDescription || `Tool: ${node.toolName}`,
                inputSchema: parsedSchema,
                ...(parsedOutputSchema ? { outputSchema: parsedOutputSchema } : {}),
                ...(annotations ? { annotations } : {}),
                endpointPath: binding.endpointPath,
                serverName: binding.serverName,
                registeredBy: node.id,
                registrationTime: new Date()
            };

            RED.events.emit('mcp-tool-register', toolDefinition);

            node.isRegistered = true;
            node.status({ fill: 'green', shape: 'dot', text: binding.serverName ? `registered: ${binding.serverName}` : 'registered: all' });
            node.log(`Tool "${node.toolName}" registered successfully`);
        };

        node.unregisterTool = function ()
        {
            if (!node.isRegistered)
            {
                node.warn('Tool is not currently registered');
                return;
            }

            const binding = node.binding();
            RED.events.emit('mcp-tool-unregister', { name: node.toolName, endpointPath: binding.endpointPath, serverName: binding.serverName });

            node.isRegistered = false;
            node.status({ fill: 'grey', shape: 'ring', text: 'unregistered' });
            node.log(`Tool "${node.toolName}" unregistered`);
        };

        let closed = false;
        const registerTimer = node.toolName ? setTimeout(() =>
        {
            if (!closed) node.registerTool();
        }, 500) : null;

        node.on('close', function (done)
        {
            closed = true;
            clearTimeout(registerTimer);
            if (node.isRegistered) node.unregisterTool();
            done();
        });
    }

    RED.nodes.registerType('mcp-tool-registry', MCPToolRegistryNode);
};
