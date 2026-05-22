'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface DatabaseRecord {
    id: string;
    name: string;
    engine: 'POSTGRES' | 'MYSQL' | 'REDIS' | 'MONGODB';
    version: string;
    status: 'PENDING' | 'PROVISIONING' | 'RUNNING' | 'STOPPED' | 'ERROR';
    containerName: string | null;
    port: number | null;
    dbName: string | null;
    dbUser: string | null;
    errorMessage: string | null;
    projectId: string | null;
    createdAt: string;
    project: { id: string; name: string } | null;
}

interface ProjectSummary {
    id: string;
    name: string;
}

interface Props {
    serverId: string;
    token: string | null;
    projects: ProjectSummary[];
    organizationId: string;
}

// ─── Engine Meta ───────────────────────────────────────────────────────────────

const ENGINE_META: Record<string, { label: string; icon: string; color: string; defaultVersion: string; versions: string[] }> = {
    POSTGRES: { label: 'PostgreSQL', icon: '🐘', color: 'text-blue-400', defaultVersion: '16', versions: ['16', '15', '14', '13'] },
    MYSQL:    { label: 'MySQL',      icon: '🐬', color: 'text-orange-400', defaultVersion: '8', versions: ['8', '8.0', '5.7'] },
    REDIS:    { label: 'Redis',      icon: '⚡', color: 'text-red-400', defaultVersion: '7', versions: ['7', '6', '5'] },
    MONGODB:  { label: 'MongoDB',    icon: '🍃', color: 'text-green-400', defaultVersion: '7', versions: ['7', '6', '5'] },
};

const STATUS_STYLES: Record<string, { badge: string; dot: string }> = {
    RUNNING:      { badge: 'bg-green-500/10 text-green-400 border-green-500/20',  dot: 'bg-green-400 animate-pulse' },
    PROVISIONING: { badge: 'bg-blue-500/10 text-blue-400 border-blue-500/20',    dot: 'bg-blue-400 animate-pulse' },
    PENDING:      { badge: 'bg-gray-500/10 text-gray-400 border-gray-500/20',    dot: 'bg-gray-400' },
    STOPPED:      { badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20', dot: 'bg-amber-400' },
    ERROR:        { badge: 'bg-red-500/10 text-red-400 border-red-500/20',       dot: 'bg-red-400' },
};

// ─── Component ─────────────────────────────────────────────────────────────────

export default function DatabaseManager({ serverId, token, projects, organizationId }: Props) {
    const [databases, setDatabases] = useState<DatabaseRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [connectionStrings, setConnectionStrings] = useState<Record<string, string>>({});
    const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
    const [backupStatus, setBackupStatus] = useState<Record<string, string>>({});
    const [deleting, setDeleting] = useState<string | null>(null);
    const [deleteModal, setDeleteModal] = useState<{ db: DatabaseRecord; removeVolume: boolean } | null>(null);

    // ── Provision Modal State ──
    const [provisionEngine, setProvisionEngine] = useState<'POSTGRES' | 'MYSQL' | 'REDIS' | 'MONGODB'>('POSTGRES');
    const [provisionName, setProvisionName] = useState('');
    const [provisionVersion, setProvisionVersion] = useState('');
    const [provisionProjectId, setProvisionProjectId] = useState('');
    const [provisioning, setProvisioning] = useState(false);
    const [provisionLogs, setProvisionLogs] = useState('');
    const logsEndRef = useRef<HTMLDivElement>(null);

    const fetchDatabases = useCallback(() => {
        if (!token || !serverId) return;
        fetch(`/api/databases?serverId=${serverId}`, {
            headers: { Authorization: `Bearer ${token}` },
        })
            .then(r => r.json())
            .then(data => { setDatabases(data); setLoading(false); })
            .catch(() => setLoading(false));
    }, [serverId, token]);

    useEffect(() => { fetchDatabases(); }, [fetchDatabases]);

    // Auto-scroll logs
    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [provisionLogs]);

    // ── Provision via Socket.io ──
    const handleProvision = async () => {
        if (!provisionName.trim()) return;
        setProvisioning(true);
        setProvisionLogs('');

        const io = (await import('socket.io-client')).default;
        // Reuse existing socket if available (same hostname pattern as DeploymentTerminal)
        const socket = io(window.location.origin, { transports: ['websocket'] });

        const engineMeta = ENGINE_META[provisionEngine];

        socket.emit('provision-database', {
            serverId,
            engine: provisionEngine,
            name: provisionName.trim(),
            version: provisionVersion || engineMeta.defaultVersion,
            projectId: provisionProjectId || undefined,
            organizationId,
        });

        socket.on(`db_log:${serverId}`, (chunk: string) => {
            setProvisionLogs(prev => prev + chunk);
        });

        socket.on(`db_provision_success:${serverId}`, () => {
            setProvisionLogs(prev => prev + '\n\x1b[32m✅ Database provisioned successfully!\x1b[0m\n');
            setProvisioning(false);
            socket.disconnect();
            fetchDatabases();
            // Auto-close modal after 2s on success
            setTimeout(() => {
                setShowAddModal(false);
                setProvisionLogs('');
                setProvisionName('');
                setProvisionProjectId('');
            }, 2000);
        });

        socket.on(`db_provision_error:${serverId}`, ({ error }: { error: string }) => {
            setProvisionLogs(prev => prev + `\n\x1b[31m❌ Error: ${error}\x1b[0m\n`);
            setProvisioning(false);
            socket.disconnect();
            fetchDatabases();
        });
    };

    // ── Fetch connection string once (decrypt on server) ──
    const handleRevealConnectionString = async (db: DatabaseRecord) => {
        if (revealedIds.has(db.id)) {
            // Toggle off
            setRevealedIds(prev => { const n = new Set(prev); n.delete(db.id); return n; });
            return;
        }

        if (!connectionStrings[db.id]) {
            try {
                const res = await fetch(`/api/databases/${db.id}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                const data = await res.json();
                setConnectionStrings(prev => ({ ...prev, [db.id]: data.connectionString || '' }));
            } catch {}
        }
        setRevealedIds(prev => new Set(prev).add(db.id));
    };

    // ── Backup ──
    const handleBackup = async (db: DatabaseRecord) => {
        setBackupStatus(prev => ({ ...prev, [db.id]: 'running' }));
        try {
            const res = await fetch(`/api/databases/${db.id}/backup`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            if (data.backupPath) {
                setBackupStatus(prev => ({ ...prev, [db.id]: `done:${data.backupPath}` }));
            } else {
                setBackupStatus(prev => ({ ...prev, [db.id]: `error:${data.error || 'Unknown error'}` }));
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : 'Unknown error';
            setBackupStatus(prev => ({ ...prev, [db.id]: `error:${msg}` }));
        }
    };

    // ── Delete ──
    const handleDelete = (db: DatabaseRecord) => {
        setDeleteModal({ db, removeVolume: false });
    };

    const confirmDelete = async () => {
        if (!deleteModal) return;
        const { db, removeVolume } = deleteModal;
        setDeleteModal(null);
        setDeleting(db.id);
        try {
            await fetch(`/api/databases/${db.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ removeVolume }),
            });
            fetchDatabases();
        } catch {}
        setDeleting(null);
    };

    // ── Link/Unlink ──
    const handleLink = async (dbId: string, projectId: string) => {
        await fetch(`/api/databases/${dbId}/link`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId }),
        });
        fetchDatabases();
    };

    const handleUnlink = async (dbId: string) => {
        await fetch(`/api/databases/${dbId}/link`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
        });
        fetchDatabases();
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Render
    // ─────────────────────────────────────────────────────────────────────────

    return (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
                    <svg className="w-4 h-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582 4-8 4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                    </svg>
                    Databases
                </h3>
                <button
                    onClick={() => { setShowAddModal(true); setProvisionLogs(''); setProvisionName(''); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-violet-600/20 border border-violet-500/30 text-violet-300 hover:bg-violet-600/30 transition-colors"
                >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Add Database
                </button>
            </div>

            {/* Database List */}
            {loading ? (
                <div className="flex items-center justify-center py-6">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-violet-500" />
                </div>
            ) : databases.length === 0 ? (
                <div className="text-center py-6 text-gray-500 text-sm">
                    <svg className="w-8 h-8 mx-auto mb-2 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582 4-8 4s8 1.79 8 4" />
                    </svg>
                    No databases yet
                </div>
            ) : (
                <div className="space-y-2">
                    {databases.map(db => {
                        const meta = ENGINE_META[db.engine];
                        const statusStyle = STATUS_STYLES[db.status] || STATUS_STYLES.PENDING;
                        const isExpanded = expandedId === db.id;
                        const backupSt = backupStatus[db.id] || '';

                        return (
                            <div key={db.id} className="bg-black/30 rounded-lg border border-gray-800/60 overflow-hidden">
                                {/* Header */}
                                <button
                                    className="w-full flex items-center justify-between p-3 hover:bg-gray-800/30 transition-colors text-left"
                                    onClick={() => setExpandedId(isExpanded ? null : db.id)}
                                >
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <span className="text-lg">{meta?.icon || '🗄️'}</span>
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium text-white truncate">{db.name}</div>
                                            <div className={`text-xs ${meta?.color || 'text-gray-400'}`}>
                                                {meta?.label || db.engine} {db.version}
                                                {db.port && <span className="text-gray-500 ml-1">:{db.port}</span>}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                                        <span className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusStyle.badge}`}>
                                            <span className={`w-1.5 h-1.5 rounded-full ${statusStyle.dot}`} />
                                            {db.status}
                                        </span>
                                        <svg className={`w-4 h-4 text-gray-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                        </svg>
                                    </div>
                                </button>

                                {/* Expanded Details */}
                                {isExpanded && (
                                    <div className="border-t border-gray-800/60 p-3 space-y-3">
                                        {/* Info row */}
                                        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                                            {db.dbName && (
                                                <div>
                                                    <span className="text-gray-500 block text-[10px] uppercase tracking-wider mb-0.5">Database</span>
                                                    <span className="text-gray-300">{db.dbName}</span>
                                                </div>
                                            )}
                                            {db.dbUser && (
                                                <div>
                                                    <span className="text-gray-500 block text-[10px] uppercase tracking-wider mb-0.5">User</span>
                                                    <span className="text-gray-300">{db.dbUser}</span>
                                                </div>
                                            )}
                                        </div>

                                        {/* Error message */}
                                        {db.errorMessage && (
                                            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2">
                                                {db.errorMessage}
                                            </div>
                                        )}

                                        {/* Connection String */}
                                        {db.status === 'RUNNING' && (
                                            <div>
                                                <button
                                                    onClick={() => handleRevealConnectionString(db)}
                                                    className="text-xs text-violet-400 hover:text-violet-300 flex items-center gap-1 mb-1"
                                                >
                                                    {revealedIds.has(db.id) ? '🙈 Hide' : '👁️ Show'} Connection String
                                                </button>
                                                {revealedIds.has(db.id) && connectionStrings[db.id] && (
                                                    <div className="flex items-stretch bg-black/50 border border-gray-700 rounded overflow-hidden">
                                                        <input
                                                            readOnly
                                                            value={connectionStrings[db.id]}
                                                            className="flex-1 bg-transparent p-2 text-[10px] text-green-300 font-mono outline-none truncate"
                                                        />
                                                        <button
                                                            onClick={() => navigator.clipboard.writeText(connectionStrings[db.id])}
                                                            className="px-2 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors text-[10px]"
                                                            title="Copy"
                                                        >📋</button>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Project Link */}
                                        <div className="flex items-center gap-2">
                                            {db.project ? (
                                                <div className="flex items-center gap-2 text-xs">
                                                    <span className="text-gray-500">Linked to:</span>
                                                    <span className="text-violet-300">{db.project.name}</span>
                                                    <button
                                                        onClick={() => handleUnlink(db.id)}
                                                        className="text-red-400 hover:text-red-300 text-[10px] ml-1"
                                                    >Unlink</button>
                                                </div>
                                            ) : projects.length > 0 ? (
                                                <div className="flex items-center gap-2 text-xs">
                                                    <span className="text-gray-500">Link to:</span>
                                                    <select
                                                        className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-300 text-xs"
                                                        defaultValue=""
                                                        onChange={e => { if (e.target.value) handleLink(db.id, e.target.value); }}
                                                    >
                                                        <option value="">Select project...</option>
                                                        {projects.map(p => (
                                                            <option key={p.id} value={p.id}>{p.name}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            ) : null}
                                        </div>

                                        {/* Backup status */}
                                        {backupSt.startsWith('done:') && (
                                            <div className="text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 rounded p-2 font-mono truncate">
                                                ✅ Backup saved: {backupSt.replace('done:', '')}
                                            </div>
                                        )}
                                        {backupSt.startsWith('error:') && (
                                            <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2">
                                                ❌ {backupSt.replace('error:', '')}
                                            </div>
                                        )}

                                        {/* Action buttons */}
                                        <div className="flex items-center gap-2 pt-1 border-t border-gray-800/60">
                                            {db.status === 'RUNNING' && (
                                                <button
                                                    onClick={() => handleBackup(db)}
                                                    disabled={backupSt === 'running'}
                                                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 transition-colors disabled:opacity-50"
                                                >
                                                    {backupSt === 'running' ? (
                                                        <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
                                                    ) : '💾'} Backup
                                                </button>
                                            )}
                                            <button
                                                onClick={() => handleDelete(db)}
                                                disabled={deleting === db.id}
                                                className="flex items-center gap-1 px-3 py-1.5 rounded text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 ml-auto"
                                            >
                                                {deleting === db.id ? (
                                                    <div className="w-3 h-3 border border-red-400 border-t-transparent rounded-full animate-spin" />
                                                ) : (
                                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                                    </svg>
                                                )}
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* ── Add Database Modal ── */}
            {showAddModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget && !provisioning) setShowAddModal(false); }}>
                    <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between p-5 border-b border-gray-800">
                            <h2 className="text-lg font-bold flex items-center gap-2">
                                🗄️ Add Database
                            </h2>
                            {!provisioning && (
                                <button onClick={() => setShowAddModal(false)} className="text-gray-400 hover:text-white">
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            )}
                        </div>

                        <div className="p-5 space-y-4">
                            {/* Engine Selector */}
                            <div>
                                <label className="block text-xs text-gray-400 uppercase tracking-wider mb-2">Engine</label>
                                <div className="grid grid-cols-4 gap-2">
                                    {(['POSTGRES', 'MYSQL', 'REDIS', 'MONGODB'] as const).map(eng => {
                                        const m = ENGINE_META[eng];
                                        return (
                                            <button
                                                key={eng}
                                                onClick={() => { setProvisionEngine(eng); setProvisionVersion(''); }}
                                                disabled={provisioning}
                                                className={`flex flex-col items-center gap-1 p-3 rounded-lg border transition-all ${
                                                    provisionEngine === eng
                                                        ? 'border-violet-500 bg-violet-500/10 text-violet-300'
                                                        : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600'
                                                }`}
                                            >
                                                <span className="text-xl">{m.icon}</span>
                                                <span className="text-xs font-medium">{m.label}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Name */}
                            <div>
                                <label className="block text-xs text-gray-400 uppercase tracking-wider mb-2">Name</label>
                                <input
                                    type="text"
                                    value={provisionName}
                                    onChange={e => setProvisionName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                                    disabled={provisioning}
                                    placeholder="e.g. my-app-db"
                                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-violet-500 disabled:opacity-60"
                                />
                                <p className="text-[10px] text-gray-500 mt-1">
                                    Container: <code className="text-gray-400">hylius-db-{provisionName || 'my-app-db'}</code>
                                </p>
                            </div>

                            {/* Version */}
                            <div>
                                <label className="block text-xs text-gray-400 uppercase tracking-wider mb-2">Version</label>
                                <select
                                    value={provisionVersion || ENGINE_META[provisionEngine].defaultVersion}
                                    onChange={e => setProvisionVersion(e.target.value)}
                                    disabled={provisioning}
                                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500 disabled:opacity-60"
                                >
                                    {ENGINE_META[provisionEngine].versions.map(v => (
                                        <option key={v} value={v}>{v}</option>
                                    ))}
                                </select>
                            </div>

                            {/* Optional Project Link */}
                            {projects.length > 0 && (
                                <div>
                                    <label className="block text-xs text-gray-400 uppercase tracking-wider mb-2">
                                        Link to Project <span className="text-gray-600 normal-case">(optional — auto-injects DATABASE_URL)</span>
                                    </label>
                                    <select
                                        value={provisionProjectId}
                                        onChange={e => setProvisionProjectId(e.target.value)}
                                        disabled={provisioning}
                                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500 disabled:opacity-60"
                                    >
                                        <option value="">No project link</option>
                                        {projects.map(p => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {/* Provisioning Terminal */}
                            {provisionLogs && (
                                <div className="bg-black rounded-lg border border-gray-800 p-3 max-h-48 overflow-y-auto font-mono text-xs">
                                    <pre className="text-green-300 whitespace-pre-wrap break-all">{provisionLogs}</pre>
                                    <div ref={logsEndRef} />
                                </div>
                            )}

                            {/* Info pill */}
                            <div className="flex items-start gap-2 text-[10px] text-gray-500 bg-gray-800/50 rounded-lg p-3">
                                <span className="flex-shrink-0">🔒</span>
                                <span>
                                    Password is auto-generated and stored encrypted. Database binds to <code>127.0.0.1</code> only.
                                    Data persists in a Docker volume across restarts.
                                </span>
                            </div>
                        </div>

                        <div className="flex items-center gap-3 px-5 pb-5">
                            <button
                                onClick={() => setShowAddModal(false)}
                                disabled={provisioning}
                                className="flex-1 px-4 py-2.5 rounded-lg border border-gray-700 text-gray-400 hover:bg-gray-800 text-sm transition-colors disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleProvision}
                                disabled={!provisionName.trim() || provisioning}
                                className="flex-1 px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(124,58,237,0.3)]"
                            >
                                {provisioning ? (
                                    <>
                                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        Provisioning...
                                    </>
                                ) : (
                                    <>🚀 Provision Database</>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Delete Confirmation Modal ── */}
            {deleteModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
                    <div className="bg-gray-900 border border-red-500/30 rounded-2xl w-full max-w-sm shadow-2xl">
                        <div className="p-5 border-b border-gray-800">
                            <h2 className="text-base font-bold text-white flex items-center gap-2">
                                <span className="text-red-400">⚠️</span> Delete Database
                            </h2>
                        </div>
                        <div className="p-5 space-y-4">
                            <p className="text-sm text-gray-300">
                                Are you sure you want to delete{' '}
                                <span className="font-semibold text-white">{deleteModal.db.name}</span>?
                                The container will be stopped and removed.
                            </p>

                            {/* Volume toggle */}
                            <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-700 bg-gray-800/50 cursor-pointer hover:border-red-500/50 transition-colors group">
                                <input
                                    type="checkbox"
                                    checked={deleteModal.removeVolume}
                                    onChange={e => setDeleteModal(prev => prev ? { ...prev, removeVolume: e.target.checked } : null)}
                                    className="mt-0.5 accent-red-500"
                                />
                                <div>
                                    <div className="text-sm font-medium text-gray-200 group-hover:text-white">Also delete data volume</div>
                                    <div className="text-[11px] text-gray-500 mt-0.5">
                                        ⚠️ This permanently wipes all database data. Cannot be undone.
                                    </div>
                                </div>
                            </label>

                            {!deleteModal.removeVolume && (
                                <p className="text-[11px] text-gray-500">
                                    ✅ Data volume will be <span className="text-green-400">preserved</span> on the server. You can reattach it later.
                                </p>
                            )}
                        </div>
                        <div className="flex items-center gap-3 px-5 pb-5">
                            <button
                                onClick={() => setDeleteModal(null)}
                                className="flex-1 px-4 py-2.5 rounded-lg border border-gray-700 text-gray-400 hover:bg-gray-800 text-sm transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmDelete}
                                className={`flex-1 px-4 py-2.5 rounded-lg text-white text-sm font-medium transition-colors ${
                                    deleteModal.removeVolume
                                        ? 'bg-red-600 hover:bg-red-500 shadow-[0_0_15px_rgba(239,68,68,0.3)]'
                                        : 'bg-gray-700 hover:bg-gray-600'
                                }`}
                            >
                                {deleteModal.removeVolume ? '🗑️ Delete & Wipe Data' : 'Delete Container'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
