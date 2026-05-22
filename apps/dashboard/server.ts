/* eslint-disable no-console, @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any */
import dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'node:http';
import next from 'next';
import { Server } from 'socket.io';
import { WebSocketServer } from 'ws';
import { PrismaClient } from '@prisma/client';
// @ts-ignore - Local workspace package
import { setup, ServerConfig, SetupOptions, SSHClient } from '@hylius/core';
import { decrypt } from './services/crypto.service';
import { executeDeployment } from './services/deploy.service';
import { agentGateway } from './services/agent-gateway.service';


const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);
// when using middleware `hostname` and `port` must be provided below
// In production (Docker), server.js runs from /app but .next is under /app/apps/dashboard
const dir = dev ? undefined : require('path').resolve(__dirname, '..');
const app = next({ dev, hostname, port, dir });
const handler = app.getRequestHandler();
const prisma = new PrismaClient();

// Track active deployments to prevent concurrent duplicate calls or spam
const activeDeployments = new Set<string>();
const activeSetups = new Set<string>();

// Track active log streams: projectId → SSHClient (so we can destroy on unwatch/disconnect)
const activeLogStreams = new Map<string, SSHClient>();

app.prepare().then(() => {
    const httpServer = createServer(handler);

    const io = new Server(httpServer);
    (global as any).io = io; // Expose globally for API routes (e.g. webhooks)

    io.on('connection', (socket) => {
        console.log('Client connected:', socket.id);

        // @ts-ignore
        socket.on('deploy', async (data: { projectId: string }) => {
            const { projectId } = data;
            console.log(`Received deploy request for project: ${projectId}`);

            if (activeDeployments.has(projectId)) {
                socket.emit(`error:${projectId}`, 'A deployment is already in progress for this project.');
                socket.emit(`log:${projectId}`, `\n\x1b[31mDeployment already in progress, please wait.\x1b[0m\n`);
                return;
            }
            activeDeployments.add(projectId);

            try {
                // Emit an initial deploy_start so UI knows it started
                socket.emit(`deploy_start:${projectId}`, { deploymentId: 'pending' });

                const result = await executeDeployment({
                    projectId,
                    trigger: 'dashboard',
                    onLog: (chunk) => {
                        socket.emit(`log:${projectId}`, chunk);
                    },
                });

                if (result.success) {
                    socket.emit(`deploy_success:${projectId}`, result);
                    socket.emit(`log:${projectId}`, `\n\x1b[32mDeployment Successful! Release: ${result.releaseId}\x1b[0m\n`);
                } else {
                    socket.emit(`deploy_error:${projectId}`, result.error);
                    socket.emit(`log:${projectId}`, `\n\x1b[31mDeployment Failed: ${result.error}\x1b[0m\n`);
                }

            } catch (error: any) {
                console.error('Deployment error:', error);
                socket.emit(`error:${projectId}`, error.message);
                socket.emit(`log:${projectId}`, `\n\x1b[31mSystem Error: ${error.message}\x1b[0m\n`);
            } finally {
                activeDeployments.delete(projectId);
            }
        });

        socket.on('setup-server', async (data: { serverId: string }) => {
            const { serverId } = data;
            console.log(`Received setup request for server: ${serverId}`);

            if (activeSetups.has(serverId)) {
                socket.emit('error', 'A setup is already in progress for this server.');
                socket.emit('log', `\n\x1b[31mSetup already in progress, please wait.\x1b[0m\n`);
                return;
            }
            activeSetups.add(serverId);

            try {
                // 1. Fetch Server Config
                const serverRecord = await prisma.server.findUnique({
                    where: { id: serverId },
                });

                if (!serverRecord) {
                    socket.emit('error', 'Server not found');
                    return;
                }

                socket.emit('setup_start', { serverId: serverRecord.id });

                // Audit Log
                await prisma.auditLog.create({
                    data: {
                        action: 'SERVER_PROVISION_STARTED',
                        organizationId: serverRecord.organizationId,
                        metadata: JSON.stringify({ serverId: serverRecord.id, name: serverRecord.name })
                    }
                });

                // 2. Prepare Core Config
                let privateKey = '';
                if (serverRecord.privateKeyEncrypted && serverRecord.keyIv) {
                    try {
                        privateKey = decrypt(serverRecord.privateKeyEncrypted, serverRecord.keyIv);
                    } catch (e) {
                        socket.emit('log', `Error decrypting SSH key: ${e}\n`);
                    }
                }

                const serverConfig: ServerConfig = {
                    host: serverRecord.ip,
                    port: serverRecord.port,
                    username: serverRecord.username,
                    privateKey: privateKey.includes('BEGIN') ? privateKey : undefined,
                    password: privateKey && !privateKey.includes('BEGIN') ? privateKey : undefined,
                };

                // 3. Execute Setup (includes auto-install of Hylius Agent as final step)
                socket.emit('log', `\x1b[36mStarting provisioning for ${serverRecord.name}...\x1b[0m\n`);

                // Determine the public URL of this dashboard (for agent to connect back)
                const dashboardUrl = process.env.NEXT_PUBLIC_APP_URL
                    || `http://${process.env.HOSTNAME || 'localhost'}:${port}`;

                // ── Prefer agent path when the server is already connected ────
                // (new "add server" flow installs the agent manually before provisioning)
                const agentAlreadyConnected = agentGateway.isConnected(serverId);
                if (agentAlreadyConnected) {
                    socket.emit('log', `\x1b[35m[Agent] Server agent is connected — running setup via agent (no SSH).\x1b[0m\n`);
                }

                const result = await setup({
                    server: serverConfig,
                    onLog: (chunk: string) => {
                        socket.emit('log', chunk);
                    },
                    // Agent auto-install params — setup.ts Step 5 uses these
                    agentToken: (serverRecord as any).agentToken,
                    agentServerUrl: dashboardUrl,
                    agentServerId: serverRecord.id,
                    // Route through connected agent instead of SSH when available
                    ...(agentAlreadyConnected && {
                        executionMode: 'agent',
                        agent: agentGateway.getAgentConfig(serverId),
                    }),
                } as any);

                if (result.success) {
                    socket.emit('setup_success', result);

                    // Auto-upgrade server to agent mode — the agent will connect
                    // via WebSocket within seconds and the gateway will mark it ONLINE
                    await prisma.server.update({
                        where: { id: serverRecord.id },
                        data: { connectionMode: 'AGENT', status: 'UNKNOWN' } as any,
                    }).catch(() => {});
                } else {
                    socket.emit('setup_error', result.error);
                }

                // Audit Log Completion
                await prisma.auditLog.create({
                    data: {
                        action: result.success ? 'SERVER_PROVISION_COMPLETED' : 'SERVER_PROVISION_FAILED',
                        organizationId: serverRecord.organizationId,
                        metadata: JSON.stringify({
                            serverId: serverRecord.id,
                            name: serverRecord.name,
                            error: result.error
                        })
                    }
                });


            } catch (error: any) {
                console.error('Setup error:', error);
                socket.emit('error', error.message);
                socket.emit('log', `\n\x1b[31mSystem Error: ${error.message}\x1b[0m\n`);
            } finally {
                activeSetups.delete(serverId);
            }
        });

        // ─── watch-logs: stream runtime logs from the VPS ────────────────────
        socket.on('watch-logs', async (data: { projectId: string }) => {
            const { projectId } = data;

            if (activeLogStreams.has(projectId)) {
                socket.emit(`logs:connected:${projectId}`);
                return;
            }

            try {
                const project = await prisma.project.findUnique({
                    where: { id: projectId },
                    include: { server: true },
                });

                if (!project) {
                    socket.emit(`logs:error:${projectId}`, 'Project not found');
                    return;
                }

                // ─── Agent path (preferred) ───────────────────────────────
                const useAgent = (project.server as any).connectionMode === 'AGENT'
                    && agentGateway.isConnected(project.server.id);

                if (useAgent) {
                    socket.emit(`logs:connected:${projectId}`);

                    // Track the stream commandId so we can cancel it on unwatch
                    let streamCommandId: string | null = null;

                    const streamPromise = agentGateway.streamCommand(
                        project.server.id,
                        'stream-logs',
                        { containerName: `${project.name}-app`, projectName: project.name },
                        (chunk: string) => socket.emit(`logs:data:${projectId}`, chunk),
                    );

                    // Store a canceller object (duck-typed to match the SSHClient shape used elsewhere)
                    activeLogStreams.set(projectId, {
                        end: () => {
                            if (streamCommandId) {
                                agentGateway.cancelStream(project.server.id, streamCommandId);
                            }
                        }
                    } as any);

                    streamPromise
                        .then(() => {
                            socket.emit(`logs:closed:${projectId}`);
                            activeLogStreams.delete(projectId);
                        })
                        .catch((err: Error) => {
                            socket.emit(`logs:error:${projectId}`, err.message);
                            activeLogStreams.delete(projectId);
                        });

                    return;
                }

                // ─── SSH fallback path ────────────────────────────────────
                let privateKey = '';
                if (project.server.privateKeyEncrypted && project.server.keyIv) {
                    privateKey = decrypt(project.server.privateKeyEncrypted, project.server.keyIv);
                }

                const sshClient = new SSHClient({
                    // @ts-ignore
                    host: project.server.ip,
                    port: project.server.port,
                    username: project.server.username,
                    privateKey: privateKey.includes('BEGIN') ? privateKey : undefined,
                    password: privateKey && !privateKey.includes('BEGIN') ? privateKey : undefined,
                });

                await sshClient.connect();
                activeLogStreams.set(projectId, sshClient);
                socket.emit(`logs:connected:${projectId}`);

                const containerName = `${project.name}-app`;
                const { code: dockerCheck } = await sshClient.exec(
                    `docker inspect ${containerName} --format='{{.State.Running}}' 2>/dev/null`
                );

                const logCommand = dockerCheck === 0
                    ? `docker logs --tail 100 --follow ${containerName} 2>&1`
                    : `pm2 logs ${project.name} --nocolor --lines 100 2>&1`;

                sshClient.execStream(
                    logCommand,
                    (chunk: string) => socket.emit(`logs:data:${projectId}`, chunk),
                    (chunk: string) => socket.emit(`logs:data:${projectId}`, chunk),
                ).then(() => {
                    socket.emit(`logs:closed:${projectId}`);
                    activeLogStreams.delete(projectId);
                    sshClient.end();
                }).catch((err: Error) => {
                    socket.emit(`logs:error:${projectId}`, err.message);
                    activeLogStreams.delete(projectId);
                    sshClient.end();
                });

            } catch (err: any) {
                console.error('[watch-logs] error:', err);
                socket.emit(`logs:error:${projectId}`, err.message || 'Connection failed');
                activeLogStreams.delete(projectId);
            }
        });

        // ─── unwatch-logs: client explicitly closes the log stream ───────────
        socket.on('unwatch-logs', (data: { projectId: string }) => {
            const { projectId } = data;
            const client = activeLogStreams.get(projectId);
            if (client) {
                client.end();
                activeLogStreams.delete(projectId);
            }
        });

        // ─── provision-database: create a managed DB container on a VPS ──────
        socket.on('provision-database', async (data: {
            serverId: string;
            engine: string;
            name: string;
            version?: string;
            projectId?: string;
            organizationId: string;
        }) => {
            const { serverId, engine, name, version, projectId, organizationId } = data;
            console.log(`Received provision-database request: ${engine} "${name}" on server ${serverId}`);

            try {
                const { createDatabase } = await import('./services/database.service');

                socket.emit(`db_provision_start:${serverId}`, { name, engine });

                const result = await createDatabase({
                    serverId,
                    organizationId,
                    engine: engine as any,
                    name,
                    version,
                    projectId,
                    onLog: (chunk: string) => {
                        socket.emit(`db_log:${serverId}`, chunk);
                    },
                });

                if (result.error) {
                    socket.emit(`db_provision_error:${serverId}`, { error: result.error, id: result.id });
                } else {
                    socket.emit(`db_provision_success:${serverId}`, { id: result.id });
                }
            } catch (err: any) {
                console.error(`[provision-database] Unhandled error for "${name}" on server ${serverId}:`, err);
                socket.emit(`db_provision_error:${serverId}`, { error: err.message || 'Unknown provisioning error' });
            }
        });

        // ─── deploy-stack: orchestrate deploying all services in a stack ─────
        socket.on('deploy-stack', async (data: { stackId: string; organizationId: string }) => {
            const { stackId, organizationId } = data;
            console.log(`Received deploy-stack request for stack: ${stackId}`);

            try {
                const { deployStack } = await import('./services/stack-deploy.service');

                socket.emit(`stack_deploy_start:${stackId}`, { stackId });

                const result = await deployStack({
                    stackId,
                    organizationId,
                    onServiceProgress: (event) => {
                        socket.emit(`stack_service_progress:${stackId}`, event);
                    },
                    onLog: (chunk) => {
                        socket.emit(`stack_log:${stackId}`, chunk);
                    },
                });

                if (result.success) {
                    socket.emit(`stack_deploy_success:${stackId}`, result);
                } else {
                    socket.emit(`stack_deploy_error:${stackId}`, result);
                }
            } catch (err: any) {
                console.error('[deploy-stack] error:', err);
                socket.emit(`stack_deploy_error:${stackId}`, { error: err.message || 'Stack deployment failed' });
            }
        });

        // ─── watch-db-metrics: poll database metrics every 30s ─────────────
        const activeDbMetricStreams = new Map<string, NodeJS.Timeout>();

        socket.on('watch-db-metrics', async (data: { databaseId: string }) => {
            const { databaseId } = data;

            if (activeDbMetricStreams.has(databaseId)) {
                return; // Already watching
            }

            try {
                const { collectMetrics } = await import('./services/database-metrics.service');

                // Collect immediately and send first snapshot
                try {
                    const snapshot = await collectMetrics(databaseId);
                    socket.emit(`db_metrics:${databaseId}`, snapshot);
                } catch (err: any) {
                    socket.emit(`db_metrics_error:${databaseId}`, err.message);
                }

                // Start polling every 30 seconds
                const interval = setInterval(async () => {
                    try {
                        const snapshot = await collectMetrics(databaseId);
                        socket.emit(`db_metrics:${databaseId}`, snapshot);
                    } catch (err: any) {
                        socket.emit(`db_metrics_error:${databaseId}`, err.message);
                    }
                }, 30000);

                activeDbMetricStreams.set(databaseId, interval);
            } catch (err: any) {
                console.error('[watch-db-metrics] error:', err);
                socket.emit(`db_metrics_error:${databaseId}`, err.message || 'Failed to start metrics');
            }
        });

        socket.on('unwatch-db-metrics', (data: { databaseId: string }) => {
            const { databaseId } = data;
            const interval = activeDbMetricStreams.get(databaseId);
            if (interval) {
                clearInterval(interval);
                activeDbMetricStreams.delete(databaseId);
            }
        });

        socket.on('disconnect', () => {
            // Clean up any active db metric streams for this socket
            for (const [, interval] of activeDbMetricStreams) {
                clearInterval(interval);
            }
            activeDbMetricStreams.clear();
            console.log('Client disconnected:', socket.id);
        });
    });

    // ─── Agent Gateway: raw WebSocket on /agent-ws ───────────────────────────
    const agentWss = new WebSocketServer({ noServer: true });
    agentGateway.attach(agentWss);

    // Route /agent-ws upgrades to the agent WebSocket server
    // (Socket.io handles its own /socket.io/ upgrades internally)
    httpServer.on('upgrade', (req, socket, head) => {
        const url = req.url || '';
        if (url.startsWith('/agent-ws')) {
            agentWss.handleUpgrade(req, socket, head, (ws) => {
                agentWss.emit('connection', ws, req);
            });
        }
    });

    httpServer
        .once('error', (err) => {
            console.error(err);
            process.exit(1);
        })
        .listen(port, () => {
            console.log(`> Ready on http://${hostname}:${port}`);
            console.log(`> Agent Gateway listening on ws://${hostname}:${port}/agent-ws`);

            // ─── Database Metrics Cron ─────────────────────────────────────
            // Collect metrics for all running databases every 5 minutes
            const DB_METRICS_INTERVAL = 5 * 60 * 1000; // 5 minutes
            const DB_PRUNE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

            setInterval(async () => {
                try {
                    const { collectAllMetrics } = await import('./services/database-metrics.service');
                    await collectAllMetrics();
                } catch (err: any) {
                    console.error('[cron:db-metrics] Collection failed:', err.message);
                }
            }, DB_METRICS_INTERVAL);

            // Prune old metrics once a day
            setInterval(async () => {
                try {
                    const { pruneOldMetrics } = await import('./services/database-metrics.service');
                    await pruneOldMetrics(7); // Keep 7 days
                } catch (err: any) {
                    console.error('[cron:db-metrics] Prune failed:', err.message);
                }
            }, DB_PRUNE_INTERVAL);

            console.log(`> Database metrics cron started (every ${DB_METRICS_INTERVAL / 1000}s)`);
        });
});
