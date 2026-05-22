import {
    DatabaseProvisionOptions,
    DatabaseProvisionResult,
    DatabaseDestroyOptions,
    DatabaseDestroyResult,
    DatabaseStatusOptions,
    DatabaseStatusResult,
    DatabaseBackupOptions,
    DatabaseBackupResult,
    DatabaseLogsOptions,
    DatabaseLogsResult,
    DatabaseEngine,
    AgentConfig,
} from './types.js';
import { SSHClient } from './ssh/client.js';

// ─── Agent exec helpers (mirrors setup.ts) ────────────────────────────────────

async function agentExec(agent: AgentConfig, cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
    let stdout = '';
    try {
        const result = await agent.streamCommand('exec', { cmd }, (chunk) => { stdout += chunk; });
        return { stdout, stderr: '', code: result.exitCode ?? 0 };
    } catch {
        return { stdout, stderr: '', code: 1 };
    }
}

async function agentStream(agent: AgentConfig, cmd: string, onLog?: (chunk: string) => void): Promise<number> {
    try {
        const result = await agent.streamCommand('exec', { cmd }, (chunk) => { if (onLog) onLog(chunk); });
        return result.exitCode ?? 0;
    } catch {
        return 1;
    }
}

// ─── Port Ranges per Engine ───────────────────────────────────────────────────

const PORT_RANGES: Record<DatabaseEngine, { start: number; end: number; container: number }> = {
    POSTGRES: { start: 5432, end: 5532, container: 5432 },
    MYSQL:    { start: 3306, end: 3406, container: 3306 },
    REDIS:    { start: 6379, end: 6479, container: 6379 },
    MONGODB:  { start: 27017, end: 27117, container: 27017 },
};

// ─── Default Version per Engine ───────────────────────────────────────────────

const DEFAULT_VERSIONS: Record<DatabaseEngine, string> = {
    POSTGRES: '16',
    MYSQL:    '8',
    REDIS:    '7',
    MONGODB:  '7',
};

// ─── Docker Image per Engine ──────────────────────────────────────────────────

function getDockerImage(engine: DatabaseEngine, version: string): string {
    switch (engine) {
        case 'POSTGRES': return `postgres:${version}-alpine`;
        case 'MYSQL':    return `mysql:${version}`;
        case 'REDIS':    return `redis:${version}-alpine`;
        case 'MONGODB':  return `mongo:${version}`;
    }
}

// ─── Connection String Builder ────────────────────────────────────────────────

function buildConnectionString(
    engine: DatabaseEngine,
    dbUser: string,
    password: string,
    port: number,
    dbName: string,
): string {
    const encodedPass = encodeURIComponent(password);
    switch (engine) {
        case 'POSTGRES':
            return `postgresql://${dbUser}:${encodedPass}@localhost:${port}/${dbName}`;
        case 'MYSQL':
            return `mysql://${dbUser}:${encodedPass}@localhost:${port}/${dbName}`;
        case 'REDIS':
            return `redis://:${encodedPass}@localhost:${port}`;
        case 'MONGODB':
            return `mongodb://${dbUser}:${encodedPass}@localhost:${port}/${dbName}?authSource=admin`;
    }
}

// ─── Container Name ───────────────────────────────────────────────────────────

function getContainerName(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return `hylius-db-${slug}`;
}

// ─── Port Finder ──────────────────────────────────────────────────────────────

async function findFreePort(client: SSHClient | null, engine: DatabaseEngine, agent?: AgentConfig): Promise<number> {
    const range = PORT_RANGES[engine];
    const stdout = agent
        ? (await agentExec(agent, `docker ps --format '{{.Ports}}'`)).stdout
        : (await client!.exec(`docker ps --format '{{.Ports}}'`)).stdout;
    const usedPorts = new Set<number>();

    for (const match of stdout.matchAll(/:(\d+)->/g)) {
        usedPorts.add(parseInt(match[1], 10));
    }

    for (let port = range.start; port <= range.end; port++) {
        if (!usedPorts.has(port)) return port;
    }

    throw new Error(`No free port found in range ${range.start}-${range.end} for ${engine}`);
}

// ─── provisionDatabase ────────────────────────────────────────────────────────

/**
 * Provisions a new managed database container on a VPS via SSH.
 * The container binds to 127.0.0.1 only (no external exposure).
 * Data persists in a named Docker volume.
 */
export async function provisionDatabase(options: DatabaseProvisionOptions): Promise<DatabaseProvisionResult> {
    const { server, name, engine, password, onLog } = options;
    const agent = (options as any).agent as AgentConfig | undefined;
    const useAgent = !!agent;
    const startTime = Date.now();
    const client = useAgent ? null : new SSHClient(server);

    const version = options.version || DEFAULT_VERSIONS[engine];
    const containerName = getContainerName(name);
    const dbName = options.dbName || `${name.replace(/[^a-z0-9]/g, '_')}_db`;
    const dbUser = options.dbUser || `${name.replace(/[^a-z0-9]/g, '_')}_user`;
    const image = getDockerImage(engine, version);
    const volumeName = `${containerName}-data`;
    const containerPort = PORT_RANGES[engine].container;

    const log = (msg: string) => { if (onLog) onLog(msg + '\n'); };

    try {
        if (useAgent) {
            log(`\x1b[35m[Agent] Provisioning database via VPS agent (no SSH)\x1b[0m`);
        } else {
            log(`\x1b[36mConnecting to ${server.host}...\x1b[0m`);
            await client!.connect();
        }

        log(`Finding free port for ${engine}...`);
        const port = await findFreePort(client, engine, agent);
        log(`\x1b[32mAssigned port: ${port}\x1b[0m`);

        log(`Pulling image: ${image}`);
        const pullCode = useAgent
            ? await agentStream(agent!, `docker pull ${image}`, onLog)
            : await client!.execStream(`docker pull ${image}`, onLog, onLog);
        if (pullCode !== 0) throw new Error(`Failed to pull image: ${image}`);

        // Remove any existing container with same name (idempotent)
        // Ensure the shared Hylius Docker network exists
        if (useAgent) {
            await agentExec(agent!, `docker rm -f ${containerName} > /dev/null 2>&1 || true`);
            await agentExec(agent!, `docker network create hylius 2>/dev/null || true`);
        } else {
            await client!.exec(`docker rm -f ${containerName} > /dev/null 2>&1 || true`);
            await client!.exec(`docker network create hylius 2>/dev/null || true`);
        }

        log(`Starting ${engine} container: ${containerName}`);
        let dockerRunCmd: string;

        switch (engine) {
            case 'POSTGRES':
                dockerRunCmd = [
                    `docker run -d`,
                    `--name ${containerName}`,
                    `--network hylius`,
                    `--restart unless-stopped`,
                    `-e POSTGRES_DB=${dbName}`,
                    `-e POSTGRES_USER=${dbUser}`,
                    `-e POSTGRES_PASSWORD=${password.replace(/'/g, "'\\''")}`,
                    `-p 127.0.0.1:${port}:${containerPort}`,
                    `-v ${volumeName}:/var/lib/postgresql/data`,
                    `--health-cmd="pg_isready -U ${dbUser} -d ${dbName}"`,
                    `--health-interval=10s`,
                    `--health-timeout=5s`,
                    `--health-retries=5`,
                    image,
                ].join(' ');
                break;

            case 'MYSQL':
                dockerRunCmd = [
                    `docker run -d`,
                    `--name ${containerName}`,
                    `--network hylius`,
                    `--restart unless-stopped`,
                    `-e MYSQL_DATABASE=${dbName}`,
                    `-e MYSQL_USER=${dbUser}`,
                    `-e MYSQL_PASSWORD=${password.replace(/'/g, "'\\''")}`,
                    `-e MYSQL_ROOT_PASSWORD=${password.replace(/'/g, "'\\''")}`,
                    `-p 127.0.0.1:${port}:${containerPort}`,
                    `-v ${volumeName}:/var/lib/mysql`,
                    `--health-cmd="mysqladmin ping -h localhost -u root -p${password.replace(/'/g, "'\\''")} --silent"`,
                    `--health-interval=10s`,
                    `--health-timeout=5s`,
                    `--health-retries=5`,
                    image,
                ].join(' ');
                break;

            case 'REDIS':
                dockerRunCmd = [
                    `docker run -d`,
                    `--name ${containerName}`,
                    `--network hylius`,
                    `--restart unless-stopped`,
                    `-p 127.0.0.1:${port}:${containerPort}`,
                    `-v ${volumeName}:/data`,
                    `--health-cmd="redis-cli -a '${password.replace(/'/g, "'\\''")}' ping"`,
                    `--health-interval=10s`,
                    `--health-timeout=5s`,
                    `--health-retries=5`,
                    image,
                    `redis-server --requirepass '${password.replace(/'/g, "'\\''")}' --appendonly yes`,
                ].join(' ');
                break;

            case 'MONGODB':
                dockerRunCmd = [
                    `docker run -d`,
                    `--name ${containerName}`,
                    `--network hylius`,
                    `--restart unless-stopped`,
                    `-e MONGO_INITDB_ROOT_USERNAME=${dbUser}`,
                    `-e MONGO_INITDB_ROOT_PASSWORD='${password.replace(/'/g, "'\\''")}'`,
                    `-e MONGO_INITDB_DATABASE=${dbName}`,
                    `-p 127.0.0.1:${port}:${containerPort}`,
                    `-v ${volumeName}:/data/db`,
                    `--health-cmd="mongosh --eval 'db.runCommand({ping:1})' --quiet"`,
                    `--health-interval=10s`,
                    `--health-timeout=5s`,
                    `--health-retries=5`,
                    image,
                ].join(' ');
                break;
        }

        const { code: runCode, stderr } = useAgent
            ? await agentExec(agent!, dockerRunCmd)
            : await client!.exec(dockerRunCmd);
        if (runCode !== 0) throw new Error(`Failed to start container: ${stderr}`);

        log(`\x1b[32m✅ ${engine} container started successfully on port ${port}\x1b[0m`);

        const connectionString = buildConnectionString(engine, dbUser, password, port, dbName);
        log(`\x1b[36m🔗 Connection: ${engine.toLowerCase()}://...@localhost:${port}/${engine === 'REDIS' ? '' : dbName}\x1b[0m`);

        return {
            success: true,
            containerName,
            port,
            dbName,
            dbUser,
            connectionString,
            durationMs: Date.now() - startTime,
        };
    } catch (err: any) {
        log(`\x1b[31mDatabase provisioning failed: ${err.message}\x1b[0m`);
        return {
            success: false,
            containerName,
            port: 0,
            dbName,
            dbUser,
            connectionString: '',
            error: err.message,
            durationMs: Date.now() - startTime,
        };
    } finally {
        if (!useAgent && client) client.end();
    }
}

// ─── destroyDatabase ──────────────────────────────────────────────────────────

/**
 * Stops and removes a managed database container.
 * By default, the Docker volume (data) is retained. Set removeVolume=true for full cleanup.
 */
export async function destroyDatabase(options: DatabaseDestroyOptions): Promise<DatabaseDestroyResult> {
    const { server, containerName, removeVolume = false, onLog } = options;
    const agent = (options as any).agent as AgentConfig | undefined;
    const useAgent = !!agent;
    const startTime = Date.now();
    const client = useAgent ? null : new SSHClient(server);

    const log = (msg: string) => { if (onLog) onLog(msg + '\n'); };

    try {
        if (!useAgent) await client!.connect();

        log(`Stopping and removing container: ${containerName}`);
        if (useAgent) {
            await agentExec(agent!, `docker rm -f ${containerName} > /dev/null 2>&1 || true`);
        } else {
            await client!.exec(`docker rm -f ${containerName} > /dev/null 2>&1 || true`);
        }

        if (removeVolume) {
            const volumeName = `${containerName}-data`;
            log(`Removing volume: ${volumeName}`);
            if (useAgent) {
                await agentExec(agent!, `docker volume rm ${volumeName} > /dev/null 2>&1 || true`);
            } else {
                await client!.exec(`docker volume rm ${volumeName} > /dev/null 2>&1 || true`);
            }
            log('\x1b[33mWarning: Database volume removed. Data is permanently deleted.\x1b[0m');
        } else {
            log(`Volume retained (data preserved). Use removeVolume=true to delete data.`);
        }

        log(`\x1b[32m✅ Database container destroyed\x1b[0m`);
        return { success: true, durationMs: Date.now() - startTime };
    } catch (err: any) {
        log(`\x1b[31mFailed to destroy database: ${err.message}\x1b[0m`);
        return { success: false, error: err.message, durationMs: Date.now() - startTime };
    } finally {
        if (!useAgent && client) client.end();
    }
}

// ─── getDatabaseStatus ────────────────────────────────────────────────────────

/**
 * Checks the live status of a database container via docker inspect over SSH.
 */
export async function getDatabaseStatus(options: DatabaseStatusOptions): Promise<DatabaseStatusResult> {
    const { server, containerName } = options;
    const client = new SSHClient(server);

    try {
        await client.connect();

        const { stdout, code } = await client.exec(
            `docker inspect --format='{{.State.Running}}|{{.State.StartedAt}}|{{.HostConfig.PortBindings}}' ${containerName} 2>/dev/null`
        );

        if (code !== 0 || !stdout.trim()) {
            return { running: false, containerName };
        }

        const parts = stdout.trim().split('|');
        const running = parts[0] === 'true';

        // Extract mapped host port from PortBindings (format varies by docker version)
        const { stdout: portOut } = await client.exec(
            `docker port ${containerName} 2>/dev/null | grep -oP '0\\.0\\.0\\.0:\\K\\d+|127\\.0\\.0\\.1:\\K\\d+' | head -1`
        );
        const port = portOut.trim() ? parseInt(portOut.trim(), 10) : undefined;

        // Calculate uptime
        let uptime: string | undefined;
        if (running && parts[1]) {
            const startedAt = new Date(parts[1]);
            const uptimeMs = Date.now() - startedAt.getTime();
            const uptimeSecs = Math.floor(uptimeMs / 1000);
            if (uptimeSecs < 60) uptime = `${uptimeSecs}s`;
            else if (uptimeSecs < 3600) uptime = `${Math.floor(uptimeSecs / 60)}m`;
            else uptime = `${Math.floor(uptimeSecs / 3600)}h ${Math.floor((uptimeSecs % 3600) / 60)}m`;
        }

        return { running, containerName, port, uptime };
    } catch (err: any) {
        return { running: false, containerName, error: err.message };
    } finally {
        client.end();
    }
}

// ─── backupDatabase ───────────────────────────────────────────────────────────

/**
 * Creates a compressed SQL dump inside the container and saves it on the VPS.
 * Backup path: /opt/hylius/backups/{containerName}-{timestamp}.sql.gz
 * Redis: uses BGSAVE to create an RDB snapshot.
 */
export async function backupDatabase(options: DatabaseBackupOptions): Promise<DatabaseBackupResult> {
    const { server, containerName, engine, dbName, dbUser, password, onLog } = options;
    const startTime = Date.now();
    const client = new SSHClient(server);

    const log = (msg: string) => { if (onLog) onLog(msg + '\n'); };
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const backupDir = '/opt/hylius/backups';
    const backupFile = `${backupDir}/${containerName}-${timestamp}.sql.gz`;

    try {
        await client.connect();

        log(`Creating backup directory: ${backupDir}`);
        await client.exec(`mkdir -p ${backupDir}`);

        let backupCmd: string;
        switch (engine) {
            case 'POSTGRES':
                backupCmd = `docker exec ${containerName} pg_dump -U ${dbUser} ${dbName} | gzip > ${backupFile}`;
                break;
            case 'MYSQL':
                backupCmd = `docker exec ${containerName} mysqldump -u root -p'${password.replace(/'/g, "'\\''")}' ${dbName} | gzip > ${backupFile}`;
                break;
            case 'REDIS':
                // Trigger BGSAVE and copy the RDB file
                await client.exec(`docker exec ${containerName} redis-cli -a '${password.replace(/'/g, "'\\''")}' BGSAVE`);
                // Wait briefly for BGSAVE to complete
                await new Promise(res => setTimeout(res, 2000));
                backupCmd = `docker exec ${containerName} cat /data/dump.rdb | gzip > ${backupFile}`;
                break;
            case 'MONGODB':
                backupCmd = `docker exec ${containerName} mongodump --username=${dbUser} --password='${password.replace(/'/g, "'\\''")}' --authenticationDatabase=admin --db=${dbName} --archive --gzip > ${backupFile}`;
                break;
        }

        log(`Running backup for ${engine} database: ${dbName}`);
        const { code, stderr } = await client.exec(backupCmd);
        if (code !== 0) throw new Error(`Backup command failed: ${stderr}`);

        // Get file size
        const { stdout: sizeOut } = await client.exec(`stat -c%s ${backupFile} 2>/dev/null || echo 0`);
        const sizeBytes = parseInt(sizeOut.trim(), 10) || 0;

        log(`\x1b[32m✅ Backup created: ${backupFile} (${Math.round(sizeBytes / 1024)}KB)\x1b[0m`);
        return { success: true, backupPath: backupFile, sizeBytes, durationMs: Date.now() - startTime };
    } catch (err: any) {
        log(`\x1b[31mBackup failed: ${err.message}\x1b[0m`);
        return { success: false, backupPath: '', error: err.message, durationMs: Date.now() - startTime };
    } finally {
        client.end();
    }
}

// ─── getDatabaseLogs ──────────────────────────────────────────────────────────

/**
 * Fetches recent logs from a database container via `docker logs`.
 */
export async function getDatabaseLogs(options: DatabaseLogsOptions): Promise<DatabaseLogsResult> {
    const { server, containerName, tailLines = 100 } = options;
    const client = new SSHClient(server);

    try {
        await client.connect();
        const { stdout, stderr, code } = await client.exec(
            `docker logs --tail ${tailLines} ${containerName} 2>&1`
        );
        if (code !== 0 && !stdout && !stderr) {
            return { success: false, logs: '', error: `Container ${containerName} not found` };
        }
        return { success: true, logs: stdout + stderr };
    } catch (err: any) {
        return { success: false, logs: '', error: err.message };
    } finally {
        client.end();
    }
}

// ─── buildConnectionStringFromParts (re-export helper for dashboard) ──────────

/**
 * Builds a connection string from individual parts (used by dashboard service
 * when reconstructing from decrypted DB credentials).
 */
export function buildDbConnectionString(
    engine: DatabaseEngine,
    dbUser: string,
    password: string,
    port: number,
    dbName: string,
): string {
    return buildConnectionString(engine, dbUser, password, port, dbName);
}

export function buildInternalDbConnectionString(
    engine: DatabaseEngine,
    dbUser: string,
    password: string,
    dbName: string,
    containerName: string
): string {
    const encodedPass = encodeURIComponent(password);
    const port = PORT_RANGES[engine].container;
    switch (engine) {
        case 'POSTGRES':
            return `postgresql://${dbUser}:${encodedPass}@${containerName}:${port}/${dbName}`;
        case 'MYSQL':
            return `mysql://${dbUser}:${encodedPass}@${containerName}:${port}/${dbName}`;
        case 'REDIS':
            return `redis://:${encodedPass}@${containerName}:${port}`;
        case 'MONGODB':
            return `mongodb://${dbUser}:${encodedPass}@${containerName}:${port}/${dbName}?authSource=admin`;
    }
}
