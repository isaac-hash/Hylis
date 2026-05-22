import { DeployOptions, DeployResult, ProjectConfig, DomainConfig } from './types.js';
import { SSHClient } from './ssh/client.js';
import { configureCaddy, ensureCaddyRunning } from './domain.js';
import { configureLaravelContainer } from './laravel-helper.js';

async function execOrThrow(client: SSHClient, command: string, context: string): Promise<string> {
    const { stdout, stderr, code } = await client.exec(command);
    if (code !== 0) {
        throw new Error(`${context} failed (exit ${code}): ${stderr || stdout}`.trim());
    }
    return stdout;
}

async function execStreamOrThrow(
    client: SSHClient,
    command: string,
    context: string,
    onLog?: (chunk: string) => void,
): Promise<void> {
    let lastErrorChunk = '';
    const code = await client.execStream(command, onLog, (errChunk) => {
        lastErrorChunk += errChunk;
        if (onLog) onLog(errChunk);
    });
    if (code !== 0) {
        throw new Error(`${context} failed (exit ${code}): ${lastErrorChunk}`.trim());
    }
}

async function hasFile(client: SSHClient, filePath: string): Promise<boolean> {
    const { code } = await client.exec(`test -f ${filePath}`);
    return code === 0;
}

type ProjectRuntime = 'next' | 'vite' | 'node' | 'python' | 'fastapi' | 'go' | 'java' | 'php' | 'laravel';

/**
 * Detect runtime using railpack plan --json (for port mapping only).
 */
async function detectRuntime(client: SSHClient, releasePath: string): Promise<ProjectRuntime | null> {
    const { stdout, code } = await client.exec(`cd ${releasePath} && BUILDKIT_HOST=docker-container://buildkit railpack plan --json`);
    if (code !== 0 || !stdout.trim()) {
        return null;
    }

    try {
        const plan = JSON.parse(stdout) as { providers?: string[]; variables?: Record<string, string> };
        if (!plan.providers || plan.providers.length === 0) {
            return null;
        }

        const providers = plan.providers.map(p => p.toLowerCase());
        if (providers.includes('nextjs')) return 'next';
        if (providers.includes('node')) {
            if (await hasFile(client, `${releasePath}/vite.config.ts`) || await hasFile(client, `${releasePath}/vite.config.js`)) {
                return 'vite';
            }
            return 'node';
        }
        if (providers.includes('python')) {
            if (plan.variables?.RAILPACK_PYTHON_APP_MODULE?.includes('main:app')) return 'fastapi';
            return 'python';
        }
        if (providers.includes('php')) {
            if (await hasFile(client, `${releasePath}/artisan`)) return 'laravel';
            return 'php';
        }
        if (providers.includes('go')) return 'go';
        if (providers.includes('java')) return 'java';

        return null;
    } catch {
        return null;
    }
}

/**
 * Get the default port for a detected runtime.
 */
function getRuntimePort(runtime: ProjectRuntime | null): string {
    switch (runtime) {
        case 'python':
        case 'fastapi':
            return '8000';
        case 'go':
        case 'java':
            return '8080';
        case 'php':
        case 'laravel':
            return '80';
        case 'next':
        case 'vite':
        case 'node':
        default:
            return '3000';
    }
}

/**
 * Find a free host port starting from 3011, skipping already-mapped Docker ports.
 * Reuses the existing mapped port if the container already exists.
 */
async function findFreeHostPort(client: SSHClient, containerName: string, log: (msg: string) => void): Promise<string> {
    // Try to reuse existing container's host port
    try {
        const { stdout: psOut } = await client.exec(
            `docker ps --filter "name=^/${containerName}$" --format "{{.Ports}}"`
        );
        const match = psOut.match(/:(\d+)->/);
        if (match && match[1]) {
            log(`Reusing existing host port: ${match[1]}`);
            return match[1];
        }
    } catch { /* no existing container */ }

    // Find a free port starting from 3011
    log('Finding a free host port...');
    for (let p = 3011; p <= 3100; p++) {
        const { stdout } = await client.exec(
            `docker ps --format '{{.Ports}}' | grep -q ":${p}->" || echo "FREE"`
        );
        if (stdout.trim() === 'FREE') {
            log(`Assigned free host port: ${p}`);
            return p.toString();
        }
    }
    return '3011'; // fallback
}

type DeployStrategy = 'docker-compose' | 'dockerfile' | 'railpack' | 'nixpacks' | 'pm2' | 'ghcr-pull' | 'compose-registry' | 'compose-server' | 'dagger';

/**
 * Determine how to deploy the project based on existing files or explicit config.
 */
async function resolveDeployStrategy(client: SSHClient, releasePath: string, project: ProjectConfig): Promise<DeployStrategy> {
    // Explicit user override (skip 'auto')
    if (project.deployStrategy && project.deployStrategy !== 'auto') {
        return project.deployStrategy;
    }

    // Check for existing containerization artifacts
    const composeFile = project.dockerComposeFile || 'compose.yaml';
    if (await hasFile(client, `${releasePath}/${composeFile}`)) return 'docker-compose';
    if (await hasFile(client, `${releasePath}/docker-compose.yml`)) return 'docker-compose';
    if (await hasFile(client, `${releasePath}/Dockerfile`)) return 'dockerfile';
    if (await hasFile(client, `${releasePath}/nixpacks.toml`)) return 'nixpacks';
    if (await hasFile(client, `${releasePath}/railpack.json`)) return 'railpack';

    // Fallback to railpack — installed globally via setup.ts provisioning
    return 'railpack';
}

function getContainerName(project: ProjectConfig): string {
    const base = project.containerName || `${project.name}-app`;
    return project.previewId ? `${base}-${project.previewId}` : base;
}

function getImageName(project: ProjectConfig): string {
    return project.dockerImage || `${project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}:latest`;
}

function getDockerEnvArgs(env?: Record<string, string>): string {
    if (!env) return '';
    return Object.entries(env)
        .map(([k, v]) => ` -e "${k}=${String(v).replace(/"/g, '\\"')}"`)
        .join('');
}

function getBuilderEnvArgs(env?: Record<string, string>, prefix = '--env'): string {
    if (!env) return '';
    return Object.entries(env)
        .map(([k, v]) => ` ${prefix} "${k}=${String(v).replace(/"/g, '\\"')}"`)
        .join('');
}

/** Sanitize a project name for use as a docker compose -p argument */
function getComposeProjectName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+/, '');
}

/** Replace localhost/127.0.0.1 in agent-returned URLs with the actual server IP */
function fixAgentUrl(url: string | undefined, serverHost: string): string | undefined {
    if (!url) return url;
    return url
        .replace(/\/\/localhost([:\/])/i, `//${serverHost}$1`)
        .replace(/\/\/127\.0\.0\.1([:\/])/i, `//${serverHost}$1`);
}

/**
 * Write a .env file into the release directory so docker compose can pick up
 * all project environment variables (POSTGRES_PASSWORD, ENCRYPTION_KEY, etc.)
 */
async function writeComposeEnvFile(
    client: SSHClient,
    releasePath: string,
    env: Record<string, string> | undefined,
    log: (msg: string) => void,
): Promise<void> {
    if (!env || Object.keys(env).length === 0) {
        log('No project env vars to write — skipping .env file generation.');
        return;
    }
    log(`Writing ${Object.keys(env).length} env var(s) to ${releasePath}/.env ...`);
    // Build the .env content, escaping newlines in values
    const lines = Object.entries(env)
        .map(([k, v]) => `${k}=${String(v).replace(/\n/g, '\\n')}`)
        .join('\n');
    // Write via base64 to handle special characters safely
    const b64 = Buffer.from(lines).toString('base64');
    await client.exec(`echo '${b64}' | base64 -d > ${releasePath}/.env`);
    log('.env file written successfully.');
}

async function executeReleaseCommand(
    client: SSHClient,
    project: ProjectConfig,
    containerOrPath: string,
    isContainer: boolean,
    isLaravel: boolean,
    log: (msg: string) => void
): Promise<void> {
    let releaseCmd = project.releaseCommand;

    // Smart default for Laravel if not explicitly provided
    if (!releaseCmd && isLaravel) {
        releaseCmd = 'php artisan migrate --force';
    }

    if (!releaseCmd) {
        return;
    }

    log(`Running release command: "${releaseCmd}"`);

    // Give DB containers and apps a brief moment if they just started
    await new Promise(r => setTimeout(r, 2000));

    const maxRetries = 10;
    const retryDelayMs = 3000;

    for (let i = 1; i <= maxRetries; i++) {
        try {
            const cmdToRun = isContainer
                ? `docker exec ${containerOrPath} sh -c "${releaseCmd.replace(/"/g, '\\"')}"`
                : `cd ${containerOrPath} && ${releaseCmd}`;

            const { stdout, stderr, code } = await client.exec(cmdToRun);

            if (code === 0) {
                if (stdout) log(stdout);
                log('Release command completed successfully.');
                return;
            } else {
                throw new Error(stderr || stdout || 'Unknown error');
            }
        } catch (err: any) {
            log(`Warning: Release command failed (Attempt ${i}/${maxRetries}): ${err.message}`);
            if (i === maxRetries) {
                throw new Error(`Release command failed after ${maxRetries} attempts: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, retryDelayMs));
        }
    }
}

// ─── Analytics Script Injection (SSH Path) ────────────────────────────
async function injectAnalyticsScriptSSH(client: SSHClient, releasePath: string, script: string, log: (msg: string) => void): Promise<void> {
    if (!script) return;

    log(`[Analytics] Attempting to inject Umami tracking script via deep search...`);

    // A one-liner bash script that replicates the Go agent's WalkDir logic.
    // It searches for layout.tsx, layout.jsx, _document.tsx, _document.jsx, *.blade.php, and index.html
    // and injects the script right before </head> or </Head>.
    const injectCmd = `
        INJECTED="false"
        SCRIPT_TAG='${script.replace(/'/g, "'\\''")}'
        
        find "${releasePath}" -type f \\( -name "layout.tsx" -o -name "layout.jsx" -o -name "_document.tsx" -o -name "_document.jsx" -o -name "*.blade.php" -o -name "index.html" \\) ! -path "*/node_modules/*" ! -path "*/vendor/*" ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/.git/*" | while read -r file; do
            if grep -iq "</head>" "$file"; then
                # Use awk to inject before the closing head tag (case-insensitive)
                awk -v script="$SCRIPT_TAG" '/<\\/head>/ || /<\\/Head>/ {print script; print; next}1' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
                echo "INJECTED $file"
                break
            fi
        done
    `;

    const { stdout, stderr, code } = await client.exec(injectCmd);
    
    if (stdout.includes('INJECTED')) {
        const injectedFile = stdout.split('\\n').find(l => l.startsWith('INJECTED '))?.replace('INJECTED ', '');
        log(`[Analytics] Successfully injected script into ${injectedFile}`);
    } else {
        log(`[Analytics] Could not find a suitable injection point. Add the script tag manually.`);
    }
}

export async function deploy(options: DeployOptions): Promise<DeployResult> {
    // ─── Agent mode: delegate entire deploy to the VPS agent ─────────────────
    if (options.executionMode === 'agent' && options.agent) {
        return deployViaAgent(options);
    }

    // ─── SSH mode (default/legacy) ──────────────────────────────────────────
    const { server, project, onLog } = options;
    const client = new SSHClient(server);
    const startTime = Date.now();

    const date = new Date();
    const releaseId = date.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const environmentPath = project.previewId ? `${project.deployPath}/previews/${project.previewId}` : project.deployPath;
    const releasePath = `${environmentPath}/releases/${releaseId}`;
    const currentPath = `${environmentPath}/current`;

    const log = (msg: string) => {
        if (onLog) onLog(msg + '\n');
    };

    let finalUrl: string | undefined;

    try {
        log(`[${releaseId}] Connecting to ${server.host}...`);
        await client.connect();

        log(`Creating release directory: ${releasePath}`);
        await execOrThrow(client, `mkdir -p ${releasePath}`, 'Create release directory');

        // ─── Pre-deploy: Remove dangling images only (not all unused images/volumes) ───
        await client.exec(`docker image prune -f > /dev/null 2>&1 || true`);

        // Pre-flight: force-remove any stale container with this project's name
        // This prevents "name already in use" errors on re-deploy after a crash
        const preflightContainerName = `${project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-app`;
        await client.exec(`docker rm -f ${preflightContainerName} > /dev/null 2>&1 || true`);

        // Ensure the shared Hylius Docker network exists (for inter-container communication)
        await client.exec(`docker network create hylius 2>/dev/null || true`);


        let strategy: DeployStrategy | null = project.deployStrategy && project.deployStrategy !== 'auto'
            ? (project.deployStrategy as DeployStrategy)
            : null;

        if (strategy !== 'ghcr-pull') {
            if (project.repoUrl === 'local' && project.localBundlePath) {
                log(`Extracting local bundle from ${project.localBundlePath}...`);
                await execStreamOrThrow(
                    client,
                    `tar -xzf ${project.localBundlePath} -C ${releasePath} --strip-components=1`,
                    'Extract bundle',
                    onLog,
                );
                // Remove the bundle after extraction
                await client.exec(`rm ${project.localBundlePath}`);
            } else if (project.dockerComposeYaml) {
                log(`Template mode: writing docker-compose.yml directly...`);
                const base64Yaml = Buffer.from(project.dockerComposeYaml).toString('base64');
                await execOrThrow(client, `echo "${base64Yaml}" | base64 -d > ${releasePath}/docker-compose.yml`, 'Write template compose file');
            } else {
                log(`Cloning ${project.repoUrl} (${project.branch || 'main'})...`);
                await execStreamOrThrow(
                    client,
                    `git clone -b ${project.branch || 'main'} --depth 1 ${project.repoUrl} ${releasePath}`,
                    'Git clone',
                    onLog,
                );
            }
        }

        if (strategy !== 'ghcr-pull' && project.analyticsScript) {
            await injectAnalyticsScriptSSH(client, releasePath, project.analyticsScript, log);
        }

        if (!strategy) {
            strategy = await resolveDeployStrategy(client, releasePath, project);
        }
        log(`Deploy strategy: ${strategy}`);

        if (strategy === 'docker-compose') {
            const configuredCompose = project.dockerComposeFile || 'docker-compose.yml';
            const fallbackComposeFile = 'compose.yaml';
            const composeFile = (await hasFile(client, `${releasePath}/${configuredCompose}`)) ? configuredCompose : fallbackComposeFile;

            // Inject project env vars as a .env file so compose picks them up
            await writeComposeEnvFile(client, releasePath, project.env, log);

            // Patch compose target from development to production for server deployments
            log('Patching compose target to production...');
            await client.exec(
                `cd ${releasePath} && sed -i 's/target: development/target: production/g' ${composeFile}`
            );

            const composeProjectName = getComposeProjectName(project.name);
            log(`Running Docker Compose using ${composeFile} (project: ${composeProjectName})...`);
            await execStreamOrThrow(
                client,
                `cd ${releasePath} && docker compose -p ${composeProjectName} -f ${composeFile} up -d --build --remove-orphans`,
                'Docker Compose deploy',
                onLog,
            );
            await execOrThrow(client, `ln -sfn ${releasePath} ${currentPath}`, 'Symlink switch');
            await executeReleaseCommand(client, project, releasePath, false, false, log);

            log(`Detecting exposed port from compose stack...`);
            let composePort = '';
            try {
                const { stdout: psOut } = await client.exec(
                    `docker ps --filter "name=${composeProjectName}" --format "{{.Ports}}"`
                );
                const match = psOut.match(/:(\d+)->/);
                if (match && match[1]) {
                    composePort = match[1];
                    log(`Detected compose mapped port: ${composePort}`);
                }
            } catch (e: any) {
                log(`Failed to detect compose port: ${e.message}`);
            }
            finalUrl = `http://${options.server.host}${composePort ? `:${composePort}` : ''}`;

        } else if (strategy === 'compose-registry') {
            log(`Deploying via docker-compose (Pulling from Registry)...`);
            const composeFile = project.dockerComposeFile || 'docker-compose.yml';
            const fallbackComposeFile = 'compose.yaml';

            const fileToUse = (await hasFile(client, `${releasePath}/${composeFile}`)) ? composeFile : fallbackComposeFile;

            // Inject project env vars as a .env file so compose picks them up
            await writeComposeEnvFile(client, releasePath, project.env, log);

            await execStreamOrThrow(
                client,
                `cd ${releasePath} && docker compose -f ${fileToUse} pull`,
                'Docker Compose Pull',
                onLog
            );

            const composeProjectNameReg = getComposeProjectName(project.name);
            log(`Running docker-compose up for project ${composeProjectNameReg}...`);
            await execStreamOrThrow(
                client,
                `cd ${releasePath} && docker compose -p ${composeProjectNameReg} -f ${fileToUse} up -d --remove-orphans`,
                'Docker Compose Up',
                onLog
            );

            await execOrThrow(client, `ln -sfn ${releasePath} ${currentPath}`, 'Symlink switch');
            await executeReleaseCommand(client, project, releasePath, false, false, log);

            log(`Detecting exposed port from compose stack...`);
            let composePortReg = '';
            try {
                const { stdout: psOut } = await client.exec(
                    `docker ps --filter "name=${composeProjectNameReg}" --format "{{.Ports}}"`
                );
                const match = psOut.match(/:(\d+)->/);
                if (match && match[1]) {
                    composePortReg = match[1];
                    log(`Detected compose mapped port: ${composePortReg}`);
                }
            } catch (e: any) {
                log(`Failed to detect compose port: ${e.message}`);
            }
            finalUrl = `http://${options.server.host}${composePortReg ? `:${composePortReg}` : ''}`;

        } else if (strategy === 'compose-server') {
            log(`Deploying via docker-compose (Building on Server)...`);
            const composeFile = project.dockerComposeFile || 'docker-compose.yml';
            const fallbackComposeFile = 'compose.yaml';

            const fileToUse = (await hasFile(client, `${releasePath}/${composeFile}`)) ? composeFile : fallbackComposeFile;

            // Inject project env vars as a .env file so compose picks them up
            await writeComposeEnvFile(client, releasePath, project.env, log);

            // Patch compose target from development to production for server deployments
            log('Patching compose target to production...');
            await client.exec(
                `cd ${releasePath} && sed -i 's/target: development/target: production/g' ${fileToUse}`
            );

            const composeProjectNameSrv = getComposeProjectName(project.name);
            log(`Running docker-compose up --build for project ${composeProjectNameSrv}...`);
            await execStreamOrThrow(
                client,
                `cd ${releasePath} && docker compose -p ${composeProjectNameSrv} -f ${fileToUse} up -d --build --remove-orphans`,
                'Docker Compose Up (Build)',
                onLog
            );

            await execOrThrow(client, `ln -sfn ${releasePath} ${currentPath}`, 'Symlink switch');
            await executeReleaseCommand(client, project, releasePath, false, false, log);

            log(`Detecting exposed port from compose stack...`);
            let composePortSrv = '';
            try {
                const { stdout: psOut } = await client.exec(
                    `docker ps --filter "name=${composeProjectNameSrv}" --format "{{.Ports}}"`
                );
                const match = psOut.match(/:(\d+)->/);
                if (match && match[1]) {
                    composePortSrv = match[1];
                    log(`Detected compose mapped port: ${composePortSrv}`);
                }
            } catch (e: any) {
                log(`Failed to detect compose port: ${e.message}`);
            }
            finalUrl = `http://${options.server.host}${composePortSrv ? `:${composePortSrv}` : ''}`;

        } else if (strategy === 'ghcr-pull' || strategy === 'dagger') {
            const image = project.ghcrImage;
            if (!image) throw new Error("Initial deployment must be triggered by GitHub Actions. Please wait for your workflow to finish building the image.");

            const containerName = getContainerName(project);

            log(`Pulling pre-built image: ${image}`);
            let pullSuccess = false;
            let pullError = '';
            for (let i = 1; i <= 3; i++) {
                try {
                    if (project.registryAuth) {
                        const { registry, username, password } = project.registryAuth;
                        log(`Authenticating with registry: ${registry}`);
                        // Pass password via stdin to avoid exposing it in process lists
                        await execOrThrow(
                            client,
                            `echo "${password.replace(/"/g, '\\"')}" | docker login ${registry} -u "${username.replace(/"/g, '\\"')}" --password-stdin`,
                            'Docker login'
                        );
                    }
                    
                    await execStreamOrThrow(client, `docker pull ${image}`, 'Docker pull', onLog);
                    pullSuccess = true;
                    break;
                } catch (err: any) {
                    pullError = err.message || String(err);
                    if (i < 3) {
                        log(`Warning: Docker pull failed on attempt ${i} (often a containerd race condition). Retrying in 3 seconds...`);
                        await new Promise(res => setTimeout(res, 3000));
                    }
                }
            }
            if (!pullSuccess) {
                throw new Error(`Failed to pull image after 3 attempts: ${pullError}`);
            }
            log(`Checking for existing container port...`);
            let existingPort = '';
            try {
                const { stdout: psOut } = await client.exec(
                    `docker ps --filter "name=${containerName}" --format "{{.Ports}}"`
                );
                const match = psOut.match(/:(\d+)->/);
                if (match && match[1]) {
                    existingPort = match[1];
                }
            } catch (e: any) {
                // ignore
            }

            // Always assign a new free port for Preview environments to avoid conflicting with Production!
            if (project.previewId) {
                existingPort = '';
            }

            let port = existingPort;
            if (!port) {
                log(`Finding a free port...`);
                port = '3011';
                try {
                    // Iteratively check ports starting from 3011 using Node.js loop over SSH
                    for (let p = 3011; p <= 3100; p++) {
                        const { stdout: portStr } = await client.exec(
                            `docker ps --format '{{.Ports}}' | grep -q ":${p}->" || echo "FREE"`
                        );
                        if (portStr.trim() === 'FREE') {
                            port = p.toString();
                            break;
                        }
                    }
                } catch (e: any) {
                    log(`Failed to find dynamic port, falling back to 3011: ${e.message}`);
                }
            } else {
                log(`Reusing existing port: ${port}`);
            }

            // Detect exposed port from the Docker image
            log(`Detecting exposed port from image...`);
            let containerPort = '3000';
            try {
                const { stdout: inspectOut } = await client.exec(`docker inspect --format='{{json .Config.ExposedPorts}}' ${image}`);
                if (inspectOut && inspectOut.trim() !== 'null') {
                    const exposedPorts = JSON.parse(inspectOut.trim());
                    if (exposedPorts) {
                        const ports = Object.keys(exposedPorts).map(p => p.split('/')[0]);
                        if (ports.length > 0) {
                            containerPort = ports[0];
                            log(`Detected exposed port: ${containerPort}`);
                        } else {
                            log(`No exposed ports found in image, defaulting to 3000`);
                        }
                    }
                } else {
                    log(`No exposed ports found in image, defaulting to 3000`);
                }
            } catch (e: any) {
                log(`Failed to detect exposed port, defaulting to 3000: ${e.message}`);
            }

            if (project.env && project.env.PORT) {
                containerPort = project.env.PORT;
                log(`Overriding container port to ${containerPort} from environment variables`);
            }

            const envArgs = getDockerEnvArgs(project.env);
            const portEnvArg = project.env?.PORT ? '' : ` -e "PORT=${containerPort}"`;

            log(`Assigning host port ${port} -> container port ${containerPort} and replacing container: ${containerName}`);
            await execStreamOrThrow(
                client,
                `docker rm -f ${containerName} >/dev/null 2>&1 || true && \
                 docker run -d --name ${containerName}${envArgs}${portEnvArg} --network hylius --restart unless-stopped -p ${port}:${containerPort} ${image}`,
                'Docker run',
                onLog,
            );

            await execOrThrow(client, `ln -sfn ${releasePath} ${currentPath}`, 'Symlink switch');

            // Post-start: unconditionally run the Laravel configurator (it safely exits if not a Laravel app)
            const isHttpsDeploy = !!(options.domains && options.domains.length > 0);
            const isLaravel = await configureLaravelContainer(client, containerName, project, isHttpsDeploy, log);
            await executeReleaseCommand(client, project, containerName, true, isLaravel, log);

            const appUrl = `http://${options.server.host}:${port}`;
            log(`\n\x1b[36m🌐 Application URL: ${appUrl}\x1b[0m`);
            finalUrl = appUrl;

        } else if (strategy === 'dockerfile') {
            const imageName = getImageName(project);
            const containerName = getContainerName(project);
            const envArgs = getDockerEnvArgs(project.env);
            const buildArgs = getBuilderEnvArgs(project.env, '--build-arg');
            const runCommand = project.dockerRunCommand || `docker run -d --name ${containerName}${envArgs} --network hylius --restart unless-stopped ${imageName}`;

            log(`Building Docker image: ${imageName}`);
            await execStreamOrThrow(
                client,
                `cd ${releasePath} && docker build ${buildArgs} -t ${imageName} .`,
                'Docker build',
                onLog,
            );

            log(`Replacing container: ${containerName}`);
            await execStreamOrThrow(
                client,
                `docker rm -f ${containerName} >/dev/null 2>&1 || true && ${runCommand}`,
                'Docker run',
                onLog,
            );

            await execOrThrow(client, `ln -sfn ${releasePath} ${currentPath}`, 'Symlink switch');
            await executeReleaseCommand(client, project, containerName, true, false, log);

        } else if (strategy === 'railpack') {
            const imageName = getImageName(project);
            const containerName = getContainerName(project);

            // Detect runtime for port mapping
            log('Detecting project runtime...');
            const runtime = await detectRuntime(client, releasePath);
            let port = getRuntimePort(runtime);
            if (project.env && project.env.PORT) {
                port = project.env.PORT;
                log(`Overriding container port to ${port} from environment variables`);
            }
            log(`Detected runtime: ${runtime || 'unknown'} (port ${port})`);

            const envArgs = getDockerEnvArgs(project.env);
            const containerPort = project.env?.PORT || getRuntimePort(runtime);
            const portEnvArg = project.env?.PORT ? '' : ` -e "PORT=${containerPort}"`;

            // Find a free host port (avoids conflicts with port 80/Caddy)
            const hostPort = await findFreeHostPort(client, containerName, log);

            // Build with Railpack — it auto-detects everything and sets the start command
            // Ensure BuildKit is running (required by Railpack)
            await client.exec(`docker start buildkit 2>/dev/null || docker run --privileged -d --name buildkit --restart unless-stopped moby/buildkit`);
            log(`Building container image with Railpack: ${imageName}`);
            await execStreamOrThrow(
                client,
                `cd ${releasePath} && BUILDKIT_HOST=docker-container://buildkit railpack build . --name ${imageName}${envArgs}`,
                'Railpack build',
                onLog,
            );

            // Stop old container and run the new image
            log(`Replacing container: ${containerName}`);
            await execStreamOrThrow(
                client,
                `docker rm -f ${containerName} > /dev/null 2>&1 || true && docker run -d --name ${containerName}${envArgs}${portEnvArg} --network hylius --restart unless-stopped -p ${hostPort}:${containerPort} ${imageName}`,
                'Docker run',
                onLog,
            );

            await execOrThrow(client, `ln -sfn ${releasePath} ${currentPath}`, 'Symlink switch');

            // Post-start: configure Laravel for reverse-proxy HTTPS
            let isLaravel = false;
            if (runtime === 'laravel') {
                const isHttpsDeploy = !!(options.domains && options.domains.length > 0);
                isLaravel = await configureLaravelContainer(client, containerName, project, isHttpsDeploy, log);
            }
            await executeReleaseCommand(client, project, containerName, true, isLaravel, log);

            const appUrl = `http://${options.server.host}:${hostPort}`;
            log(`\n\x1b[36m🌐 Application URL: ${appUrl}\x1b[0m`);
            finalUrl = appUrl;

        } else if (strategy === 'nixpacks') {
            const imageName = getImageName(project);
            const containerName = getContainerName(project);

            // Detect runtime for port mapping
            log('Detecting project runtime...');
            const runtime = await detectRuntime(client, releasePath);
            let port = getRuntimePort(runtime);
            if (project.env && project.env.PORT) {
                port = project.env.PORT;
                log(`Overriding container port to ${port} from environment variables`);
            }
            log(`Detected runtime: ${runtime || 'unknown'} (port ${port})`);

            const envArgs = getDockerEnvArgs(project.env);
            const containerPort = project.env?.PORT || getRuntimePort(runtime);
            const portEnvArg = project.env?.PORT ? '' : ` -e "PORT=${containerPort}"`;

            // Find a free host port (avoids conflicts with port 80/Caddy)
            const hostPort = await findFreeHostPort(client, containerName, log);
            const buildArgs = getBuilderEnvArgs(project.env, '--env');

            // Build with Nixpacks
            log(`Building container image with Nixpacks: ${imageName}`);
            await execStreamOrThrow(
                client,
                `cd ${releasePath} && nixpacks build . --name ${imageName}${buildArgs}`,
                'Nixpacks build',
                onLog,
            );

            // Stop old container and run the new image
            log(`Replacing container: ${containerName}`);
            await execStreamOrThrow(
                client,
                `docker rm -f ${containerName} > /dev/null 2>&1 || true && docker run -d --name ${containerName}${envArgs}${portEnvArg} --network hylius --restart unless-stopped -p ${hostPort}:${containerPort} ${imageName}`,
                'Docker run',
                onLog,
            );

            await execOrThrow(client, `ln -sfn ${releasePath} ${currentPath}`, 'Symlink switch');

            // Post-start: configure Laravel for reverse-proxy HTTPS
            let isLaravel = false;
            if (runtime === 'laravel') {
                const isHttpsDeploy = !!(options.domains && options.domains.length > 0);
                isLaravel = await configureLaravelContainer(client, containerName, project, isHttpsDeploy, log);
            }
            await executeReleaseCommand(client, project, containerName, true, isLaravel, log);

            const appUrl = `http://${options.server.host}:${hostPort}`;
            log(`\n\x1b[36m🌐 Application URL: ${appUrl}\x1b[0m`);
            finalUrl = appUrl;

        } else {
            // PM2 strategy (no containerization)

            // Detect package manager
            let pkgManager = 'npm';
            log('Detecting package manager...');
            if (await hasFile(client, `${releasePath}/pnpm-lock.yaml`)) {
                pkgManager = 'pnpm';
            } else if (await hasFile(client, `${releasePath}/yarn.lock`)) {
                pkgManager = 'yarn';
            }
            log(`Detected package manager: ${pkgManager}`);

            log(`Installing dependencies using ${pkgManager}...`);
            await execStreamOrThrow(client, `cd ${releasePath} && ${pkgManager} install`, 'Install dependencies', onLog);

            // Determine build command: use explicit or auto-detect from package.json
            let buildCmd = project.buildCommand;
            log(`Build command from config: "${buildCmd || '(none)'}"`);
            if (!buildCmd) {
                try {
                    const { stdout: pkgStr } = await client.exec(`cat ${releasePath}/package.json`);
                    if (pkgStr) {
                        const pkg = JSON.parse(pkgStr);
                        if (pkg.scripts?.build) {
                            buildCmd = `${pkgManager} run build`;
                            log(`Auto-detected build script in package.json`);
                        } else {
                            log(`No build script found in package.json`);
                        }
                    }
                } catch (e: any) {
                    log(`Failed to read package.json for build detection: ${e.message}`);
                }
            }

            if (buildCmd) {
                log(`Running build: ${buildCmd}`);
                await execStreamOrThrow(client, `cd ${releasePath} && ${buildCmd}`, 'Project build', onLog);
            } else {
                log('No build command to run, skipping build step');
            }

            log('Switching symlink...');
            await execOrThrow(client, `ln -sfn ${releasePath} ${currentPath}`, 'Symlink switch');

            log('Restarting application...');
            let startScript = 'start';
            let extraArgs = '';
            try {
                const { stdout: packageJsonStr } = await client.exec(`cat ${currentPath}/package.json`);
                if (packageJsonStr) {
                    const pkg = JSON.parse(packageJsonStr);
                    const isVite = pkg.dependencies?.vite || pkg.devDependencies?.vite;

                    if (pkg.scripts) {
                        if (pkg.scripts.start) startScript = 'start';
                        else if (pkg.scripts.preview) {
                            startScript = 'run preview';
                            if (isVite) extraArgs = ' -- --host 0.0.0.0 --port 3000';
                        }
                        else if (pkg.scripts.dev) {
                            startScript = 'run dev';
                            if (isVite) extraArgs = ' -- --host 0.0.0.0 --port 3000';
                        }
                    }
                }
            } catch (e) {
                // Ignore parse errors, fallback to default 'start'
            }

            // Delete old PM2 process first to fully clear stale log history
            await client.exec(`pm2 delete "${project.name}" > /dev/null 2>&1 || true`);

            // Detect runtime early so we know the expected port for cleanup
            const runtime = await detectRuntime(client, releasePath);
            const defaultPort = getRuntimePort(runtime);

            // Wait for the old process to fully release its port, then kill
            // any lingering child process that might still hold the port
            await new Promise(res => setTimeout(res, 1500));
            await client.exec(`fuser -k ${defaultPort}/tcp > /dev/null 2>&1 || true`);
            // Also kill common Vite default port that may linger from previous deploys
            if (defaultPort !== '4173') {
                await client.exec(`fuser -k 4173/tcp > /dev/null 2>&1 || true`);
            }
            await new Promise(res => setTimeout(res, 500));

            const restartCmd = project.startCommand
                ? `cd ${currentPath} && ${project.startCommand}`
                : `cd ${currentPath} && (test -f ecosystem.config.js && pm2 start ecosystem.config.js --env production || pm2 start ${pkgManager} --name "${project.name}" -- ${startScript}${extraArgs})`;

            await execStreamOrThrow(client, restartCmd, 'PM2 restart', onLog);

            // --- Detect the actual listening port ---
            let appPort = '';

            // Method 1: Check actual listening port via ss (most reliable)
            for (let attempt = 0; attempt < 4 && !appPort; attempt++) {
                await new Promise(res => setTimeout(res, 2000));
                try {
                    const { stdout: pidStr } = await client.exec(`pm2 pid "${project.name}" 2>/dev/null`);
                    const pid = pidStr.trim();
                    if (pid && pid !== '0') {
                        // Check both the PM2 pid and its child processes (e.g. npm → node → vite)
                        const { stdout: portStr } = await client.exec(
                            `{ pgrep -P ${pid} 2>/dev/null; echo ${pid}; } | xargs -I{} ss -tlnp 2>/dev/null | grep 'pid=' | grep -oP '(?<=:)\\d{4,5}(?=\\s)' | head -1`
                        );
                        const detected = portStr.trim();
                        if (detected && /^\d{4,5}$/.test(detected)) {
                            appPort = detected;
                        }
                    }
                } catch {
                    // Ignore, retry
                }
            }

            // Method 2: Parse PM2 log files directly as fallback
            if (!appPort) {
                try {
                    const { stdout: logContent } = await client.exec(
                        `tail -20 ~/.pm2/logs/${project.name}-out.log 2>/dev/null`
                    );
                    if (logContent) {
                        const portMatches = [...logContent.matchAll(/(?:localhost|0\.0\.0\.0|127\.0\.0\.1):(\d{4,5})/gi)];
                        const fallbackMatches = [...logContent.matchAll(/port\s+(\d{4,5})/gi)];
                        if (portMatches.length > 0) {
                            appPort = portMatches[portMatches.length - 1][1];
                        } else if (fallbackMatches.length > 0) {
                            appPort = fallbackMatches[fallbackMatches.length - 1][1];
                        }
                    }
                } catch {
                    // Ignore
                }
            }

            if (!appPort) {
                appPort = defaultPort;
                log(`Port not detected, using default: ${defaultPort}`);
            }

            await executeReleaseCommand(client, project, currentPath, false, false, log);

            const appUrl = `http://${options.server.host}:${appPort}`;
            log(`\n\x1b[36m🌐 Application URL: ${appUrl}\x1b[0m`);
            finalUrl = appUrl;
        }

        // ─── Post-deploy: Open UFW port for direct IP access ───
        if (finalUrl) {
            try {
                const urlObj = new URL(finalUrl);
                const portToOpen = urlObj.port || '80';
                if (portToOpen !== '80' && portToOpen !== '443') {
                    log(`Opening UFW firewall for port ${portToOpen}...`);
                    await client.exec(`ufw allow ${portToOpen}/tcp > /dev/null 2>&1 || true`);
                }
            } catch (err) {
                // Ignore URL parse errors
            }
        }

        // ─── Post-deploy: Check port reachability & emit firewall warning ───
        if (finalUrl) {
            try {
                const urlObj = new URL(finalUrl);
                const portToCheck = urlObj.port || '80';

                if (portToCheck !== '80' && portToCheck !== '443') {
                    // Wait briefly for the application to finish binding
                    await new Promise(r => setTimeout(r, 3000));

                    // Verify the app is actually listening locally on the VPS
                    const { code: localCheck } = await client.exec(
                        `curl -sf --connect-timeout 5 --max-time 5 http://localhost:${portToCheck}/ > /dev/null 2>&1 || ` +
                        `curl -sf --connect-timeout 5 --max-time 5 http://127.0.0.1:${portToCheck}/ > /dev/null 2>&1 || ` +
                        `ss -tlnp 2>/dev/null | grep -q ":${portToCheck} " && exit 0 || exit 1`
                    );

                    if (localCheck === 0) {
                        // App is listening locally — warn about external/cloud firewall
                        log(`\n\x1b[33m[FIREWALL_WARNING] port=${portToCheck}\x1b[0m`);
                        log(`\x1b[33m⚠️  Your application is running on port ${portToCheck}, but your VPS provider's\x1b[0m`);
                        log(`\x1b[33m   cloud/network firewall may be blocking external access to this port.\x1b[0m`);
                        log(`\x1b[33m   UFW (OS-level firewall) has been configured, but many providers\x1b[0m`);
                        log(`\x1b[33m   (e.g. Fasthosts, Hetzner, DigitalOcean) have a separate cloud firewall\x1b[0m`);
                        log(`\x1b[33m   that must be configured from their dashboard/API.\x1b[0m`);
                        log(`\x1b[33m   → Open your VPS provider's firewall dashboard and allow TCP port ${portToCheck}.\x1b[0m\n`);
                    }
                }
            } catch (err) {
                // Non-critical — ignore reachability check failures
            }
        }

        // ─── Post-deploy: Update Caddy reverse proxy if domains are configured ───
        if (options.domains && options.domains.length > 0) {
            log('\nUpdating Caddy reverse proxy for configured domains...');
            try {
                const appPort = finalUrl
                    ? new URL(finalUrl).port || '3000'
                    : '3000';

                const domainConfigs: DomainConfig[] = options.domains.map(d => ({
                    hostname: d.hostname,
                    upstreamPort: d.upstreamPort || appPort,
                }));

                await configureCaddy(client, {
                    domains: domainConfigs,
                    tlsMode: options.tlsMode || 'production',
                }, onLog);

                // Update finalUrl to the first domain's HTTPS URL
                const protocol = options.tlsMode === 'internal' ? 'https' : 'https';
                finalUrl = `${protocol}://${options.domains[0].hostname}`;
                log(`\x1b[36m🔒 Domain URL: ${finalUrl}\x1b[0m`);
            } catch (err: any) {
                log(`\x1b[33mWarning: Caddy update failed (deploy still succeeded): ${err.message}\x1b[0m`);
            }
        }

        let commitHash = 'unknown';
        try {
            commitHash = (await execOrThrow(client, `cd ${currentPath} && git rev-parse HEAD`, 'Read commit hash')).trim();
        } catch {
            // Ignore for local bundle deployments which lack .git
        }
        const durationMs = Date.now() - startTime;
        log(`Deployment successful in ${durationMs}ms`);

        return {
            success: true,
            releaseId,
            commitHash,
            durationMs,
            url: finalUrl || `http://${options.server.host}:3000`
        };

    } catch (err: any) {
        log(`Deployment failed: ${err.message}`);
        return {
            success: false,
            releaseId,
            durationMs: Date.now() - startTime,
            error: err.message
        };
    } finally {
        client.end();
    }
}

/**
 * Deploy via connected VPS agent (no SSH).
 * Sends the full project config to the agent and streams logs back.
 * The agent executes the entire pipeline locally on the VPS.
 */
async function deployViaAgent(options: DeployOptions): Promise<DeployResult> {
    const { project, agent, onLog, domains, tlsMode, trigger } = options;
    const startTime = Date.now();
    const releaseId = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);

    const log = (msg: string) => { if (onLog) onLog(msg); };

    log(`\x1b[36m[Agent] Sending deploy command to VPS agent...\x1b[0m\n`);

    try {
        // Pre-deploy: force-remove any stale container to prevent "name already in use" errors.
        // Wrapped in try/catch — if the agent doesn't support 'exec', this fails silently
        // and the deploy payload's forceCleanup flag below handles it on the agent side.
        const preflightContainerName = project.containerName || `${project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-app`;
        log(`\x1b[36m[Agent] Pre-deploy cleanup: removing stale container ${preflightContainerName}...\x1b[0m\n`);
        try {
            await agent!.streamCommand('exec', { cmd: `docker rm -f ${preflightContainerName} > /dev/null 2>&1 || true` }, () => {});
        } catch {
            // Agent may not support 'exec' action — forceCleanup in deploy payload handles it
        }

        const { exitCode, resultData } = await agent!.streamCommand(
            'deploy',
            {
                project: {
                    name: project.name,
                    repoUrl: project.repoUrl,
                    branch: project.branch || 'main',
                    deployPath: project.deployPath,
                    buildCommand: project.buildCommand,
                    startCommand: project.startCommand,
                    deployStrategy: project.deployStrategy || 'auto',
                    env: project.env || {},
                    ghcrImage: project.ghcrImage,
                    dockerComposeYaml: project.dockerComposeYaml,
                    containerName: project.containerName,
                    dockerComposeFile: project.dockerComposeFile,
                    releaseCommand: project.releaseCommand,
                    analyticsScript: project.analyticsScript,
                },
                domains: domains || [],
                tlsMode: tlsMode || 'production',
                trigger,
            },
            log,
        );

        if (exitCode !== 0) {
            return {
                success: false,
                releaseId,
                durationMs: Date.now() - startTime,
                error: 'Agent deploy failed',
            };
        }

        // ─── Post-deploy: configure Laravel & run release command ─────────────
        // The agent runs the container but doesn't run post-start hooks.
        // Replicate what configureLaravelContainer + executeReleaseCommand do in SSH mode.
        try {
            const containerName = project.containerName || `${project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-app`;

            // Give the container a moment to fully start before exec'ing into it
            await new Promise(r => setTimeout(r, 3000));

            // Use a simpler exec helper
            const agentExecPost = async (cmd: string): Promise<string> => {
                let out = '';
                try {
                    await agent!.streamCommand('exec', { cmd }, (chunk: string) => { out += chunk; });
                } catch { /* ignore */ }
                return out;
            };

            const artisanVersion = await agentExecPost(`docker exec ${containerName} php artisan --version 2>/dev/null`);
            const isLaravel = artisanVersion.includes('Laravel');

            if (isLaravel) {
                log(`\n\x1b[36m[Post-deploy] Laravel detected — running post-start configuration...\x1b[0m\n`);
                const isHttpsDeploy = !!(domains && domains.length > 0);

                // Key generation (safe — only generates if not already set)
                await agentExecPost(`docker exec ${containerName} php artisan key:generate --force 2>/dev/null || true`);

                // Config & route caching
                await agentExecPost(`docker exec ${containerName} php artisan config:cache 2>/dev/null || true`);
                await agentExecPost(`docker exec ${containerName} php artisan route:cache 2>/dev/null || true`);
                await agentExecPost(`docker exec ${containerName} php artisan view:cache 2>/dev/null || true`);

                // Trust all proxies for reverse-proxy setups
                await agentExecPost(
                    `docker exec ${containerName} php artisan tinker --execute="app('Illuminate\\\\Http\\\\Request')::setTrustedProxies(['*'], \\\\Symfony\\\\Component\\\\HttpFoundation\\\\Request::HEADER_X_FORWARDED_FOR | \\\\Symfony\\\\Component\\\\HttpFoundation\\\\Request::HEADER_X_FORWARDED_HOST | \\\\Symfony\\\\Component\\\\HttpFoundation\\\\Request::HEADER_X_FORWARDED_PORT | \\\\Symfony\\\\Component\\\\HttpFoundation\\\\Request::HEADER_X_FORWARDED_PROTO | \\\\Symfony\\\\Component\\\\HttpFoundation\\\\Request::HEADER_X_FORWARDED_AWS_ELB);" 2>/dev/null || true`
                );

                if (isHttpsDeploy) {
                    await agentExecPost(`docker exec ${containerName} php artisan config:set --env session.secure_cookie true 2>/dev/null || true`);
                }

                // Install required PDO database driver if missing
                const dbConnection = project.env?.DB_CONNECTION || '';
                const databaseUrl = project.env?.DATABASE_URL || '';
                const needsPgsql = dbConnection === 'pgsql' || databaseUrl.startsWith('postgresql');
                const needsMysql = dbConnection === 'mysql' || databaseUrl.startsWith('mysql');

                if (needsPgsql) {
                    const hasPgsqlOut = await agentExecPost(`docker exec ${containerName} php -m 2>/dev/null | grep -qi pdo_pgsql && echo OK || echo MISSING`);
                    if (hasPgsqlOut.includes('MISSING')) {
                        log(`\x1b[36m[Post-deploy] Installing pdo_pgsql extension...\x1b[0m\n`);
                        await agentExecPost(
                            `docker exec ${containerName} sh -c "if command -v install-php-extensions >/dev/null 2>&1; then install-php-extensions pdo_pgsql; elif command -v docker-php-ext-install >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq libpq-dev >/dev/null 2>&1; docker-php-ext-install pdo_pgsql; else apt-get update -qq && apt-get install -y -qq php-pgsql >/dev/null 2>&1; fi" 2>/dev/null || true`
                        );
                        log(`\x1b[32m[Post-deploy] pdo_pgsql installed\x1b[0m\n`);
                    }
                } else if (needsMysql) {
                    const hasMysqlOut = await agentExecPost(`docker exec ${containerName} php -m 2>/dev/null | grep -qi pdo_mysql && echo OK || echo MISSING`);
                    if (hasMysqlOut.includes('MISSING')) {
                        log(`\x1b[36m[Post-deploy] Installing pdo_mysql extension...\x1b[0m\n`);
                        await agentExecPost(
                            `docker exec ${containerName} sh -c "if command -v install-php-extensions >/dev/null 2>&1; then install-php-extensions pdo_mysql; elif command -v docker-php-ext-install >/dev/null 2>&1; then docker-php-ext-install pdo_mysql; else apt-get update -qq && apt-get install -y -qq php-mysql >/dev/null 2>&1; fi" 2>/dev/null || true`
                        );
                        log(`\x1b[32m[Post-deploy] pdo_mysql installed\x1b[0m\n`);
                    }
                }

                // Restart the container so PHP-FPM reloads with the cached config
                // and all extensions active. Without this, the web server process
                // keeps its original startup state (stale extension list / stale config).
                log(`\x1b[36m[Post-deploy] Restarting container to reload PHP-FPM with fresh config...\x1b[0m\n`);
                await agentExecPost(`docker restart ${containerName} 2>/dev/null || true`);
                // Wait for the container to be back up and accepting connections
                await new Promise(r => setTimeout(r, 4000));
                log(`\x1b[32m[Post-deploy] Container restarted\x1b[0m\n`);

                // Determine and run release command (migrate by default for Laravel)
                const releaseCmd = project.releaseCommand || 'php artisan migrate --force';
                log(`\x1b[36m[Post-deploy] Running release command: ${releaseCmd}\x1b[0m\n`);
                const maxRetries = 10;
                for (let i = 1; i <= maxRetries; i++) {
                    const migrateOut = await agentExecPost(
                        `docker exec ${containerName} sh -c "${releaseCmd.replace(/"/g, '\\"')}" 2>&1`
                    );
                    if (migrateOut.toLowerCase().includes('nothing to migrate') ||
                        migrateOut.toLowerCase().includes('running') ||
                        migrateOut.toLowerCase().includes('migrated') ||
                        !migrateOut.toLowerCase().includes('error')) {
                        log(`\x1b[32m[Post-deploy] ✅ ${releaseCmd} completed\x1b[0m\n`);
                        if (migrateOut.trim()) log(migrateOut);
                        break;
                    }
                    if (i === maxRetries) {
                        log(`\x1b[33m[Post-deploy] ⚠️  Release command failed after ${maxRetries} attempts: ${migrateOut}\x1b[0m\n`);
                    } else {
                        log(`\x1b[33m[Post-deploy] Release command attempt ${i}/${maxRetries} failed, retrying in 3s...\x1b[0m\n`);
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }

                log(`\x1b[32m[Post-deploy] ✅ Laravel post-start configuration complete\x1b[0m\n`);
            } else if (project.releaseCommand) {
                // Non-Laravel project with a custom release command
                log(`\n\x1b[36m[Post-deploy] Running release command: ${project.releaseCommand}\x1b[0m\n`);
                const releaseOut = await agentExecPost(
                    `docker exec ${containerName} sh -c "${project.releaseCommand.replace(/"/g, '\\"')}" 2>&1`
                );
                if (releaseOut.trim()) log(releaseOut);
            }
        } catch (postErr: any) {
            // Post-deploy failures are non-fatal — container is running, just log the warning
            log(`\x1b[33m[Post-deploy] Warning: post-deploy hook failed: ${postErr.message}\x1b[0m\n`);
        }

        // Parse result JSON embedded in the done message
        let url: string | undefined;
        if (resultData) {
            try {
                const result = JSON.parse(resultData);
                url = result.url;
                if (result.releaseId) {
                    return {
                        success: true,
                        releaseId: result.releaseId,
                        durationMs: Date.now() - startTime,
                        url: fixAgentUrl(url, options.server.host),
                    };
                }
            } catch { /* resultData was not JSON, ignore */ }
        }

        // If the agent didn't return a URL, try to extract it from the streamed logs
        // (the agent logs "Application URL: http://localhost:PORT")
        if (!url) {
            url = `http://${options.server.host}:3000`;
        }

        return {
            success: true,
            releaseId,
            durationMs: Date.now() - startTime,
            url: fixAgentUrl(url, options.server.host),
        };

    } catch (err: any) {
        log(`\x1b[31m[Agent] Deploy command failed: ${err.message}\x1b[0m\n`);
        return {
            success: false,
            releaseId,
            durationMs: Date.now() - startTime,
            error: err.message,
        };
    }
}
