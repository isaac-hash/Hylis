/* eslint-disable no-console, @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any */
import { prisma } from './prisma';
import { decrypt } from './crypto.service';
import { agentGateway } from './agent-gateway.service';
// @ts-ignore - Local workspace package
import { SSHClient, ServerConfig } from '@hylius/core';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DatabaseMetricSnapshot {
    connections: number;
    queryThroughput: number;   // Cumulative counter
    slowQueryCount: number;
    slowQueries: SlowQuery[];
    sizeBytes: number;
}

export interface SlowQuery {
    query: string;
    durationSecs: number;
    state?: string;
    pid?: string;
}

interface ExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

// ─── Agent / SSH exec helpers ─────────────────────────────────────────────────

async function agentExec(serverId: string, cmd: string): Promise<ExecResult> {
    let stdout = '';
    try {
        const result = await agentGateway.streamCommand(serverId, 'exec', { cmd }, (chunk) => { stdout += chunk; });
        return { stdout, stderr: '', code: (result as any).exitCode ?? 0 };
    } catch {
        return { stdout, stderr: '', code: 1 };
    }
}

async function getServerConfig(serverId: string): Promise<ServerConfig & { id: string; connectionMode?: string }> {
    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new Error('Server not found');

    let privateKey = '';
    if (server.privateKeyEncrypted && server.keyIv) {
        try { privateKey = decrypt(server.privateKeyEncrypted, server.keyIv); } catch {}
    }

    return {
        id: server.id,
        host: server.ip,
        port: server.port,
        username: server.username,
        privateKey: privateKey.includes('BEGIN') ? privateKey : undefined,
        password: privateKey && !privateKey.includes('BEGIN') ? privateKey : undefined,
        connectionMode: (server as any).connectionMode,
    };
}

async function execOnServer(serverId: string, cmd: string): Promise<ExecResult> {
    // Prefer agent if connected
    if (agentGateway.isConnected(serverId)) {
        return agentExec(serverId, cmd);
    }

    // SSH fallback
    const config = await getServerConfig(serverId);
    const client = new SSHClient(config);
    try {
        await client.connect();
        const result = await client.exec(cmd);
        return result;
    } finally {
        client.end();
    }
}

// ─── Engine-Specific Metric Collection ────────────────────────────────────────

async function collectPostgresMetrics(serverId: string, containerName: string, dbUser: string, dbName: string): Promise<DatabaseMetricSnapshot> {
    const slowQueries: SlowQuery[] = [];

    // Connections
    const connResult = await execOnServer(serverId,
        `docker exec ${containerName} psql -U ${dbUser} -d ${dbName} -t -A -c "SELECT count(*) FROM pg_stat_activity WHERE state IS NOT NULL;"`
    );
    const connections = parseInt(connResult.stdout.trim(), 10) || 0;

    // Query throughput (cumulative)
    const tpResult = await execOnServer(serverId,
        `docker exec ${containerName} psql -U ${dbUser} -d ${dbName} -t -A -c "SELECT COALESCE(sum(xact_commit + xact_rollback), 0) FROM pg_stat_database;"`
    );
    const queryThroughput = parseInt(tpResult.stdout.trim(), 10) || 0;

    // Database size
    const sizeResult = await execOnServer(serverId,
        `docker exec ${containerName} psql -U ${dbUser} -d ${dbName} -t -A -c "SELECT pg_database_size(current_database());"`
    );
    const sizeBytes = parseInt(sizeResult.stdout.trim(), 10) || 0;

    // Slow queries (running > 5s)
    const slowResult = await execOnServer(serverId,
        `docker exec ${containerName} psql -U ${dbUser} -d ${dbName} -t -A -c "SELECT pid, query, state, extract(epoch from now() - query_start)::int as duration FROM pg_stat_activity WHERE state = 'active' AND now() - query_start > interval '5 seconds' AND query NOT LIKE '%pg_stat_activity%';"`
    );
    if (slowResult.stdout.trim()) {
        for (const line of slowResult.stdout.trim().split('\n')) {
            const parts = line.split('|');
            if (parts.length >= 4) {
                slowQueries.push({
                    pid: parts[0],
                    query: parts[1].slice(0, 200), // Truncate long queries
                    state: parts[2],
                    durationSecs: parseInt(parts[3], 10) || 0,
                });
            }
        }
    }

    return { connections, queryThroughput, slowQueryCount: slowQueries.length, slowQueries, sizeBytes };
}

async function collectMysqlMetrics(serverId: string, containerName: string, password: string, dbName: string): Promise<DatabaseMetricSnapshot> {
    const slowQueries: SlowQuery[] = [];
    const escapedPass = password.replace(/'/g, "'\\''");

    // Connections
    const connResult = await execOnServer(serverId,
        `docker exec ${containerName} mysql -u root -p'${escapedPass}' -N -e "SHOW STATUS LIKE 'Threads_connected';" 2>/dev/null`
    );
    const connMatch = connResult.stdout.match(/Threads_connected\s+(\d+)/);
    const connections = connMatch ? parseInt(connMatch[1], 10) : 0;

    // Query throughput
    const tpResult = await execOnServer(serverId,
        `docker exec ${containerName} mysql -u root -p'${escapedPass}' -N -e "SHOW STATUS LIKE 'Queries';" 2>/dev/null`
    );
    const tpMatch = tpResult.stdout.match(/Queries\s+(\d+)/);
    const queryThroughput = tpMatch ? parseInt(tpMatch[1], 10) : 0;

    // Database size
    const sizeResult = await execOnServer(serverId,
        `docker exec ${containerName} mysql -u root -p'${escapedPass}' -N -e "SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.TABLES WHERE table_schema = '${dbName}';" 2>/dev/null`
    );
    const sizeBytes = parseInt(sizeResult.stdout.trim(), 10) || 0;

    // Slow queries (running > 5s)
    const slowResult = await execOnServer(serverId,
        `docker exec ${containerName} mysql -u root -p'${escapedPass}' -N -e "SELECT id, info, time FROM information_schema.processlist WHERE time > 5 AND command != 'Sleep' AND info IS NOT NULL;" 2>/dev/null`
    );
    if (slowResult.stdout.trim()) {
        for (const line of slowResult.stdout.trim().split('\n')) {
            const parts = line.split('\t');
            if (parts.length >= 3) {
                slowQueries.push({
                    pid: parts[0],
                    query: (parts[1] || '').slice(0, 200),
                    durationSecs: parseInt(parts[2], 10) || 0,
                });
            }
        }
    }

    return { connections, queryThroughput, slowQueryCount: slowQueries.length, slowQueries, sizeBytes };
}

async function collectRedisMetrics(serverId: string, containerName: string, password: string): Promise<DatabaseMetricSnapshot> {
    const slowQueries: SlowQuery[] = [];
    const escapedPass = password.replace(/'/g, "'\\''");

    // All metrics from INFO command
    const infoResult = await execOnServer(serverId,
        `docker exec ${containerName} redis-cli -a '${escapedPass}' INFO 2>/dev/null`
    );
    const info = infoResult.stdout;

    // Connections
    const connMatch = info.match(/connected_clients:(\d+)/);
    const connections = connMatch ? parseInt(connMatch[1], 10) : 0;

    // Query throughput
    const tpMatch = info.match(/total_commands_processed:(\d+)/);
    const queryThroughput = tpMatch ? parseInt(tpMatch[1], 10) : 0;

    // Database size (used_memory)
    const sizeMatch = info.match(/used_memory:(\d+)/);
    const sizeBytes = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;

    // Slow queries from SLOWLOG
    const slowResult = await execOnServer(serverId,
        `docker exec ${containerName} redis-cli -a '${escapedPass}' SLOWLOG GET 10 2>/dev/null`
    );
    // Redis SLOWLOG output format varies; count entries
    const slowLogLines = slowResult.stdout.trim().split('\n').filter(l => l.trim());
    // Each slowlog entry has multiple lines; entries start with a number-only line (the ID)
    let slowCount = 0;
    for (const line of slowLogLines) {
        if (/^\d+\)/.test(line.trim())) slowCount++;
    }

    return { connections, queryThroughput, slowQueryCount: slowCount, slowQueries, sizeBytes };
}

async function collectMongoMetrics(serverId: string, containerName: string, dbUser: string, password: string, dbName: string): Promise<DatabaseMetricSnapshot> {
    const slowQueries: SlowQuery[] = [];
    const escapedPass = password.replace(/'/g, "'\\''");

    // Server status — connections + opcounters in one call
    const statusResult = await execOnServer(serverId,
        `docker exec ${containerName} mongosh --username ${dbUser} --password '${escapedPass}' --authenticationDatabase admin --quiet --eval "JSON.stringify(db.getSiblingDB('admin').serverStatus({connections:1, opcounters:1}))"`
    );

    let connections = 0;
    let queryThroughput = 0;
    try {
        const status = JSON.parse(statusResult.stdout.trim());
        connections = status.connections?.current || 0;
        const ops = status.opcounters || {};
        queryThroughput = (ops.insert || 0) + (ops.query || 0) + (ops.update || 0) + (ops.delete || 0) + (ops.getmore || 0) + (ops.command || 0);
    } catch {}

    // Database size
    const sizeResult = await execOnServer(serverId,
        `docker exec ${containerName} mongosh --username ${dbUser} --password '${escapedPass}' --authenticationDatabase admin --quiet --eval "JSON.stringify(db.getSiblingDB('${dbName}').stats())"`
    );
    let sizeBytes = 0;
    try {
        const stats = JSON.parse(sizeResult.stdout.trim());
        sizeBytes = stats.dataSize || 0;
    } catch {}

    // Slow queries (currentOp)
    const slowResult = await execOnServer(serverId,
        `docker exec ${containerName} mongosh --username ${dbUser} --password '${escapedPass}' --authenticationDatabase admin --quiet --eval "JSON.stringify(db.getSiblingDB('admin').currentOp({active: true, secs_running: {\\$gt: 5}}))"`
    );
    try {
        const ops = JSON.parse(slowResult.stdout.trim());
        if (ops.inprog) {
            for (const op of ops.inprog) {
                slowQueries.push({
                    pid: String(op.opid || ''),
                    query: JSON.stringify(op.command || op.query || {}).slice(0, 200),
                    durationSecs: op.secs_running || 0,
                    state: op.op || 'unknown',
                });
            }
        }
    } catch {}

    return { connections, queryThroughput, slowQueryCount: slowQueries.length, slowQueries, sizeBytes };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Collect live metrics from a running database container.
 * Returns both the snapshot and the raw slow queries.
 */
export async function collectMetrics(databaseId: string): Promise<DatabaseMetricSnapshot> {
    // @ts-ignore
    const db = await prisma.database.findUnique({ where: { id: databaseId } });
    if (!db || !db.containerName) throw new Error('Database not found or has no container');
    if (db.status !== 'RUNNING') throw new Error('Database is not running');

    // Decrypt password
    let password = '';
    if (db.passwordEncrypted && db.passwordIv) {
        try { password = decrypt(db.passwordEncrypted, db.passwordIv); } catch {}
    }

    switch (db.engine) {
        case 'POSTGRES':
            return collectPostgresMetrics(db.serverId, db.containerName, db.dbUser || 'postgres', db.dbName || 'postgres');
        case 'MYSQL':
            return collectMysqlMetrics(db.serverId, db.containerName, password, db.dbName || 'mysql');
        case 'REDIS':
            return collectRedisMetrics(db.serverId, db.containerName, password);
        case 'MONGODB':
            return collectMongoMetrics(db.serverId, db.containerName, db.dbUser || 'admin', password, db.dbName || 'admin');
        default:
            throw new Error(`Unsupported engine: ${db.engine}`);
    }
}

/**
 * Collect metrics and persist a snapshot to DatabaseMetric table.
 */
export async function collectAndPersistMetrics(databaseId: string): Promise<DatabaseMetricSnapshot | null> {
    try {
        const snapshot = await collectMetrics(databaseId);

        // @ts-ignore
        await prisma.databaseMetric.create({
            data: {
                databaseId,
                connections: snapshot.connections,
                queryThroughput: BigInt(snapshot.queryThroughput),
                slowQueryCount: snapshot.slowQueryCount,
                sizeBytes: BigInt(snapshot.sizeBytes),
            },
        });

        return snapshot;
    } catch (err: any) {
        console.error(`[db-metrics] Failed to collect metrics for ${databaseId}:`, err.message);
        return null;
    }
}

/**
 * Get historical metrics for a database.
 */
export async function getMetricsHistory(databaseId: string, hours = 24) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    // @ts-ignore
    const metrics = await prisma.databaseMetric.findMany({
        where: {
            databaseId,
            createdAt: { gte: since },
        },
        orderBy: { createdAt: 'asc' },
        select: {
            connections: true,
            queryThroughput: true,
            slowQueryCount: true,
            sizeBytes: true,
            createdAt: true,
        },
    });

    // Convert BigInt to number for JSON serialization
    return metrics.map((m: any) => ({
        connections: m.connections,
        queryThroughput: Number(m.queryThroughput),
        slowQueryCount: m.slowQueryCount,
        sizeBytes: Number(m.sizeBytes),
        createdAt: m.createdAt.toISOString(),
    }));
}

/**
 * Collect metrics for all RUNNING databases.
 * Called by cron every 5 minutes.
 */
export async function collectAllMetrics(): Promise<void> {
    // @ts-ignore
    const databases = await prisma.database.findMany({
        where: { status: 'RUNNING', containerName: { not: null } },
        select: { id: true },
    });

    console.log(`[db-metrics] Collecting metrics for ${databases.length} databases`);

    for (const db of databases) {
        await collectAndPersistMetrics(db.id);
    }
}

/**
 * Prune old metric snapshots. Default: keep 7 days.
 */
export async function pruneOldMetrics(retentionDays = 7): Promise<void> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // @ts-ignore
    const result = await prisma.databaseMetric.deleteMany({
        where: { createdAt: { lt: cutoff } },
    });

    if (result.count > 0) {
        console.log(`[db-metrics] Pruned ${result.count} old metric records (older than ${retentionDays} days)`);
    }
}
