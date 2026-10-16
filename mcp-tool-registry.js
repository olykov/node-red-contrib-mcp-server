module.exports = function (RED)
{
    "use strict";
    const { compileInputSchema, compileOutputSchema } = require('./lib/tool-validation');
    const { message } = require('./lib/messages');
    const executions = require('./lib/executions');
    const statusText = (node, key) => message(node, 'mcp-tool-registry', 'mcp-tool-registry.status.' + key);

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
        node.toolSchema = config.toolSchema || '{"type":"object"}';
        node.outputSchema = config.outputSchema || '';
        node.timeoutMs = config.timeoutMs === undefined || config.timeoutMs === '' ? 0 : Number(config.timeoutMs);
        node.cancelOutput = config.cancelOutput === true;
        node.isRegistered = false;
        node.hasDuplicate = false;

        node.status({ fill: 'grey', shape: 'ring', text: statusText(node, 'unregistered') });

        let parsedSchema;
        let parsedOutputSchema = null;
        let validateArguments;
        try
        {
            if (!node.endpoint && config.endpoint !== '__shared__')
                throw new Error('MCP endpoint is required: select an endpoint or Shared');
            if (!/^[a-z][a-z0-9_]{0,63}$/.test(node.toolName))
                throw new Error('Tool name must start with a lowercase letter and contain at most 64 lowercase letters, digits or underscores');
            if (node.timeoutMs && (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1000 || node.timeoutMs > 600000))
                throw new Error('Tool timeout must be between 1000 and 600000 milliseconds');
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

        node.binding = function ()
        {
            if (node.endpoint)
            {
                return { endpointPath: node.endpoint, serverName: endpointName(RED, node.endpoint) || node.endpoint };
            }
            return { endpointPath: '', serverName: '' };
        };

        node.runtimes = function (binding)
        {
            const ids = new Set();
            if (RED.nodes && typeof RED.nodes.eachNode === 'function')
            {
                RED.nodes.eachNode(candidate =>
                {
                    if (binding.endpointPath)
                    {
                        if (candidate.type === 'mcp-flow-server' && candidate.runtime &&
                            normalizePath(candidate.serverPath || '/mcp') === binding.endpointPath) ids.add(candidate.runtime);
                    } else if (candidate.type === 'mcp-runtime') ids.add(candidate.id);
                });
            }
            return Array.from(ids).map(id => RED.nodes.getNode(id)).filter(runtime => runtime && typeof runtime.registerTool === 'function');
        };

        node.registerTool = function ()
        {
            if (node.validationError) return;
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
            if (node.timeoutMs && binding.endpointPath && RED.nodes && typeof RED.nodes.eachNode === 'function')
            {
                let endpointTimeout;
                RED.nodes.eachNode(candidate =>
                {
                    if (candidate.type === 'mcp-flow-server' &&
                        normalizePath(candidate.serverPath || '/mcp') === binding.endpointPath)
                        endpointTimeout = Number(candidate.toolTimeoutMs) || 30000;
                });
                if (endpointTimeout && node.timeoutMs > endpointTimeout)
                {
                    node.validationError = new Error('Tool timeout cannot exceed its MCP endpoint timeout');
                    node.status({ fill: 'red', shape: 'dot', text: statusText(node, 'invalid') });
                    node.warn(node.validationError.message);
                    return;
                }
            }
            const annotations = toolAnnotations(node.toolBehavior, node.worldAccess);
            const toolDefinition = {
                name: node.toolName,
                description: node.toolDescription || `Tool: ${node.toolName}`,
                inputSchema: parsedSchema,
                validateArguments,
                timeoutMs: node.timeoutMs || undefined,
                ...(parsedOutputSchema ? { outputSchema: parsedOutputSchema } : {}),
                ...(annotations ? { annotations } : {}),
                endpointPath: binding.endpointPath,
                serverName: binding.serverName,
                registeredBy: node.id,
                deliver: msg => node.send(msg),
                cancel(mcp)
                {
                    if (node.cancelOutput) node.send([null, { mcp }]);
                },
                setStatus(duplicate)
                {
                    if (node.hasDuplicate === duplicate) return;
                    node.hasDuplicate = duplicate;
                    if (duplicate)
                    {
                        node.status({ fill: 'red', shape: 'dot', text: statusText(node, 'duplicate') });
                    } else
                    {
                        node.status({ fill: 'green', shape: 'dot', text: statusText(node, binding.endpointPath ? 'registered' : 'shared') });
                    }
                },
                registrationTime: new Date()
            };

            node.status({ fill: 'green', shape: 'dot', text: statusText(node, binding.endpointPath ? 'registered' : 'shared') });
            node.registeredRuntimes = node.runtimes(binding);
            node.registeredRuntimes.forEach(runtime => runtime.registerTool(toolDefinition));

            node.isRegistered = true;
            node.debug(`Tool "${node.toolName}" registered`);
        };

        node.unregisterTool = function ()
        {
            if (!node.isRegistered)
            {
                node.warn('Tool is not currently registered');
                return;
            }

            (node.registeredRuntimes || []).forEach(runtime => runtime.unregisterTool(node.id));
            node.registeredRuntimes = [];

            node.isRegistered = false;
            node.hasDuplicate = false;
            node.status({ fill: 'grey', shape: 'ring', text: statusText(node, 'unregistered') });
            node.debug(`Tool "${node.toolName}" unregistered`);
        };

        if (node.toolName && !node.validationError) node.registerTool();

        node.on('close', function (done)
        {
            if (node.isRegistered) node.unregisterTool();
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

    RED.nodes.registerType('mcp-tool-registry', MCPToolRegistryNode);
    RED.nodes.registerType('mcp-tool-response', MCPToolResponseNode);
};
