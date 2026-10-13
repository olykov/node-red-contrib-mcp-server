module.exports = function (RED)
{
    "use strict";

    const { spawn, exec } = require('child_process');
    const { randomUUID: uuidv4 } = require('crypto');
    const NodeCache = require('node-cache');
    const axios = require('axios');
    const EventSource = require('eventsource');

    // Cache to store running MCP server instances
    const serverCache = new NodeCache({ stdTTL: 0 }); // No TTL - manual cleanup

    function MCPServerNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;

        // Configuration
        node.serverName = config.serverName || "mcp-server";
        node.serverType = config.serverType || "python";
        node.serverPath = config.serverPath || "";
        node.serverArgs = config.serverArgs || "";
        node.serverPort = config.serverPort || 8000;
        node.autoStart = config.autoStart || false;
        node.healthCheck = config.healthCheck || true;
        node.healthCheckInterval = config.healthCheckInterval || 30000;
        node.maxRestarts = config.maxRestarts || 3;
        node.restartDelay = config.restartDelay || 5000;

        // Runtime state
        node.serverProcess = null;
        node.serverId = uuidv4();
        node.isRunning = false;
        node.restartCount = 0;
        node.healthCheckTimer = null;
        node.lastHealthCheck = null;

        // Set initial status
        node.status({ fill: "grey", shape: "ring", text: "stopped" });

        // Start server function
        node.startServer = function (callback = () => { })
        {
            if (node.isRunning)
            {
                node.warn("MCP server is already running");
                callback(null, { success: false, message: "Server already running" });
                return;
            }

            node.status({ fill: "yellow", shape: "ring", text: "starting..." });

            let command, args;

            if (node.serverType === "python")
            {
                // Handle Python MCP servers
                if (!node.serverPath)
                {
                    const error = new Error("Server path is required for Python MCP servers");
                    node.error(error);
                    node.status({ fill: "red", shape: "dot", text: "error: no path" });
                    callback(error);
                    return;
                }

                command = "python3";
                args = [node.serverPath];

                // Add additional arguments if provided
                if (node.serverArgs)
                {
                    const additionalArgs = node.serverArgs.split(/\s+/).filter(arg => arg.length > 0);
                    args = args.concat(additionalArgs);
                }
            } else if (node.serverType === "node")
            {
                // Handle Node.js MCP servers
                command = "node";
                args = [node.serverPath];

                if (node.serverArgs)
                {
                    const additionalArgs = node.serverArgs.split(/\s+/).filter(arg => arg.length > 0);
                    args = args.concat(additionalArgs);
                }
            } else
            {
                // Handle custom commands
                const commandParts = node.serverPath.split(/\s+/);
                command = commandParts[0];
                args = commandParts.slice(1);

                if (node.serverArgs)
                {
                    const additionalArgs = node.serverArgs.split(/\s+/).filter(arg => arg.length > 0);
                    args = args.concat(additionalArgs);
                }
            }

            try
            {
                // Set environment variables
                const env = {
                    ...process.env,
                    MCP_SERVER_PORT: node.serverPort.toString(),
                    MCP_SERVER_NAME: node.serverName,
                    NODE_RED_MCP_SERVER_ID: node.serverId
                };

                node.serverProcess = spawn(command, args, {
                    env: env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    cwd: process.cwd()
                });

                node.serverProcess.stdout.on('data', (data) =>
                {
                    const output = data.toString().trim();
                    node.log(`[${node.serverName}] STDOUT: ${output}`);

                    // Send output as message
                    node.send({
                        topic: "stdout",
                        payload: output,
                        serverId: node.serverId,
                        serverName: node.serverName
                    });

                    // Check for startup indicators
                    if (output.includes('Server started') || output.includes('listening') || output.includes('FastMCP server'))
                    {
                        node.onServerStarted();
                    }
                });

                node.serverProcess.stderr.on('data', (data) =>
                {
                    const error = data.toString().trim();
                    node.warn(`[${node.serverName}] STDERR: ${error}`);

                    // Send error as message
                    node.send({
                        topic: "stderr",
                        payload: error,
                        serverId: node.serverId,
                        serverName: node.serverName
                    });
                });

                node.serverProcess.on('error', (error) =>
                {
                    node.error(`Failed to start MCP server: ${error.message}`);
                    node.status({ fill: "red", shape: "dot", text: "start error" });
                    node.isRunning = false;
                    callback(error);
                });

                node.serverProcess.on('exit', (code, signal) =>
                {
                    node.log(`MCP server exited with code ${code}, signal ${signal}`);
                    node.isRunning = false;
                    node.serverProcess = null;

                    if (code !== 0 && node.restartCount < node.maxRestarts)
                    {
                        node.status({ fill: "yellow", shape: "ring", text: "restarting..." });
                        node.restartCount++;

                        setTimeout(() =>
                        {
                            node.log(`Attempting restart ${node.restartCount}/${node.maxRestarts}`);
                            node.startServer();
                        }, node.restartDelay);
                    } else
                    {
                        node.status({ fill: "red", shape: "dot", text: "stopped" });
                        node.stopHealthCheck();

                        // Send exit message
                        node.send({
                            topic: "exit",
                            payload: { code: code, signal: signal },
                            serverId: node.serverId,
                            serverName: node.serverName
                        });
                    }
                });

                // Store in cache
                serverCache.set(node.serverId, {
                    node: node,
                    process: node.serverProcess,
                    startTime: new Date(),
                    port: node.serverPort
                });

                callback(null, { success: true, message: "Server starting", serverId: node.serverId });

            } catch (error)
            {
                node.error(`Error starting MCP server: ${error.message}`);
                node.status({ fill: "red", shape: "dot", text: "error" });
                callback(error);
            }
        };

        // Called when server has started successfully
        node.onServerStarted = function ()
        {
            node.isRunning = true;
            node.restartCount = 0;
            node.status({ fill: "green", shape: "dot", text: "running" });

            // Start health checks if enabled
            if (node.healthCheck)
            {
                node.startHealthCheck();
            }

            // Send started message
            node.send({
                topic: "started",
                payload: {
                    serverId: node.serverId,
                    serverName: node.serverName,
                    port: node.serverPort,
                    startTime: new Date()
                }
            });
        };

        // Stop server function
        node.stopServer = function (callback = () => { })
        {
            if (!node.isRunning || !node.serverProcess)
            {
                node.status({ fill: "grey", shape: "ring", text: "stopped" });
                callback(null, { success: true, message: "Server already stopped" });
                return;
            }

            node.status({ fill: "yellow", shape: "ring", text: "stopping..." });
            node.stopHealthCheck();

            try
            {
                // Graceful shutdown first
                node.serverProcess.kill('SIGTERM');

                // Force kill after timeout
                setTimeout(() =>
                {
                    if (node.serverProcess && !node.serverProcess.killed)
                    {
                        node.serverProcess.kill('SIGKILL');
                    }
                }, 5000);

                node.isRunning = false;
                serverCache.del(node.serverId);

                callback(null, { success: true, message: "Server stopping" });

            } catch (error)
            {
                node.error(`Error stopping MCP server: ${error.message}`);
                callback(error);
            }
        };

        // Health check function
        node.startHealthCheck = function ()
        {
            if (node.healthCheckTimer)
            {
                clearInterval(node.healthCheckTimer);
            }

            node.healthCheckTimer = setInterval(async () =>
            {
                try
                {
                    const response = await axios.get(`http://localhost:${node.serverPort}/health`, {
                        timeout: 5000
                    });

                    node.lastHealthCheck = new Date();

                    if (response.status === 200)
                    {
                        if (node.status().text !== "running")
                        {
                            node.status({ fill: "green", shape: "dot", text: "running" });
                        }
                    }
                } catch (error)
                {
                    node.warn(`Health check failed: ${error.message}`);
                    if (node.isRunning)
                    {
                        node.status({ fill: "yellow", shape: "ring", text: "unhealthy" });
                    }
                }
            }, node.healthCheckInterval);
        };

        node.stopHealthCheck = function ()
        {
            if (node.healthCheckTimer)
            {
                clearInterval(node.healthCheckTimer);
                node.healthCheckTimer = null;
            }
        };

        // Handle input messages
        node.on('input', function (msg)
        {
            const command = msg.topic || msg.payload.command;

            switch (command)
            {
                case 'start':
                    node.startServer((error, result) =>
                    {
                        if (!error)
                        {
                            msg.payload = result;
                            node.send(msg);
                        }
                    });
                    break;

                case 'stop':
                    node.stopServer((error, result) =>
                    {
                        if (!error)
                        {
                            msg.payload = result;
                            node.send(msg);
                        }
                    });
                    break;

                case 'restart':
                    node.stopServer(() =>
                    {
                        setTimeout(() =>
                        {
                            node.startServer((error, result) =>
                            {
                                if (!error)
                                {
                                    msg.payload = result;
                                    node.send(msg);
                                }
                            });
                        }, 2000);
                    });
                    break;

                case 'status':
                    msg.payload = {
                        serverId: node.serverId,
                        serverName: node.serverName,
                        isRunning: node.isRunning,
                        port: node.serverPort,
                        lastHealthCheck: node.lastHealthCheck,
                        restartCount: node.restartCount
                    };
                    node.send(msg);
                    break;

                default:
                    node.warn(`Unknown command: ${command}`);
            }
        });

        // Auto-start if configured
        if (node.autoStart)
        {
            setTimeout(() =>
            {
                node.startServer();
            }, 1000);
        }

        // Cleanup on node close
        node.on('close', function (done)
        {
            node.stopHealthCheck();

            if (node.isRunning && node.serverProcess)
            {
                node.stopServer(() =>
                {
                    serverCache.del(node.serverId);
                    done();
                });
            } else
            {
                serverCache.del(node.serverId);
                done();
            }
        });
    }

    // Register the node
    RED.nodes.registerType("mcp-server", MCPServerNode);

    // Add admin endpoint to list running servers
    RED.httpAdmin.get("/mcp-servers", function (req, res)
    {
        const servers = [];
        serverCache.keys().forEach(key =>
        {
            const server = serverCache.get(key);
            if (server)
            {
                servers.push({
                    serverId: key,
                    serverName: server.node.serverName,
                    isRunning: server.node.isRunning,
                    port: server.port,
                    startTime: server.startTime,
                    lastHealthCheck: server.node.lastHealthCheck
                });
            }
        });
        res.json({ servers });
    });
}; 
