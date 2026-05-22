'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/providers/auth.provider';
import {
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    AreaChart,
    Area,
} from 'recharts';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface DatabaseInfo {
    id: string;
    name: string;
    engine: string;
    version: string;
    status: string;
    containerName: string | null;
    port: number | null;
    serverId: string;
    serverName?: string;
}

interface MetricSnapshot {
    connections: number;
    queryThroughput: number;
    slowQueryCount: number;
    slowQueries: SlowQuery[];
    sizeBytes: number;
}

interface SlowQuery {
    query: string;
    durationSecs: number;
    state?: string;
    pid?: string;
}

interface HistoricalPoint {
    connections: number;
    queryThroughput: number;
    slowQueryCount: number;
    sizeBytes: number;
    createdAt: string;
}

type TimeRange = '1h' | '6h' | '24h' | '7d';

// ─── Engine Meta ────────────────────────────────────────────────────────────────

const ENGINE_META: Record<string, { label: string; icon: string; color: string; chartColor: string }> = {
    POSTGRES: { label: 'PostgreSQL', icon: '🐘', color: 'text-blue-400', chartColor: '#3b82f6' },
    MYSQL:    { label: 'MySQL',      icon: '🐬', color: 'text-orange-400', chartColor: '#f97316' },
    REDIS:    { label: 'Redis',      icon: '⚡', color: 'text-red-400', chartColor: '#ef4444' },
    MONGODB:  { label: 'MongoDB',    icon: '🍃', color: 'text-green-400', chartColor: '#22c55e' },
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatNumber(n: number): string {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
}

function timeRangeToHours(range: TimeRange): number {
    switch (range) {
        case '1h': return 1;
        case '6h': return 6;
        case '24h': return 24;
        case '7d': return 168;
    }
}

function formatXAxis(tickItem: string) {
    const date = new Date(tickItem);
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

// ─── Stat Card ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon, color = 'text-white', alert = false }: {
    label: string; value: string | number; sub?: string; icon: string; color?: string; alert?: boolean;
}) {
    return (
        <div className={`bg-white/[0.03] border rounded-2xl p-5 transition-all duration-300 ${alert ? 'border-amber-500/30 shadow-[0_0_20px_rgba(245,158,11,0.1)]' : 'border-white/[0.06]'}`}>
            <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-gray-500 font-semibold uppercase tracking-wider">{label}</p>
                <span className="text-lg">{icon}</span>
            </div>
            <p className={`text-3xl font-bold ${color} tracking-tight`}>{value}</p>
            {sub && <p className="text-xs text-gray-600 mt-1">{sub}</p>}
        </div>
    );
}

// ─── Custom Tooltip ─────────────────────────────────────────────────────────────

interface ChartTooltipProps {
    active?: boolean;
    payload?: { color: string; name: string; value: number }[];
    label?: string;
    formatter?: (value: number) => string;
}

function ChartTooltip({ active, payload, label, formatter }: ChartTooltipProps) {
    if (active && payload && payload.length) {
        const date = new Date(label || '');
        return (
            <div className="bg-gray-900 border border-gray-700 p-3 rounded-lg shadow-xl text-sm">
                <p className="text-gray-400 mb-2">{date.toLocaleString()}</p>
                {payload.map((entry, index: number) => (
                    <div key={index} className="flex items-center gap-2 mb-1">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                        <span className="text-gray-200">{entry.name}:</span>
                        <span className="font-mono text-white">{formatter ? formatter(entry.value) : entry.value}</span>
                    </div>
                ))}
            </div>
        );
    }
    return null;
}

// ─── Page Component ─────────────────────────────────────────────────────────────

export default function DatabaseAnalyticsPage() {
    const { token, organization, user } = useAuth();
    const isFreePlan = (!organization?.plan || organization.plan === "FREE") && user?.role !== "PLATFORM_ADMIN";
    const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
    const [selectedDbId, setSelectedDbId] = useState<string>('');
    const [liveMetrics, setLiveMetrics] = useState<MetricSnapshot | null>(null);
    const [history, setHistory] = useState<HistoricalPoint[]>([]);
    const [timeRange, setTimeRange] = useState<TimeRange>('24h');
    const [loading, setLoading] = useState(true);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [liveIndicator, setLiveIndicator] = useState(false);
    const [error, setError] = useState('');
    const socketRef = useRef<{ emit: (event: string, data?: unknown) => void; disconnect: () => void; on: (event: string, cb: (...args: unknown[]) => void) => void } | null>(null);
    const prevThroughput = useRef<number | null>(null);
    const [throughputRate, setThroughputRate] = useState<number>(0);

    // ── Fetch all databases across all servers ──
    const fetchDatabases = useCallback(async () => {
        if (!token) return;
        try {
            const serversRes = await fetch('/api/servers', {
                headers: { Authorization: `Bearer ${token}` },
            });
            const servers = await serversRes.json();

            const allDbs: DatabaseInfo[] = [];
            for (const server of (Array.isArray(servers) ? servers : [])) {
                const dbRes = await fetch(`/api/databases?serverId=${server.id}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                const dbs = await dbRes.json();
                if (Array.isArray(dbs)) {
                    for (const db of dbs) {
                        allDbs.push({ ...db, serverName: server.name });
                    }
                }
            }

            setDatabases(allDbs);
            if (allDbs.length > 0 && !selectedDbId) {
                const running = allDbs.find(d => d.status === 'RUNNING');
                setSelectedDbId(running?.id || allDbs[0].id);
            }
        } catch {
            setError('Failed to load databases');
        } finally {
            setLoading(false);
        }
    }, [token, selectedDbId]);

    useEffect(() => { fetchDatabases(); }, [fetchDatabases]);

    // ── Fetch live metrics ──
    const fetchLiveMetrics = useCallback(async (dbId: string) => {
        if (!token || !dbId) return;
        try {
            const res = await fetch(`/api/databases/${dbId}/metrics/live`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                const data = await res.json();
                setLiveMetrics(data);

                // Compute throughput rate (delta)
                if (prevThroughput.current !== null) {
                    const delta = data.queryThroughput - prevThroughput.current;
                    setThroughputRate(Math.max(0, Math.round(delta / 30))); // per second over 30s interval
                }
                prevThroughput.current = data.queryThroughput;

                setLiveIndicator(true);
                setTimeout(() => setLiveIndicator(false), 800);
            } else {
                const err = await res.json();
                if (err.error !== 'Database is not running') setError(err.error);
            }
        } catch {} finally {}
    }, [token]);

    // ── Fetch historical metrics ──
    const fetchHistory = useCallback(async (dbId: string, range: TimeRange) => {
        if (!token || !dbId) return;
        setHistoryLoading(true);
        try {
            const hours = timeRangeToHours(range);
            const res = await fetch(`/api/databases/${dbId}/metrics?hours=${hours}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                const data = await res.json();
                setHistory(data);
            }
        } catch {} finally {
            setHistoryLoading(false);
        }
    }, [token]);

    // ── Socket.io live streaming ──
    useEffect(() => {
        if (!selectedDbId) return;

        const selectedDb = databases.find(d => d.id === selectedDbId);
        if (!selectedDb || selectedDb.status !== 'RUNNING') return;

        let socket: { emit: (event: string, data?: unknown) => void; disconnect: () => void; on: (event: string, cb: (...args: unknown[]) => void) => void } | null = null;
        const connectSocket = async () => {
            const io = (await import('socket.io-client')).default;
            socket = io(window.location.origin, { transports: ['websocket'] });
            socketRef.current = socket;

            socket.emit('watch-db-metrics', { databaseId: selectedDbId });

            socket.on(`db_metrics:${selectedDbId}`, (...args: unknown[]) => {
                const data = args[0] as MetricSnapshot;
                setLiveMetrics(data);

                if (prevThroughput.current !== null) {
                    const delta = data.queryThroughput - prevThroughput.current;
                    setThroughputRate(Math.max(0, Math.round(delta / 30)));
                }
                prevThroughput.current = data.queryThroughput;

                setLiveIndicator(true);
                setTimeout(() => setLiveIndicator(false), 800);
            });

            socket.on(`db_metrics_error:${selectedDbId}`, (...args: unknown[]) => {
                console.warn('[db-metrics] error:', args[0] as string);
            });
        };

        // Initial fetch
        fetchLiveMetrics(selectedDbId);
        fetchHistory(selectedDbId, timeRange);

        // Connect socket for live updates
        connectSocket();

        return () => {
            if (socket) {
                socket.emit('unwatch-db-metrics', { databaseId: selectedDbId });
                socket.disconnect();
            }
            socketRef.current = null;
            prevThroughput.current = null;
        };
    }, [selectedDbId, databases, fetchLiveMetrics, fetchHistory, timeRange]);

    // ── Refetch history when time range changes ──
    useEffect(() => {
        if (selectedDbId) fetchHistory(selectedDbId, timeRange);
    }, [timeRange, selectedDbId, fetchHistory]);

    const selectedDb = databases.find(d => d.id === selectedDbId);
    const meta = selectedDb ? ENGINE_META[selectedDb.engine] || ENGINE_META.POSTGRES : ENGINE_META.POSTGRES;
    const isRunning = selectedDb?.status === 'RUNNING';

    // Compute throughput delta series for chart
    const throughputDeltaSeries = history.map((point, i) => {
        const prev = i > 0 ? history[i - 1] : null;
        const delta = prev ? Math.max(0, point.queryThroughput - prev.queryThroughput) : 0;
        return { ...point, throughputDelta: delta };
    });

    // ── Loading State ──
    if (loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    // ── Free Plan Gate ──
    if (isFreePlan) {
        return (
            <div className="min-h-screen bg-background text-foreground">
                <main className="py-6">
                    <header className="mb-8 animate-reveal">
                        <h1 className="font-display text-4xl font-bold tracking-tight text-white mb-2">Database Analytics</h1>
                        <p className="text-gray-400 max-w-2xl">Monitor connections, query throughput, slow queries, and storage across your managed databases.</p>
                    </header>
                    <div className="flex flex-col items-center justify-center py-20 border border-dashed border-white/[0.06] rounded-2xl text-center gap-5 bg-gradient-to-br from-violet-600/5 via-purple-600/5 to-fuchsia-600/5">
                        <div className="p-4 rounded-2xl bg-white/[0.04] border border-white/[0.06]">
                            <svg className="w-10 h-10 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                            </svg>
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white mb-2">Upgrade to unlock Database Analytics</h2>
                            <p className="text-gray-400 text-sm max-w-md">Real-time connection monitoring, query throughput charts, slow query detection, and storage trends are available on the <span className="text-violet-400 font-semibold">PRO</span> and <span className="text-violet-400 font-semibold">ENTERPRISE</span> plans.</p>
                        </div>
                        <a href="/billing" className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-violet-600/20 border border-violet-500/30 text-violet-400 text-sm font-semibold hover:bg-violet-600/30 transition-all">
                            ✦ Upgrade Plan
                        </a>
                        <p className="text-[11px] text-gray-600">You&apos;re on the <span className="font-semibold text-gray-500">{organization?.plan || 'FREE'}</span> plan</p>
                    </div>
                </main>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-background text-foreground">
            <main className="py-6">
                <header className="mb-8 animate-reveal">
                    <div className="flex items-center justify-between flex-wrap gap-4">
                        <div>
                            <h1 className="font-display text-4xl font-bold tracking-tight text-white mb-2">
                                Database Analytics
                            </h1>
                            <p className="text-gray-400 max-w-2xl">
                                Monitor connections, query throughput, slow queries, and storage across your managed databases.
                            </p>
                        </div>

                        <div className="flex items-center gap-3">
                            {/* Live indicator */}
                            {isRunning && liveMetrics && (
                                <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/20 font-medium">
                                    <span className={`w-1.5 h-1.5 rounded-full transition-colors duration-300 ${liveIndicator ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]' : 'bg-green-600'}`} />
                                    Live
                                </span>
                            )}

                            {/* Time range */}
                            <div className="flex gap-1 p-1 bg-white/[0.03] border border-white/[0.06] rounded-lg">
                                {(['1h', '6h', '24h', '7d'] as TimeRange[]).map(range => (
                                    <button key={range} onClick={() => setTimeRange(range)}
                                        className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${timeRange === range ? 'bg-violet-600/20 text-violet-400 border border-violet-500/30' : 'text-gray-500 hover:text-gray-300 border border-transparent'}`}>
                                        {range}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </header>

                {databases.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 border border-dashed border-white/[0.06] rounded-2xl text-center gap-4">
                        <svg className="w-12 h-12 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <ellipse cx="12" cy="5" rx="9" ry="3" strokeWidth={1.5} />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
                        </svg>
                        <p className="text-gray-400 font-semibold">No databases found</p>
                        <p className="text-gray-600 text-sm">Provision a database on one of your servers to start monitoring.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
                        {/* Left: Database list */}
                        <div className="xl:col-span-1">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Databases</p>
                            <div className="space-y-2">
                                {databases.map(db => {
                                    const dbMeta = ENGINE_META[db.engine] || ENGINE_META.POSTGRES;
                                    const isActive = selectedDbId === db.id;
                                    return (
                                        <button key={db.id}
                                            onClick={() => { setSelectedDbId(db.id); setLiveMetrics(null); prevThroughput.current = null; setError(''); }}
                                            className={`w-full text-left px-4 py-3 rounded-xl border transition-all duration-200 ${
                                                isActive
                                                    ? 'bg-violet-600/10 border-violet-500/30 text-white'
                                                    : 'bg-white/[0.02] border-white/[0.06] text-gray-400 hover:bg-white/[0.04] hover:text-white'
                                            }`}>
                                            <div className="flex items-center gap-2">
                                                <span className="text-lg">{dbMeta.icon}</span>
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-sm font-semibold truncate">{db.name}</p>
                                                    <p className={`text-[10px] ${dbMeta.color}`}>
                                                        {dbMeta.label} {db.version}
                                                    </p>
                                                </div>
                                                <span className={`w-2 h-2 rounded-full shrink-0 ${
                                                    db.status === 'RUNNING' ? 'bg-green-400 animate-pulse' :
                                                    db.status === 'ERROR' ? 'bg-red-400' : 'bg-gray-600'
                                                }`} />
                                            </div>
                                            {db.serverName && (
                                                <p className="text-[10px] text-gray-600 mt-1 truncate ml-7">{db.serverName}</p>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Right: Analytics detail */}
                        <div className="xl:col-span-4 space-y-6">
                            {!selectedDb ? (
                                <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
                                    <p className="text-gray-500">Select a database to view analytics</p>
                                </div>
                            ) : !isRunning ? (
                                <div className="flex flex-col items-center justify-center py-20 border border-dashed border-white/[0.06] rounded-2xl text-center gap-4">
                                    <span className="text-4xl">{meta.icon}</span>
                                    <p className="text-gray-400 font-semibold">{selectedDb.name} is not running</p>
                                    <p className="text-gray-600 text-sm">Start the database to view live metrics.</p>
                                    <span className="text-xs text-gray-600 uppercase tracking-wider px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400">
                                        {selectedDb.status}
                                    </span>
                                </div>
                            ) : (
                                <>
                                    {/* Database header */}
                                    <div className="flex items-center gap-3">
                                        <span className="text-2xl">{meta.icon}</span>
                                        <div>
                                            <h2 className="text-xl font-bold text-white">{selectedDb.name}</h2>
                                            <p className={`text-xs ${meta.color}`}>
                                                {meta.label} {selectedDb.version} · Port {selectedDb.port}
                                                {selectedDb.serverName && <span className="text-gray-600"> · {selectedDb.serverName}</span>}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Error banner */}
                                    {error && (
                                        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                                            {error}
                                        </div>
                                    )}

                                    {/* Stat cards */}
                                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                        <StatCard
                                            label="Connections"
                                            value={liveMetrics ? liveMetrics.connections : '--'}
                                            sub="Active connections"
                                            icon="🔗"
                                            color={liveMetrics && liveMetrics.connections > 50 ? 'text-amber-400' : 'text-white'}
                                        />
                                        <StatCard
                                            label="Throughput"
                                            value={liveMetrics ? `${formatNumber(throughputRate)}/s` : '--'}
                                            sub="Queries per second"
                                            icon="⚡"
                                        />
                                        <StatCard
                                            label="Database Size"
                                            value={liveMetrics ? formatBytes(liveMetrics.sizeBytes) : '--'}
                                            sub="Total data size"
                                            icon="💾"
                                        />
                                        <StatCard
                                            label="Slow Queries"
                                            value={liveMetrics ? liveMetrics.slowQueryCount : '--'}
                                            sub={liveMetrics && liveMetrics.slowQueryCount > 0 ? 'Queries running > 5s' : 'None detected'}
                                            icon="⚠️"
                                            color={liveMetrics && liveMetrics.slowQueryCount > 0 ? 'text-amber-400' : 'text-emerald-400'}
                                            alert={!!liveMetrics && liveMetrics.slowQueryCount > 0}
                                        />
                                    </div>

                                    {/* Charts */}
                                    {historyLoading ? (
                                        <div className="h-64 flex items-center justify-center border-2 border-gray-800 border-dashed rounded-2xl">
                                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-violet-500" />
                                        </div>
                                    ) : history.length < 2 ? (
                                        <div className="h-64 flex flex-col items-center justify-center border-2 border-gray-800 border-dashed rounded-2xl text-gray-500 gap-2">
                                            <svg className="w-8 h-8 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                                            </svg>
                                            <p className="text-sm">Not enough historical data yet</p>
                                            <p className="text-xs text-gray-600">Metrics are collected every 5 minutes. Check back soon.</p>
                                        </div>
                                    ) : (
                                        <div className="space-y-6">
                                            {/* Connection Count Chart */}
                                            <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-5">
                                                <p className="text-sm font-semibold text-gray-400 mb-4">Connection Count</p>
                                                <div className="h-48 w-full">
                                                    <ResponsiveContainer width="100%" height="100%">
                                                        <AreaChart data={history} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                                                            <defs>
                                                                <linearGradient id="connGrad" x1="0" y1="0" x2="0" y2="1">
                                                                    <stop offset="5%" stopColor={meta.chartColor} stopOpacity={0.2} />
                                                                    <stop offset="95%" stopColor={meta.chartColor} stopOpacity={0} />
                                                                </linearGradient>
                                                            </defs>
                                                            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                                                            <XAxis dataKey="createdAt" tickFormatter={formatXAxis} stroke="#4b5563" tick={{ fill: '#6b7280', fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={30} />
                                                            <YAxis stroke="#4b5563" tick={{ fill: '#6b7280', fontSize: 11 }} tickLine={false} axisLine={false} />
                                                            <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#374151', strokeWidth: 1, strokeDasharray: '4 4' }} />
                                                            <Area type="monotone" dataKey="connections" name="Connections" stroke={meta.chartColor} strokeWidth={2} fill="url(#connGrad)" dot={false} activeDot={{ r: 4, fill: meta.chartColor, stroke: '#000', strokeWidth: 2 }} isAnimationActive={false} />
                                                        </AreaChart>
                                                    </ResponsiveContainer>
                                                </div>
                                            </div>

                                            {/* Query Throughput Chart */}
                                            <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-5">
                                                <p className="text-sm font-semibold text-gray-400 mb-4">Query Throughput (delta per interval)</p>
                                                <div className="h-48 w-full">
                                                    <ResponsiveContainer width="100%" height="100%">
                                                        <AreaChart data={throughputDeltaSeries} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                                                            <defs>
                                                                <linearGradient id="tpGrad" x1="0" y1="0" x2="0" y2="1">
                                                                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.2} />
                                                                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                                                                </linearGradient>
                                                            </defs>
                                                            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                                                            <XAxis dataKey="createdAt" tickFormatter={formatXAxis} stroke="#4b5563" tick={{ fill: '#6b7280', fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={30} />
                                                            <YAxis stroke="#4b5563" tick={{ fill: '#6b7280', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatNumber} />
                                                            <Tooltip content={<ChartTooltip formatter={formatNumber} />} cursor={{ stroke: '#374151', strokeWidth: 1, strokeDasharray: '4 4' }} />
                                                            <Area type="monotone" dataKey="throughputDelta" name="Queries" stroke="#8b5cf6" strokeWidth={2} fill="url(#tpGrad)" dot={false} activeDot={{ r: 4, fill: '#8b5cf6', stroke: '#000', strokeWidth: 2 }} isAnimationActive={false} />
                                                        </AreaChart>
                                                    </ResponsiveContainer>
                                                </div>
                                            </div>

                                            {/* Database Size Chart */}
                                            <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-5">
                                                <p className="text-sm font-semibold text-gray-400 mb-4">Database Size Over Time</p>
                                                <div className="h-48 w-full">
                                                    <ResponsiveContainer width="100%" height="100%">
                                                        <AreaChart data={history} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                                                            <defs>
                                                                <linearGradient id="sizeGrad" x1="0" y1="0" x2="0" y2="1">
                                                                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} />
                                                                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                                                </linearGradient>
                                                            </defs>
                                                            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                                                            <XAxis dataKey="createdAt" tickFormatter={formatXAxis} stroke="#4b5563" tick={{ fill: '#6b7280', fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={30} />
                                                            <YAxis stroke="#4b5563" tick={{ fill: '#6b7280', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatBytes} />
                                                            <Tooltip content={<ChartTooltip formatter={formatBytes} />} cursor={{ stroke: '#374151', strokeWidth: 1, strokeDasharray: '4 4' }} />
                                                            <Area type="monotone" dataKey="sizeBytes" name="Size" stroke="#10b981" strokeWidth={2} fill="url(#sizeGrad)" dot={false} activeDot={{ r: 4, fill: '#10b981', stroke: '#000', strokeWidth: 2 }} isAnimationActive={false} />
                                                        </AreaChart>
                                                    </ResponsiveContainer>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Slow Queries Table */}
                                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-5">
                                        <div className="flex items-center justify-between mb-4">
                                            <p className="text-sm font-semibold text-gray-400 flex items-center gap-2">
                                                ⚠️ Active Slow Queries
                                                {liveMetrics && liveMetrics.slowQueryCount > 0 && (
                                                    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
                                                        {liveMetrics.slowQueryCount}
                                                    </span>
                                                )}
                                            </p>
                                            <span className="text-[10px] text-gray-600 uppercase tracking-wider">Running &gt; 5s</span>
                                        </div>

                                        {!liveMetrics ? (
                                            <div className="flex items-center justify-center py-8">
                                                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-violet-500" />
                                            </div>
                                        ) : liveMetrics.slowQueries.length === 0 ? (
                                            <div className="text-center py-8">
                                                <p className="text-emerald-400 text-sm font-medium mb-1">✓ No slow queries</p>
                                                <p className="text-gray-600 text-xs">All queries completing within normal thresholds.</p>
                                            </div>
                                        ) : (
                                            <div className="overflow-x-auto">
                                                <table className="w-full text-sm">
                                                    <thead>
                                                        <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-white/[0.06]">
                                                            <th className="text-left py-2 pr-4 font-semibold">PID</th>
                                                            <th className="text-left py-2 pr-4 font-semibold">Query</th>
                                                            <th className="text-left py-2 pr-4 font-semibold">Duration</th>
                                                            <th className="text-left py-2 font-semibold">State</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {liveMetrics.slowQueries.map((sq, i) => (
                                                            <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                                                                <td className="py-3 pr-4 font-mono text-gray-400 text-xs">{sq.pid || '--'}</td>
                                                                <td className="py-3 pr-4 max-w-md">
                                                                    <code className="text-xs text-red-300 bg-red-500/10 px-2 py-1 rounded block truncate font-mono">
                                                                        {sq.query}
                                                                    </code>
                                                                </td>
                                                                <td className="py-3 pr-4">
                                                                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                                                                        sq.durationSecs > 30
                                                                            ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                                                                            : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                                                    }`}>
                                                                        {sq.durationSecs}s
                                                                    </span>
                                                                </td>
                                                                <td className="py-3 text-xs text-gray-500">{sq.state || '--'}</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}
