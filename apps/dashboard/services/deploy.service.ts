/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any */
// @ts-ignore - Local workspace package
import { deploy, ServerConfig, ProjectConfig, DeployResult, SSHClient, configureCaddy } from '@hylius/core';
import { decrypt } from './crypto.service';
import { getAuthenticatedCloneUrl, createGitHubDeployment, updateGitHubDeploymentStatus, createPullRequestComment, getInstallationToken } from './github.service';
import { agentGateway } from './agent-gateway.service';
import { AlertService } from './alert.service';

import { prisma } from './prisma';

export interface DeployServiceOptions {
    projectId: string;
    trigger: 'dashboard' | 'webhook' | 'cli';
    prNumber?: number;
    commitSha?: string;
    /** Optional callback for real-time log streaming (e.g. socket.emit) */
    onLog?: (chunk: string) => void;
}

/**
 * Execute a full deployment for a project.
 * This is the single source of truth for the deploy pipeline — called by
 * both the Socket.io handler (dashboard) and the GitHub webhook endpoint.
 */
// Global in-memory queue to prevent concurrent deployments for the SAME project
const deploymentMutexes = new Map<string, Promise<void>>();

export async function executeDeployment(options: DeployServiceOptions): Promise<DeployResult & { deploymentId: string }> {
    const { projectId, onLog } = options;
    
    // Wait for existing deployment for this project to finish (queuing)
    const existingDeployment = deploymentMutexes.get(projectId);
    if (existingDeployment) {
        if (onLog) onLog(`\n⏳ Another deployment is currently in progress for this service. Queuing this deployment until it finishes...\n`);
        await existingDeployment;
    }

    let resolveMutex: () => void;
    const currentDeploymentPromise = new Promise<void>((resolve) => { resolveMutex = resolve; });
    deploymentMutexes.set(projectId, currentDeploymentPromise);

    try {
        return await _executeDeploymentInternal(options);
    } finally {
        resolveMutex!();
        if (deploymentMutexes.get(projectId) === currentDeploymentPromise) {
            deploymentMutexes.delete(projectId);
        }
    }
}

/**
 * Internal deployment logic — do not call directly, use executeDeployment instead.
 */
async function _executeDeploymentInternal(options: DeployServiceOptions): Promise<DeployResult & { deploymentId: string }> {
    const { projectId, trigger, prNumber, onLog } = options;
    const isPreview = !!prNumber;

    // We will buffer ALL logs here to save them to the DB later
    let fullLogContent = '';

    // Create a wrapper for onLog that also buffers and broadcasts
    let enhancedLog = (chunk: string) => {
        fullLogContent += chunk;
        if (onLog) onLog(chunk);

        // Broadcast the chunk in real-time to anyone reading this deployment detail page
        const globalIo = (global as any).io;
        if (globalIo) {
            // (We assign this below once deployment is created)
        }
    };

    const log = (msg: string) => { enhancedLog(msg); };

    // 1. Fetch Project & Server Config
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { server: true, domains: true },
    });

    if (!project) {
        throw new Error('Project not found');
    }

    // 2. Create Deployment Record
    // @ts-ignore
    const deployment = await prisma.deployment.create({
        data: {
            projectId: project.id,
            organizationId: project.organizationId,
            status: 'PENDING',
            triggerSource: trigger.toUpperCase(),
            releaseId: 'pending',
            environment: isPreview ? 'PREVIEW' : 'PRODUCTION',
            pullRequestNumber: prNumber || null,
        },
    });

    // Audit Log
    await prisma.auditLog.create({
        data: {
            action: 'DEPLOYMENT_STARTED',
            organizationId: project.organizationId,
            metadata: JSON.stringify({
                projectId: project.id,
                deploymentId: deployment.id,
                trigger,
            }),
        },
    });

    // Overwrite the real-time globalIo broadcast above now that we have the deployment.id
    enhancedLog = (chunk: string) => {
        fullLogContent += chunk;
        if (onLog) onLog(chunk);
        const globalIo = (global as any).io;
        if (globalIo && deployment.id) {
            globalIo.emit(`deployment_log_chunk:${deployment.id}`, chunk);
        }
    };

    // 3. Prepare Core Config — Decrypt SSH key in-memory
    let privateKey = '';
    if (project.server.privateKeyEncrypted && project.server.keyIv) {
        try {
            privateKey = decrypt(project.server.privateKeyEncrypted, project.server.keyIv);
        } catch (e) {
            log(`Error decrypting SSH key: ${e}\n`);
        }
    }

    const serverConfig: ServerConfig = {
        // @ts-ignore
        host: project.server.ip,
        port: project.server.port,
        username: project.server.username,
        privateKey: privateKey.includes('BEGIN') ? privateKey : undefined,
        password: privateKey && !privateKey.includes('BEGIN') ? privateKey : undefined,
    };

    // Determine repo URL — use authenticated clone URL for GitHub App repos
    let repoUrl = project.repoUrl;
    let installationToken: string | undefined;
    if (project.githubInstallationId && project.githubRepoFullName) {
        try {
            installationToken = await getInstallationToken(project.githubInstallationId);
            repoUrl = await getAuthenticatedCloneUrl(
                project.githubInstallationId,
                project.githubRepoFullName,
            );
            log(`Using GitHub App authenticated clone URL\n`);
        } catch (e: any) {
            log(`Warning: Could not get authenticated clone URL, falling back to repoUrl: ${e.message}\n`);
        }
    }


    let envVars: Record<string, string> = {};
    if (project.envVars) {
        try {
            envVars = JSON.parse(project.envVars as string);
        } catch (e: any) {
            log(`Warning: Failed to parse project envVars: ${e.message}\n`);
        }
    }

    let dockerComposeYaml: string | undefined = undefined;
    if (envVars['_HYLIUS_TEMPLATE_COMPOSE_']) {
        dockerComposeYaml = envVars['_HYLIUS_TEMPLATE_COMPOSE_'];
        delete envVars['_HYLIUS_TEMPLATE_COMPOSE_'];
    }

    // Inject analytics env vars BEFORE building projectConfig so that
    // projectConfig.env and envVars are always the same object reference.
    let analyticsScript = '';
    const analyticsSiteId = (project as any).trafficAnalyticsSiteId as string | null;
    const analyticsUmamiUrl = (project.server as any).trafficAnalyticsUrl as string | null;
    if (analyticsSiteId && analyticsUmamiUrl && !isPreview) {
        const useRelative = project.domains && project.domains.length > 0;
        const scriptSrc = useRelative ? '/_umami/script.js' : `${analyticsUmamiUrl}/script.js`;
        const scriptUrl = useRelative ? '/_umami' : analyticsUmamiUrl;
        envVars['NEXT_PUBLIC_UMAMI_SITE_ID'] = analyticsSiteId;
        envVars['NEXT_PUBLIC_UMAMI_URL'] = scriptUrl;
        analyticsScript = `<script defer src="${scriptSrc}" data-website-id="${analyticsSiteId}"></script>`;
    }

    let sentryDsn: string | undefined = undefined;
    if (project.server.hasErrorTracking && !isPreview) {
        const { GlitchtipApiService } = await import('./glitchtip-api.service');
        try {
            const dsn = await GlitchtipApiService.ensureProject(project.id);
            if (dsn) {
                sentryDsn = dsn;
                envVars['SENTRY_DSN'] = dsn;
                envVars['NEXT_PUBLIC_SENTRY_DSN'] = dsn;
                envVars['VITE_SENTRY_DSN'] = dsn;
            }
        } catch (e: any) {
            log(`Warning: Failed to fetch GlitchTip Sentry DSN: ${e.message}\n`);
        }
    }

        let finalRegistryAuth: any = undefined;
        if (project.githubInstallationId && envVars['GHCR_PAT']) {
            finalRegistryAuth = {
                registry: 'ghcr.io',
                username: project.githubRepoFullName?.split('/')[0] || 'hylius',
                password: envVars['GHCR_PAT']
            };
            log(`Authenticating to GHCR using provided GHCR_PAT from environment variables.\n`);
        } else if (installationToken) {
            finalRegistryAuth = {
                registry: 'ghcr.io',
                username: 'x-access-token',
                password: installationToken
            };
        }

    const projectConfig: ProjectConfig = {
        name: project.name,
        repoUrl,
        branch: project.branch,
        deployPath: project.deployPath,
        buildCommand: project.buildCommand || undefined,
        startCommand: project.startCommand || undefined,
        // 'dagger' strategy produces a GHCR image just like 'ghcr-pull' — VPS behavior is identical
        deployStrategy: (project.deployStrategy === 'dagger' ? 'ghcr-pull' : project.deployStrategy as any) || 'auto',
        ghcrImage: project.ghcrImage || undefined,
        env: envVars,
        environment: isPreview ? 'PREVIEW' : 'PRODUCTION',
        previewId: isPreview ? `pr-${prNumber}` : undefined,
        dockerComposeYaml,
        containerName: (project as any).containerName || undefined,
        analyticsScript,
        sentryDsn,
        registryAuth: finalRegistryAuth,
    } as any;

    // Auto-inject URL environment variables
    const serverIpSlug = project.server.ip.replace(/\./g, '-');
    if (isPreview) {
        const previewHostname = `pr-${prNumber}.${serverIpSlug}.sslip.io`;
        // For previews, we definitively know the exact URL
        projectConfig.env!['APP_URL'] = `https://${previewHostname}`;
        projectConfig.env!['NEXT_PUBLIC_APP_URL'] = `https://${previewHostname}`;
        projectConfig.env!['ASSET_URL'] = `https://${previewHostname}`;
        projectConfig.env!['HTTPS'] = 'on';
    } else if (project.domains.length > 0) {
        // For production, inject the primary domain if one exists and user hasn't hardcoded it
        if (!projectConfig.env!['APP_URL']) projectConfig.env!['APP_URL'] = `https://${project.domains[0].hostname}`;
        if (!projectConfig.env!['NEXT_PUBLIC_APP_URL']) projectConfig.env!['NEXT_PUBLIC_APP_URL'] = `https://${project.domains[0].hostname}`;
        if (!projectConfig.env!['ASSET_URL']) projectConfig.env!['ASSET_URL'] = `https://${project.domains[0].hostname}`;
        projectConfig.env!['HTTPS'] = 'on';
    }

    // Auto-inject DATABASE_URL / REDIS_URL from linked managed databases
    try {
        // @ts-ignore
        const linkedDatabases = await prisma.database.findMany({
            where: { projectId: project.id, status: 'RUNNING' },
        });
        for (const db of linkedDatabases) {
            const envKey = db.engine === 'REDIS' ? 'REDIS_URL' : 'DATABASE_URL';
            if (!db.passwordEncrypted || !db.passwordIv) continue;
            try {
                const password = decrypt(db.passwordEncrypted, db.passwordIv);
                // Reconstruct container name if missing (matches @hylius/core getContainerName)
                const resolvedContainerName = db.containerName || `hylius-db-${db.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

                const { buildInternalDbConnectionString } = await import('@hylius/core' as any);
                // Always build the internal connection string — the container name
                // is only reachable inside the Docker network, never via localhost.
                const internalConnectionString = buildInternalDbConnectionString(
                    db.engine, db.dbUser || '', password, db.dbName || '', resolvedContainerName
                );

                // Force DATABASE_URL / REDIS_URL to the internal string unconditionally.
                // A user may have saved localhost-based URLs in their project env vars
                // (e.g. from the "Show Connection String" panel) — these are wrong at runtime.
                projectConfig.env![envKey] = internalConnectionString;

                if (envKey === 'DATABASE_URL') {
                    // DB_URL is the Laravel-specific alias — force it too
                    projectConfig.env!['DB_URL'] = internalConnectionString;
                    if (!projectConfig.env!['DB_CONNECTION']) projectConfig.env!['DB_CONNECTION'] = db.engine === 'POSTGRES' ? 'pgsql' : 'mysql';
                    projectConfig.env!['DB_HOST'] = resolvedContainerName;
                    projectConfig.env!['DB_PORT'] = db.engine === 'POSTGRES' ? '5432' : '3306';
                    if (!projectConfig.env!['DB_DATABASE']) projectConfig.env!['DB_DATABASE'] = db.dbName || '';
                    if (!projectConfig.env!['DB_USERNAME']) projectConfig.env!['DB_USERNAME'] = db.dbUser || '';
                    if (!projectConfig.env!['DB_PASSWORD']) projectConfig.env!['DB_PASSWORD'] = password;
                }
                if (envKey === 'REDIS_URL') {
                    projectConfig.env!['REDIS_HOST'] = resolvedContainerName;
                    if (!projectConfig.env!['REDIS_PASSWORD']) projectConfig.env!['REDIS_PASSWORD'] = password;
                    projectConfig.env!['REDIS_PORT'] = '6379';
                }

                log(`[DB] Auto-injected env vars for ${db.engine} database "${db.name}" (container: ${resolvedContainerName})\n`);
            } catch (dbErr: any) {
                log(`[DB] Warning: Could not inject ${envKey}: ${dbErr.message}\n`);
            }
        }
    } catch (dbQueryErr: any) {
        log(`[DB] Warning: Could not query linked databases: ${dbQueryErr.message}\n`);
    }

    // Fetch all active deployments to build the full Caddy proxy list (Production + Previews)
    const activeDeployments = await prisma.deployment.findMany({
        where: {
            projectId: project.id,
            status: 'SUCCESS',
        },
        orderBy: { startedAt: 'desc' }
    });

    const domainConfigs: any[] = [];

    // 1. Add Production Domains (if they exist)
    if (project.domains.length > 0) {
        // Find the latest production deployment port
        const latestProd = activeDeployments.find((d: any) => d.environment === 'PRODUCTION');
        let prodPort = '3000';
        if (latestProd?.deployUrl) {
            try { prodPort = new URL(latestProd.deployUrl).port || '3000'; } catch { }
        }
        // Wait, the orchestrator naturally infers the appPort if we just pass `{ hostname: d.hostname }`
        // BUT if we are currently deploying a PREVIEW, the orchestrator's `appPort` belongs to the PREVIEW!
        // So we MUST explicitly lock the Production domains to their existing port (prodPort)!!
        project.domains.forEach((d: any) => {
            domainConfigs.push({ hostname: d.hostname, upstreamPort: isPreview ? prodPort : undefined });
        });
    }

    // 2. Add Active Preview Domains
    const activePreviews = activeDeployments.filter((d: any) => d.environment === 'PREVIEW' && d.pullRequestNumber);

    // Add previously built previews
    activePreviews.forEach((d: any) => {
        // Skip the one we are currently building, as it gets added natively below
        if (d.pullRequestNumber === prNumber) return;

        const previewHostname = `pr-${d.pullRequestNumber}.${serverIpSlug}.sslip.io`;
        let prePort = '3000';
        if (d.deployUrl) {
            try { prePort = new URL(d.deployUrl).port || '3000'; } catch { }
        }
        domainConfigs.push({ hostname: previewHostname, upstreamPort: prePort });
    });

    // 3. Add the current deployment's domain
    if (isPreview) {
        // Pseudo-subdomain for the current preview deployment
        const previewHostname = `pr-${prNumber}.${serverIpSlug}.sslip.io`;
        // Unshift ensures this is the PRIMARY domain orchestrator returns as the finalURL!
        domainConfigs.unshift({ hostname: previewHostname });
        log(`\\n\\x1b[35m[Preview] Automatically provisioning custom pseudodomain: ${previewHostname}\\x1b[0m\\n`);
    }

    // GitHub Deployments Integration: Create deployment and set to in_progress
    let githubDeploymentId: number | null = null;
    const isGithubApp = !!(project.githubInstallationId && project.githubRepoFullName);

    if (isGithubApp) {
        log(`[GitHub] Creating deployment status...\n`);
        githubDeploymentId = await createGitHubDeployment({
            installationId: project.githubInstallationId!,
            repoFullName: project.githubRepoFullName!,
            ref: options.commitSha || project.branch || 'main',
            description: `Deployed via Hylius (${trigger})`,
            environment: isPreview ? `Preview (PR #${prNumber})` : 'Production',
        });

        if (githubDeploymentId) {
            await updateGitHubDeploymentStatus({
                installationId: project.githubInstallationId!,
                repoFullName: project.githubRepoFullName!,
                deploymentId: githubDeploymentId,
                state: 'in_progress',
                description: 'Build and deployment in progress...',
            });
        }
    }

    // 4. Execute Deployment
    log(`\x1b[36mStarting deployment for ${project.name}...  (trigger: ${trigger})\x1b[0m\n`);

    // Route through agent if connected, otherwise fall back to SSH
    const useAgent = (project.server as any).connectionMode === 'AGENT'
        && agentGateway.isConnected(project.server.id);

    if (useAgent) {
        log(`\x1b[35m[Agent] Routing deploy through VPS agent (no SSH)\x1b[0m\n`);
    }

    const result = await deploy({
        server: serverConfig,
        project: projectConfig,
        trigger,
        domains: domainConfigs.length > 0 ? domainConfigs : undefined,
        onLog: (chunk) => log(chunk),
        executionMode: useAgent ? 'agent' : 'ssh',
        agent: useAgent ? agentGateway.getAgentConfig(project.server.id) : undefined,
    });

    // Update GitHub Deployment Status
    if (isGithubApp && githubDeploymentId) {
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || '';
        await updateGitHubDeploymentStatus({
            installationId: project.githubInstallationId!,
            repoFullName: project.githubRepoFullName!,
            deploymentId: githubDeploymentId,
            state: result.success ? 'success' : 'failure',
            environmentUrl: result.url || undefined,
            logUrl: baseUrl ? `${baseUrl}/deployments/${deployment.id}` : undefined,
            description: result.success ? 'Deployment successful' : 'Deployment failed',
        });

        // For Previews: Leave a comment on the PR with the Preview URL
        if (result.success && isPreview && prNumber && result.url) {
            log(`[GitHub] Posting preview URL comment to PR #${prNumber}...\\n`);
            await createPullRequestComment({
                installationId: project.githubInstallationId!,
                repoFullName: project.githubRepoFullName!,
                prNumber,
                body: `## 🚀 Preview Deployment Ready!\n\nYour preview environment has been successfully provisioned:\n\n🔗 **Preview URL**: [${result.url}](${result.url})\n\n> _Deployed by Hylius_`
            });
        }
    }

    // 5. Update Status
    // @ts-ignore
    await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
            status: result.success ? 'SUCCESS' : 'FAILED',
            releaseId: result.releaseId,
            durationMs: result.durationMs,
            commitHash: result.commitHash,
            deployUrl: result.url || null,
            finishedAt: new Date(),
            // @ts-ignore - new property from Prisma schema update
            logContent: fullLogContent,
        },
    });

    // Audit Log Completion
    await prisma.auditLog.create({
        data: {
            action: result.success ? 'DEPLOYMENT_COMPLETED' : 'DEPLOYMENT_FAILED',
            organizationId: project.organizationId,
            metadata: JSON.stringify({
                projectId: project.id,
                deploymentId: deployment.id,
                releaseId: result.releaseId,
                trigger,
                error: result.error,
            }),
        },
    });

    if (!result.success) {
        await AlertService.triggerAlert({
            organizationId: project.organizationId,
            type: 'DEPLOYMENT_FAILED',
            message: `Deployment failed for project **${project.name}** on server **${project.server.name}**.\n\nError: ${result.error}`,
            serverId: project.serverId,
            projectId: project.id,
        });
    } else if (!isPreview && (project.server as any).hasUptimeMonitoring) {
        // Auto-create or update UptimeMonitor for successful production deployments
        try {
            const monitorName = `${project.name} Production`;
            let endpoint = result.url || '';
            if (!endpoint && project.domains.length > 0) {
                endpoint = `https://${project.domains[0].hostname}`;
            } else if (!endpoint) {
                endpoint = `http://${project.server.ip}:${projectConfig.env!['PORT'] || '3000'}`;
            }

            let monitor = await prisma.uptimeMonitor.findUnique({
                where: { projectId: project.id }
            });

            if (!monitor) {
                monitor = await prisma.uptimeMonitor.create({
                    data: {
                        name: monitorName,
                        endpoint,
                        type: 'HTTP',
                        interval: 30,
                        autoHeal: true,
                        serverId: project.serverId,
                        projectId: project.id,
                    }
                });
                log(`\n[Uptime] Auto-created Uptime Monitor for ${project.name}\n`);
            } else if (monitor.endpoint !== endpoint) {
                monitor = await prisma.uptimeMonitor.update({
                    where: { id: monitor.id },
                    data: { endpoint }
                });
            }

            const { UptimeService } = await import('./uptime.service');
            const containerName = projectConfig.containerName || `${project.name}-app`;
            await UptimeService.syncMonitorToAgent(project.serverId, monitor, containerName);
        } catch (uptimeErr: any) {
            log(`\n[Uptime] Warning: Could not configure Uptime Monitor: ${uptimeErr.message}\n`);
        }
    }

    return { ...result, deploymentId: deployment.id };
}

/**
 * Destroy an active Preview Deployment container and remove its Caddy proxy records
 */
export async function destroyPreviewDeployment(projectId: string, prNumber: number): Promise<boolean> {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { server: true, domains: true }
    });

    if (!project) throw new Error('Project not found');

    const previewId = `pr-${prNumber}`;
    const baseContainerName = `${project.name}-app`;
    const containerName = `${baseContainerName}-${previewId}`;
    const environmentPath = `${project.deployPath}/previews/${previewId}`;

    // Calculate domain configs for Caddy (excluding this preview)
    const activeDeployments = await prisma.deployment.findMany({
        where: {
            projectId: project.id,
            status: 'SUCCESS',
        },
        orderBy: { startedAt: 'desc' }
    });

    const domainConfigs: any[] = [];

    // Add Production Domains
    if (project.domains.length > 0) {
        const latestProd = activeDeployments.find((d: any) => d.environment === 'PRODUCTION');
        let prodPort = '3000';
        if (latestProd?.deployUrl) {
            try { prodPort = new URL(latestProd.deployUrl).port || '3000'; } catch { }
        }
        project.domains.forEach((d: any) => {
            domainConfigs.push({ hostname: d.hostname, upstreamPort: prodPort });
        });
    }

    // Add OTHER Active Preview Domains (exluding the one we are destroying)
    const activePreviews = activeDeployments.filter((d: any) => d.environment === 'PREVIEW' && d.pullRequestNumber && d.pullRequestNumber !== prNumber);
    const serverIpSlug = project.server.ip.replace(/\./g, '-');

    activePreviews.forEach((d: any) => {
        const previewHostname = `pr-${d.pullRequestNumber}.${serverIpSlug}.sslip.io`;
        let prePort = '3000';
        if (d.deployUrl) {
            try { prePort = new URL(d.deployUrl).port || '3000'; } catch { }
        }
        domainConfigs.push({ hostname: previewHostname, upstreamPort: prePort });
    });

    // Check if we should use the connected Agent
    const useAgent = (project.server as any).connectionMode === 'AGENT'
        && agentGateway.isConnected(project.server.id);

    try {
        if (useAgent) {
            console.log(`[Agent] Destroying preview deployment via VPS agent...`);
            const agent = agentGateway.getAgentConfig(project.server.id);

            // 1 & 2. Kill container and remove directory
            await agent.streamCommand('exec', { cmd: `docker rm -f ${containerName} > /dev/null 2>&1 || true && rm -rf ${environmentPath} > /dev/null 2>&1 || true` }, () => { });

            // 3. Update Caddy (only if there are domains to configure)
            if (domainConfigs.length > 0) {
                await agent.streamCommand('configure-caddy', { domains: domainConfigs, tlsMode: 'production' }, () => { });
            }

        } else {
            console.log(`[SSH] Destroying preview deployment via SSH...`);
            let privateKey = '';
            if (project.server.privateKeyEncrypted && project.server.keyIv) {
                try { privateKey = decrypt(project.server.privateKeyEncrypted, project.server.keyIv); } catch { }
            }



            const serverConfig = {
                host: project.server.ip,
                port: project.server.port,
                username: project.server.username,
                privateKey: privateKey.includes('BEGIN') ? privateKey : undefined,
                password: privateKey && !privateKey.includes('BEGIN') ? privateKey : undefined,
            };

            const client = new SSHClient(serverConfig);
            try {
                await client.connect();

                // 1. Kill and remove the container
                await client.exec(`docker rm -f ${containerName} > /dev/null 2>&1 || true`);

                // 2. Remove the preview directory
                await client.exec(`rm -rf ${environmentPath} > /dev/null 2>&1 || true`);

                // 3. Update Caddy (only if there are domains to configure)
                if (domainConfigs.length > 0) {
                    await configureCaddy(client, { domains: domainConfigs, tlsMode: 'production' });
                }
            } finally {
                client.end();
            }
        }

        // 4. Mark DB deployments as destroyed
        await prisma.deployment.updateMany({
            where: {
                projectId: project.id,
                environment: 'PREVIEW',
                pullRequestNumber: prNumber
            },
            data: { status: 'DESTROYED' }
        });

        return true;
    } catch (err: any) {
        console.error(`Error destroying preview deployment ${previewId}:`, err);
        throw err;
    }
}
