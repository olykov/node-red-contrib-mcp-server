module.exports = function (RED)
{
    "use strict";

    function parseList(value)
    {
        if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
        if (typeof value !== 'string') return [];
        return value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    }

    function normalizeEndpoint(value)
    {
        return value === '__shared__' ? '' : (value || '');
    }

    function endpointName(RED, endpointId)
    {
        const getNode = RED.nodes && typeof RED.nodes.getNode === 'function' ? RED.nodes.getNode.bind(RED.nodes) : null;
        const endpoint = endpointId && getNode ? getNode(endpointId) : null;
        return endpoint ? endpoint.serverName : '';
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
        node.requiredScopes = parseList(config.requiredScopes || '');
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
                return { endpointId: node.endpoint, serverName: endpointName(RED, node.endpoint) || '' };
            }
            return { endpointId: '', serverName: '' };
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
                endpointId: binding.endpointId,
                serverName: binding.serverName,
                requiredScopes: node.requiredScopes,
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
            RED.events.emit('mcp-tool-unregister', { name: node.toolName, endpointId: binding.endpointId, serverName: binding.serverName });

            node.isRegistered = false;
            node.status({ fill: 'grey', shape: 'ring', text: 'unregistered' });
            node.log(`Tool "${node.toolName}" unregistered`);
        };

        if (node.toolName) setTimeout(() => node.registerTool(), 500);

        node.on('close', function (done)
        {
            if (node.isRegistered) node.unregisterTool();
            done();
        });
    }

    RED.nodes.registerType('mcp-tool-registry', MCPToolRegistryNode);
};
