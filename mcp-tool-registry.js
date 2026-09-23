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

    function MCPToolRegistryNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;

        node.toolName = config.toolName || '';
        node.toolDescription = config.toolDescription || '';
        node.endpoint = normalizeEndpoint(config.endpoint);
        node.requiredScopes = parseList(config.requiredScopes || '');
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
            const toolDefinition = {
                name: node.toolName,
                description: node.toolDescription || `Tool: ${node.toolName}`,
                inputSchema: parsedSchema,
                ...(parsedOutputSchema ? { outputSchema: parsedOutputSchema } : {}),
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

            node.send({
                topic: 'tool-registered',
                payload: {
                    toolName: node.toolName,
                    description: node.toolDescription,
                    endpointId: binding.endpointId,
                    serverName: binding.serverName,
                    requiredScopes: node.requiredScopes,
                    schema: parsedSchema,
                    outputSchema: parsedOutputSchema
                }
            });
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

            node.send({ topic: 'tool-unregistered', payload: { toolName: node.toolName } });
        };

        node.updateRegistration = function ()
        {
            if (node.isRegistered)
            {
                node.unregisterTool();
                setTimeout(() => node.registerTool(), 100);
            }
        };

        node.on('input', function (msg)
        {
            const command = msg.topic || (msg.payload && msg.payload.command);

            switch (command)
            {
                case 'register':
                    node.registerTool();
                    break;

                case 'unregister':
                    node.unregisterTool();
                    break;

                case 'update':
                    {
                        const previousBinding = node.binding();
                        const previousToolName = node.toolName;

                        if (msg.payload.toolName) node.toolName = msg.payload.toolName;
                        if (msg.payload.toolDescription) node.toolDescription = msg.payload.toolDescription;
                        if (Object.prototype.hasOwnProperty.call(msg.payload, 'endpoint')) node.endpoint = normalizeEndpoint(msg.payload.endpoint);
                        if (Object.prototype.hasOwnProperty.call(msg.payload, 'requiredScopes')) node.requiredScopes = parseList(msg.payload.requiredScopes || '');
                        if (msg.payload.toolSchema)
                        {
                            try
                            {
                                parsedSchema = JSON.parse(msg.payload.toolSchema);
                                node.toolSchema = msg.payload.toolSchema;
                            } catch (error)
                            {
                                node.warn(`Invalid schema in update: ${error.message}`);
                            }
                        }
                        if (Object.prototype.hasOwnProperty.call(msg.payload, 'outputSchema'))
                        {
                            const nextOutputSchema = msg.payload.outputSchema || '';
                            if (!nextOutputSchema)
                            {
                                parsedOutputSchema = null;
                                node.outputSchema = '';
                            } else
                            {
                                try
                                {
                                    parsedOutputSchema = JSON.parse(nextOutputSchema);
                                    node.outputSchema = nextOutputSchema;
                                } catch (error)
                                {
                                    node.warn(`Invalid output schema in update: ${error.message}`);
                                }
                            }
                        }
                        if (node.isRegistered)
                        {
                            RED.events.emit('mcp-tool-unregister', { name: previousToolName, endpointId: previousBinding.endpointId, serverName: previousBinding.serverName });
                            node.isRegistered = false;
                            node.registerTool();
                        }
                    }
                    break;

                case 'status':
                    {
                        const binding = node.binding();
                        msg.payload = {
                            toolName: node.toolName,
                            isRegistered: node.isRegistered,
                            description: node.toolDescription,
                            endpointId: binding.endpointId,
                            serverName: binding.serverName,
                            requiredScopes: node.requiredScopes,
                            schema: parsedSchema,
                            outputSchema: parsedOutputSchema
                        };
                        node.send(msg);
                    }
                    break;

                default:
                    node.warn(`Unknown command: ${command}`);
            }
        });

        if (node.toolName) setTimeout(() => node.registerTool(), 500);

        node.on('close', function (done)
        {
            if (node.isRegistered) node.unregisterTool();
            done();
        });
    }

    RED.nodes.registerType('mcp-tool-registry', MCPToolRegistryNode);
};
