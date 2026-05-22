'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/providers/auth.provider';
import toast from 'react-hot-toast';

interface AddProjectModalProps {
    isOpen: boolean;
    onClose: () => void;
    serverId: string;
    serverName: string;
    onAdded?: (projectId?: string, successData?: { token: string; webhookUrl: string; prUrl?: string | null }) => void;
}

interface GitHubRepo {
    id: number;
    fullName: string;
    name: string;
    private: boolean;
    defaultBranch: string;
    cloneUrl: string;
    htmlUrl: string;
    description: string | null;
    language: string | null;
    updatedAt: string;
}

interface Database {
    id: string;
    name: string;
    engine: string;
    status: string;
}

type WizardStep = 'connect' | 'configure' | 'envVars' | 'database' | 'review';
const STEPS: WizardStep[] = ['connect', 'configure', 'envVars', 'database', 'review'];

type DeployStrategy = 'auto' | 'pm2' | 'docker-compose' | 'dockerfile' | 'railpack' | 'nixpacks' | 'ghcr-pull' | 'compose-registry' | 'compose-server' | 'dagger';
type DbEngine = 'POSTGRES' | 'MYSQL' | 'REDIS';

export default function AddProjectModal({ isOpen, onClose, serverId, serverName, onAdded }: AddProjectModalProps) {
    const { token } = useAuth();
    
    // Wizard State
    const [step, setStep] = useState<WizardStep>('connect');
    const [isCreating, setIsCreating] = useState(false);
    const [creationProgress, setCreationProgress] = useState<{ step: string; status: 'pending' | 'active' | 'done' | 'error'; message?: string }[]>([]);
    const [error, setError] = useState('');

    // Project Form State
    const [mode, setMode] = useState<'manual' | 'github'>('manual');
    const [form, setForm] = useState({
        name: '',
        repoUrl: '',
        branch: 'main',
        deployPath: '',
        buildCommand: '',
        startCommand: '',
    });
    const [githubMeta, setGithubMeta] = useState<{ repoFullName: string; installationId: number } | null>(null);
    const [deployStrategy, setDeployStrategy] = useState<DeployStrategy>('dagger');

    // Env Vars State
    const [envVars, setEnvVars] = useState<Array<{key: string, value: string}>>([{key: '', value: ''}]);

    // Database State
    const [dbOption, setDbOption] = useState<'none' | 'new' | 'existing'>('none');
    const [newDbEngine, setNewDbEngine] = useState<DbEngine>('POSTGRES');
    const [newDbName, setNewDbName] = useState('');
    const [selectedDbId, setSelectedDbId] = useState('');
    const [existingDatabases, setExistingDatabases] = useState<Database[]>([]);

    // GitHub repo state
    const [repos, setRepos] = useState<GitHubRepo[]>([]);
    const [reposLoading, setReposLoading] = useState(false);
    const [githubConnected, setGithubConnected] = useState(false);
    const [installationId, setInstallationId] = useState<number>(0);
    const [searchQuery, setSearchQuery] = useState('');

    useEffect(() => {
        if (isOpen) {
            fetchRepos();
            fetchDatabases();
        } else {
            resetState();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    function resetState() {
        setStep('connect');
        setMode('manual');
        setForm({ name: '', repoUrl: '', branch: 'main', deployPath: '', buildCommand: '', startCommand: '' });
        setGithubMeta(null);
        setDeployStrategy('dagger');
        setEnvVars([{key: '', value: ''}]);
        setDbOption('none');
        setNewDbEngine('POSTGRES');
        setNewDbName('');
        setSelectedDbId('');
        setIsCreating(false);
        setCreationProgress([]);
        setError('');
        setSearchQuery('');
    }

    async function fetchRepos() {
        setReposLoading(true);
        try {
            const res = await fetch('/api/github/repos', { headers: { Authorization: `Bearer ${token}` } });
            const data = await res.json();
            if (data.connected) {
                setGithubConnected(true);
                setRepos(data.repos || []);
                if (data.installation?.installationId) {
                    setInstallationId(Number(data.installation.installationId));
                }
            } else {
                setGithubConnected(false);
            }
        } catch {
            // Ignore silently
        } finally {
            setReposLoading(false);
        }
    }

    async function fetchDatabases() {
        try {
            const res = await fetch(`/api/databases?serverId=${serverId}`, { headers: { Authorization: `Bearer ${token}` } });
            const data = await res.json();
            // Only show databases not attached to a stack
            setExistingDatabases((data || []).filter((d: Database) => !('stackId' in d) || !(d as Database & { stackId?: string }).stackId));
        } catch {
            // Ignore silently
        }
    }

    function selectRepo(repo: GitHubRepo) {
        const sanitized = repo.name.replace(/\s+/g, '-').toLowerCase();
        setForm({
            name: repo.name,
            repoUrl: repo.cloneUrl,
            branch: repo.defaultBranch,
            deployPath: `/var/www/${sanitized}`,
            buildCommand: '',
            startCommand: '',
        });
        setGithubMeta({
            repoFullName: repo.fullName,
            installationId: installationId,
        });
        setDeployStrategy('dagger');
        setMode('github');
        setStep('configure');
    }

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const updated = { ...form, [e.target.name]: e.target.value };
        if (e.target.name === 'name') {
            const sanitized = e.target.value.trim().replace(/\s+/g, '-').toLowerCase();
            if (sanitized) updated.deployPath = `/var/www/${sanitized}`;
        }
        setForm(updated);
    };

    const handleEnvVarChange = (index: number, field: 'key' | 'value', val: string) => {
        const newVars = [...envVars];
        newVars[index][field] = val;
        setEnvVars(newVars);
    };

    const addEnvVar = () => setEnvVars([...envVars, {key: '', value: ''}]);
    const removeEnvVar = (index: number) => setEnvVars(envVars.filter((_, i) => i !== index));

    // Bulk .env paste support
    const [showBulkPaste, setShowBulkPaste] = useState(false);
    const [bulkText, setBulkText] = useState('');

    function parseEnvText(text: string): Array<{key: string, value: string}> {
        const parsed: Array<{key: string, value: string}> = [];
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq < 1) continue;
            const key = trimmed.slice(0, eq).trim();
            const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
            parsed.push({ key, value });
        }
        return parsed;
    }

    function applyBulkPaste() {
        const parsed = parseEnvText(bulkText);
        if (parsed.length === 0) return;
        setEnvVars(prev => {
            const existing = prev.filter(r => r.key.trim());
            const merged = [...existing];
            for (const p of parsed) {
                const idx = merged.findIndex(r => r.key === p.key);
                if (idx >= 0) merged[idx] = p;
                else merged.push(p);
            }
            return merged;
        });
        setBulkText('');
        setShowBulkPaste(false);
    }

    function handleValuePaste(e: React.ClipboardEvent<HTMLInputElement>) {
        const text = e.clipboardData.getData('text');
        const isBulk = text.includes('\n') && text.includes('=');
        const isSingleAssignment = /^[A-Z_][A-Z0-9_]*\s*=/.test(text.trim());
        if (!isBulk && !isSingleAssignment) return;
        e.preventDefault();
        const parsed = parseEnvText(text);
        if (parsed.length > 0) {
            setEnvVars(prev => {
                const existing = prev.filter(r => r.key.trim());
                const merged = [...existing];
                for (const p of parsed) {
                    const idx = merged.findIndex(r => r.key === p.key);
                    if (idx >= 0) merged[idx] = p;
                    else merged.push(p);
                }
                return merged;
            });
        }
    }

    const handleFinalSubmit = async () => {
        setError('');
        setIsCreating(true);

        const prog: { step: string; status: 'pending' | 'active' | 'done' | 'error'; message: string }[] = [
            { step: 'project', status: 'active', message: 'Creating project...' }
        ];
        
        const validEnvVars = envVars.filter(e => e.key.trim() && e.value.trim());
        if (validEnvVars.length > 0) {
            prog.push({ step: 'env', status: 'pending', message: 'Configuring environment variables...' });
        }
        
        if (dbOption === 'new') {
            prog.push({ step: 'db', status: 'pending', message: 'Provisioning database (this takes ~1 min)...' });
        } else if (dbOption === 'existing' && selectedDbId) {
            prog.push({ step: 'db', status: 'pending', message: 'Linking existing database...' });
        }
        setCreationProgress(prog);

        const updateProg = (stepKey: string, status: 'active' | 'done' | 'error') => {
            setCreationProgress(prev => prev.map(p => p.step === stepKey ? { ...p, status } : p));
        };

        try {
            // 1. Create Project
            const body: Record<string, unknown> = { ...form, serverId };
            if (githubMeta) {
                body.githubRepoFullName = githubMeta.repoFullName;
                body.githubInstallationId = githubMeta.installationId;
                body.deployStrategy = deployStrategy;
            }

            const res = await fetch('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || 'Failed to create project');
            }
            const projectData = await res.json();
            updateProg('project', 'done');

            // 2. Env Vars
            if (validEnvVars.length > 0) {
                updateProg('env', 'active');
                const envObj: Record<string, string> = {};
                validEnvVars.forEach(e => { envObj[e.key.trim()] = e.value.trim(); });
                await fetch(`/api/projects/${projectData.id}/env`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify(envObj),
                });
                updateProg('env', 'done');
            }

            // 3. Database
            if (dbOption === 'new') {
                updateProg('db', 'active');
                const dbRes = await fetch(`/api/databases/provision`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({
                        name: newDbName || `${form.name}-db`,
                        engine: newDbEngine,
                        serverId,
                    }),
                });
                if (!dbRes.ok) throw new Error('Failed to provision database');
                const dbData = await dbRes.json();
                
                await fetch(`/api/databases/${dbData.databaseId || dbData.id}/link`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ projectId: projectData.id }),
                });
                updateProg('db', 'done');
            } else if (dbOption === 'existing' && selectedDbId) {
                updateProg('db', 'active');
                await fetch(`/api/databases/${selectedDbId}/link`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ projectId: projectData.id }),
                });
                updateProg('db', 'done');
            }

            // 4. Generate Deploy Token if required
            let deployToken = '';
            if (deployStrategy === 'dagger' || deployStrategy === 'ghcr-pull' || deployStrategy === 'compose-registry') {
                try {
                    const tokenRes = await fetch('/api/tokens', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ name: `GitHub Actions - ${form.name}` })
                    });
                    if (tokenRes.ok) {
                        const tokenData = await tokenRes.json();
                        deployToken = tokenData.token || tokenData.plainToken;
                    }
                } catch {
                    // Ignore token errors
                }
            }

            let successData: { token: string; webhookUrl: string; prUrl?: string | null } | undefined = undefined;
            if (deployStrategy === 'dagger' || deployStrategy === 'ghcr-pull' || deployStrategy === 'compose-registry') {
                successData = {
                    token: deployToken,
                    webhookUrl: `${window.location.origin}/api/webhooks/deploy-complete`,
                    prUrl: projectData.prUrl ?? null,
                };
            }

            setTimeout(() => {
                toast.success(`Project "${form.name}" created successfully!`);
                onAdded?.(projectData.id, successData);
                onClose();
            }, 1000);

        } catch (err: unknown) {
            updateProg('project', 'error');
            updateProg('env', 'error');
            updateProg('db', 'error');
            setError(err instanceof Error ? err.message : 'Something went wrong');
            setIsCreating(false);
        }
    };

    function goNext() {
        if (step === 'connect') {
            if (mode === 'manual') setStep('configure');
            return;
        }
        
        // Validation before next
        if (step === 'configure') {
            if (!form.name || !form.repoUrl || !form.deployPath) {
                toast.error('Please fill in all required fields');
                return;
            }
        }
        
        const idx = STEPS.indexOf(step);
        if (idx < STEPS.length - 1) setStep(STEPS[idx + 1]);
    }

    function goBack() {
        const idx = STEPS.indexOf(step);
        if (idx > 0) setStep(STEPS[idx - 1]);
    }

    if (!isOpen) return null;

    const stepIndex = STEPS.indexOf(step);
    const filteredRepos = repos.filter(r => r.fullName.toLowerCase().includes(searchQuery.toLowerCase()));
    const appSlug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG || 'hylius-platform';

    return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="p-6 pb-4 border-b border-gray-800/50 bg-gray-900/80 backdrop-blur sticky top-0 z-10">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h2 className="text-xl font-bold text-white">{isCreating ? 'Creating Project...' : 'Create Project'}</h2>
                            <p className="text-sm text-gray-500 mt-0.5">Deploying to <span className="text-gray-300 font-medium">{serverName}</span></p>
                        </div>
                        {!isCreating && (
                            <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors p-1 rounded-lg hover:bg-gray-800">✕</button>
                        )}
                    </div>

                    {!isCreating && (
                        <div className="flex gap-2 items-center">
                            {STEPS.map((s, i) => (
                                <div key={s} className="flex-1 flex flex-col gap-1.5">
                                    <div className={`h-1.5 rounded-full transition-all duration-300 ${i <= stepIndex ? 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)]' : 'bg-gray-800'}`} />
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-6">
                    {error && !isCreating && (
                        <div className="bg-red-900/30 border border-red-800 text-red-400 text-sm p-4 rounded-lg mb-6 shadow-sm">
                            <span className="font-semibold mr-1">Error:</span>{error}
                        </div>
                    )}

                    {isCreating ? (
                        <div className="space-y-5 py-8 px-4">
                            {creationProgress.map((prog, i) => (
                                <div key={i} className="flex items-center gap-4">
                                    <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-gray-800/50 border border-gray-700/50">
                                        {prog.status === 'done' && <div className="w-6 h-6 rounded-full bg-green-500/20 text-green-500 flex items-center justify-center text-sm shadow-[0_0_10px_rgba(34,197,94,0.3)]">✓</div>}
                                        {prog.status === 'active' && <div className="w-5 h-5 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />}
                                        {prog.status === 'pending' && <div className="w-2 h-2 rounded-full bg-gray-600" />}
                                        {prog.status === 'error' && <div className="w-6 h-6 rounded-full bg-red-500/20 text-red-500 flex items-center justify-center text-sm shadow-[0_0_10px_rgba(239,68,68,0.3)]">✕</div>}
                                    </div>
                                    <p className={`text-sm ${prog.status === 'active' ? 'text-white font-medium' : prog.status === 'done' ? 'text-gray-400' : 'text-gray-500'}`}>
                                        {prog.message}
                                    </p>
                                </div>
                            ))}
                            {error && (
                                <div className="mt-8 bg-red-900/30 border border-red-800 text-red-400 text-sm p-4 rounded-lg flex items-start gap-3">
                                    <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                    </svg>
                                    <div>
                                        <strong className="block mb-1">Creation Failed</strong>
                                        {error}
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : step === 'connect' ? (
                        <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300">
                            <div className="flex gap-2 p-1.5 bg-gray-900 border border-gray-800 rounded-xl">
                                <button
                                    onClick={() => setMode('manual')}
                                    className={`flex-1 py-2.5 px-4 text-sm font-medium rounded-lg transition-all ${mode === 'manual' ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-gray-800/50'}`}
                                >
                                    Manual Config
                                </button>
                                <button
                                    onClick={() => setMode('github')}
                                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-medium rounded-lg transition-all ${mode === 'github' ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.3)]' : 'text-gray-400 hover:text-white hover:bg-gray-800/50'}`}
                                >
                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.6.11.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
                                    </svg>
                                    Import from GitHub
                                </button>
                            </div>

                            {mode === 'github' ? (
                                <div>
                                    {reposLoading ? (
                                        <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                                            <div className="w-8 h-8 border-2 border-gray-700 border-t-blue-500 rounded-full animate-spin mb-3"></div>
                                            Loading repositories...
                                        </div>
                                    ) : !githubConnected ? (
                                        <div className="text-center py-10 bg-gray-900/50 rounded-xl border border-gray-800">
                                            <svg className="w-12 h-12 text-gray-600 mx-auto mb-4" viewBox="0 0 24 24" fill="currentColor">
                                                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.6.11.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
                                            </svg>
                                            <h3 className="text-white font-medium mb-2">Connect GitHub</h3>
                                            <p className="text-gray-400 text-sm mb-5 max-w-sm mx-auto">Authorize Hylius to access your repositories to enable automated deployments.</p>
                                            <a href={`https://github.com/apps/${appSlug}/installations/new`} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-white text-black text-sm font-semibold hover:bg-gray-200 transition-colors">
                                                Install GitHub App
                                            </a>
                                        </div>
                                    ) : (
                                        <div className="space-y-4">
                                            <div className="relative">
                                                <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                                </svg>
                                                <input
                                                    type="text"
                                                    placeholder="Search your repositories..."
                                                    value={searchQuery}
                                                    onChange={e => setSearchQuery(e.target.value)}
                                                    className="w-full bg-gray-900 border border-gray-700 rounded-lg py-2.5 pl-10 pr-4 text-white text-sm placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all outline-none"
                                                    autoFocus
                                                />
                                            </div>
                                            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
                                                {filteredRepos.length === 0 ? (
                                                    <div className="text-center py-8 text-gray-500 text-sm">No repositories found.</div>
                                                ) : (
                                                    filteredRepos.map(repo => (
                                                        <button
                                                            key={repo.id}
                                                            onClick={() => selectRepo(repo)}
                                                            className="w-full text-left p-3.5 rounded-xl border border-gray-800 bg-gray-900/50 hover:border-blue-500/50 hover:bg-blue-500/5 transition-all group flex flex-col gap-1.5"
                                                        >
                                                            <div className="flex items-center justify-between">
                                                                <span className="text-white font-medium group-hover:text-blue-400 transition-colors">
                                                                    {repo.fullName}
                                                                </span>
                                                                {repo.private && (
                                                                    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700">
                                                                        Private
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-3">
                                                                {repo.language && (
                                                                    <span className="flex items-center gap-1.5 text-xs text-gray-400">
                                                                        <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                                                                        {repo.language}
                                                                    </span>
                                                                )}
                                                                <span className="flex items-center gap-1.5 text-xs text-gray-500">
                                                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                                                                    </svg>
                                                                    {repo.defaultBranch}
                                                                </span>
                                                            </div>
                                                        </button>
                                                    ))
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="py-8 text-center bg-gray-900/50 rounded-xl border border-gray-800 border-dashed">
                                    <h3 className="text-white font-medium mb-2">Manual Configuration</h3>
                                    <p className="text-gray-400 text-sm mb-5 max-w-sm mx-auto">Enter your repository details manually. Suitable for public repos or alternative Git providers.</p>
                                    <button onClick={goNext} className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors shadow-lg shadow-blue-500/20">
                                        Continue Setup
                                    </button>
                                </div>
                            )}
                        </div>
                    ) : step === 'configure' ? (
                        <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                            {githubMeta && (
                                <div className="bg-blue-900/20 border border-blue-500/30 rounded-xl p-3 flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400">
                                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.6.11.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
                                            </svg>
                                        </div>
                                        <div>
                                            <p className="text-xs text-blue-300/70 font-medium uppercase tracking-wider">Connected Repository</p>
                                            <p className="text-sm text-blue-100 font-medium">{githubMeta.repoFullName}</p>
                                        </div>
                                    </div>
                                    <button onClick={() => { setGithubMeta(null); setMode('manual'); setStep('connect'); }} className="text-xs text-blue-400 hover:text-white px-3 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 rounded-lg transition-colors font-medium">Change</button>
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-5">
                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium text-gray-300">Project Name <span className="text-red-400">*</span></label>
                                    <input name="name" value={form.name} onChange={handleChange} placeholder="my-awesome-app" required className="w-full bg-black/50 border border-gray-700 rounded-lg px-3.5 py-2.5 text-white text-sm placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all" />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium text-gray-300">Deploy Path <span className="text-red-400">*</span></label>
                                    <input name="deployPath" value={form.deployPath} onChange={handleChange} placeholder="/var/www/app" required className="w-full bg-black/50 border border-gray-700 rounded-lg px-3.5 py-2.5 text-white text-sm placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all" />
                                </div>
                                <div className="space-y-1.5 col-span-2">
                                    <label className="text-sm font-medium text-gray-300">Repository URL <span className="text-red-400">*</span></label>
                                    <input name="repoUrl" value={form.repoUrl} onChange={handleChange} placeholder="https://github.com/user/repo.git" required className="w-full bg-black/50 border border-gray-700 rounded-lg px-3.5 py-2.5 text-white text-sm placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all" />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium text-gray-300">Branch</label>
                                    <input name="branch" value={form.branch} onChange={handleChange} placeholder="main" className="w-full bg-black/50 border border-gray-700 rounded-lg px-3.5 py-2.5 text-white text-sm placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all" />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium text-gray-300">Deployment Strategy</label>
                                    <select value={deployStrategy} onChange={(e) => setDeployStrategy(e.target.value as DeployStrategy)} className="w-full bg-black/50 border border-gray-700 rounded-lg px-3.5 py-2.5 text-white text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all">
                                        <option value="auto">Auto-detect Build Strategy</option>
                                        <option value="dagger">⚡ Dagger (GitHub Actions)</option>
                                        <option value="nixpacks">Nixpacks</option>
                                        <option value="railpack">Railpack</option>
                                        <option value="dockerfile">Dockerfile</option>
                                        <option value="pm2">PM2 (Node.js)</option>
                                        <option value="compose-server">Docker Compose (Server)</option>
                                        <option value="docker-compose">Docker Compose (Legacy)</option>
                                        <option value="ghcr-pull">GHCR (GitHub Actions)</option>
                                        <option value="compose-registry">Compose CI (GitHub Actions)</option>
                                    </select>
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium text-gray-300">Build Command</label>
                                    <input name="buildCommand" value={form.buildCommand} onChange={handleChange} placeholder="npm run build" className="w-full bg-black/50 border border-gray-700 rounded-lg px-3.5 py-2.5 text-white text-sm placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all font-mono" />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium text-gray-300">Start Command</label>
                                    <input name="startCommand" value={form.startCommand} onChange={handleChange} placeholder="npm start" className="w-full bg-black/50 border border-gray-700 rounded-lg px-3.5 py-2.5 text-white text-sm placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all font-mono" />
                                </div>
                            </div>
                        </div>
                    ) : step === 'envVars' ? (
                        <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
                            <div className="bg-blue-900/10 border border-blue-500/20 p-4 rounded-xl mb-6">
                                <h4 className="text-blue-400 font-medium text-sm flex items-center gap-2 mb-1">
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    Environment Variables
                                </h4>
                                <p className="text-gray-400 text-sm">Add any required secrets or configuration. These will be injected securely at build and runtime.</p>
                            </div>

                            {/* Bulk paste toggle */}
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setShowBulkPaste(!showBulkPaste)}
                                    className={`text-xs font-medium flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition-all ${
                                        showBulkPaste
                                            ? 'bg-violet-600/20 border-violet-500/30 text-violet-400'
                                            : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-white hover:border-white/[0.12]'
                                    }`}
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                                    </svg>
                                    Paste .env
                                </button>
                                <span className="text-[11px] text-gray-600">or paste into any value field</span>
                            </div>

                            {/* Bulk paste textarea */}
                            {showBulkPaste && (
                                <div className="bg-black/50 border border-violet-500/20 rounded-xl p-4 space-y-3 animate-in fade-in">
                                    <p className="text-xs text-gray-400">Paste your <code className="text-violet-400">.env</code> file contents below. Lines starting with <code className="text-gray-500">#</code> will be skipped.</p>
                                    <textarea
                                        value={bulkText}
                                        onChange={e => setBulkText(e.target.value)}
                                        placeholder={`DATABASE_URL=postgres://user:pass@localhost:5432/db\nREDIS_URL=redis://localhost:6379\nSECRET_KEY=my-secret-key`}
                                        rows={6}
                                        className="w-full bg-gray-900/80 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-gray-600 focus:border-violet-500 focus:ring-1 focus:ring-violet-500 outline-none transition-all resize-none"
                                        autoFocus
                                    />
                                    <div className="flex items-center justify-between">
                                        <p className="text-[11px] text-gray-600">
                                            {bulkText.trim() ? `${parseEnvText(bulkText).length} variable(s) detected` : 'Waiting for paste...'}
                                        </p>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => { setBulkText(''); setShowBulkPaste(false); }}
                                                className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                onClick={applyBulkPaste}
                                                disabled={parseEnvText(bulkText).length === 0}
                                                className="px-4 py-1.5 text-xs font-semibold bg-violet-600/20 border border-violet-500/30 text-violet-400 rounded-lg hover:bg-violet-600/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                            >
                                                Import {parseEnvText(bulkText).length} variable{parseEnvText(bulkText).length !== 1 ? 's' : ''}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {envVars.map((env, i) => (
                                <div key={i} className="flex gap-3 items-start animate-in fade-in">
                                    <div className="flex-1">
                                        <input
                                            type="text"
                                            placeholder="DATABASE_URL"
                                            value={env.key}
                                            onChange={e => handleEnvVarChange(i, 'key', e.target.value.toUpperCase())}
                                            className="w-full bg-black/50 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all"
                                        />
                                    </div>
                                    <div className="flex-[2]">
                                        <input
                                            type="text"
                                            placeholder="postgres://user:pass@localhost:5432/db"
                                            value={env.value}
                                            onChange={e => handleEnvVarChange(i, 'value', e.target.value)}
                                            onPaste={handleValuePaste}
                                            className="w-full bg-black/50 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all"
                                        />
                                    </div>
                                    <button
                                        onClick={() => removeEnvVar(i)}
                                        className="p-2 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors border border-transparent"
                                        title="Remove variable"
                                    >
                                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                        </svg>
                                    </button>
                                </div>
                            ))}
                            <button
                                onClick={addEnvVar}
                                className="text-sm text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1.5 py-2 px-3 hover:bg-blue-500/10 rounded-lg transition-colors"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                                </svg>
                                Add Variable
                            </button>
                        </div>
                    ) : step === 'database' ? (
                        <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                            <div className="grid grid-cols-3 gap-4">
                                <label className={`cursor-pointer rounded-xl border p-4 transition-all ${dbOption === 'none' ? 'border-blue-500 bg-blue-500/10' : 'border-gray-800 bg-black/20 hover:border-gray-600'}`}>
                                    <div className="flex items-center gap-3 mb-2">
                                        <input type="radio" checked={dbOption === 'none'} onChange={() => setDbOption('none')} className="w-4 h-4 text-blue-600 focus:ring-blue-600 focus:ring-offset-gray-900 bg-gray-700 border-gray-600" />
                                        <span className="font-medium text-white">Skip</span>
                                    </div>
                                    <p className="text-xs text-gray-500 pl-7">I don&apos;t need a database or I will configure it later.</p>
                                </label>
                                <label className={`cursor-pointer rounded-xl border p-4 transition-all ${dbOption === 'new' ? 'border-blue-500 bg-blue-500/10' : 'border-gray-800 bg-black/20 hover:border-gray-600'}`}>
                                    <div className="flex items-center gap-3 mb-2">
                                        <input type="radio" checked={dbOption === 'new'} onChange={() => setDbOption('new')} className="w-4 h-4 text-blue-600 focus:ring-blue-600 focus:ring-offset-gray-900 bg-gray-700 border-gray-600" />
                                        <span className="font-medium text-white">New Database</span>
                                    </div>
                                    <p className="text-xs text-gray-500 pl-7">Provision a new database specifically for this project.</p>
                                </label>
                                <label className={`cursor-pointer rounded-xl border p-4 transition-all ${dbOption === 'existing' ? 'border-blue-500 bg-blue-500/10' : 'border-gray-800 bg-black/20 hover:border-gray-600'}`}>
                                    <div className="flex items-center gap-3 mb-2">
                                        <input type="radio" checked={dbOption === 'existing'} onChange={() => setDbOption('existing')} className="w-4 h-4 text-blue-600 focus:ring-blue-600 focus:ring-offset-gray-900 bg-gray-700 border-gray-600" />
                                        <span className="font-medium text-white">Existing Database</span>
                                    </div>
                                    <p className="text-xs text-gray-500 pl-7">Link to an already running database on this server.</p>
                                </label>
                            </div>

                            {dbOption === 'new' && (
                                <div className="p-5 border border-gray-800 bg-gray-900/50 rounded-xl space-y-4 animate-in fade-in">
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-1.5">
                                            <label className="text-sm font-medium text-gray-400">Database Engine</label>
                                            <select value={newDbEngine} onChange={e => setNewDbEngine(e.target.value as DbEngine)} className="w-full bg-black border border-gray-700 rounded-lg p-2.5 text-white text-sm focus:border-blue-500 outline-none transition-colors">
                                                <option value="POSTGRES">PostgreSQL</option>
                                                <option value="MYSQL">MySQL</option>
                                                <option value="REDIS">Redis</option>
                                            </select>
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-sm font-medium text-gray-400">Database Name (Optional)</label>
                                            <input value={newDbName} onChange={e => setNewDbName(e.target.value)} placeholder={`${form.name}-db`} className="w-full bg-black border border-gray-700 rounded-lg p-2.5 text-white text-sm placeholder-gray-600 focus:border-blue-500 outline-none transition-colors" />
                                        </div>
                                    </div>
                                    <div className="bg-blue-900/20 text-blue-400 text-xs p-3 rounded-lg flex items-start gap-2 border border-blue-500/20">
                                        <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        Hylius will automatically inject the connection string as DATABASE_URL (or REDIS_URL) into your environment variables.
                                    </div>
                                </div>
                            )}

                            {dbOption === 'existing' && (
                                <div className="p-5 border border-gray-800 bg-gray-900/50 rounded-xl animate-in fade-in">
                                    <label className="block text-sm font-medium text-gray-400 mb-2">Select Database</label>
                                    {existingDatabases.length === 0 ? (
                                        <p className="text-sm text-gray-500 bg-black/30 p-4 rounded-lg border border-gray-800 text-center">No available databases found on this server.</p>
                                    ) : (
                                        <select value={selectedDbId} onChange={e => setSelectedDbId(e.target.value)} className="w-full bg-black border border-gray-700 rounded-lg p-3 text-white text-sm focus:border-blue-500 outline-none transition-colors">
                                            <option value="">-- Choose a database --</option>
                                            {existingDatabases.map(db => (
                                                <option key={db.id} value={db.id}>{db.name} ({db.engine})</option>
                                            ))}
                                        </select>
                                    )}
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                            <div className="bg-gradient-to-br from-gray-900 to-black border border-gray-800 p-6 rounded-2xl shadow-xl">
                                <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-3">
                                    <span className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-sm shadow-[0_0_15px_rgba(37,99,235,0.4)]">🚀</span>
                                    Ready to Deploy
                                </h3>

                                <div className="space-y-4">
                                    <div className="grid grid-cols-3 gap-4 border-b border-gray-800 pb-4">
                                        <div className="text-gray-500 text-sm">Project Name</div>
                                        <div className="col-span-2 text-white font-medium">{form.name || '-'}</div>
                                    </div>
                                    <div className="grid grid-cols-3 gap-4 border-b border-gray-800 pb-4">
                                        <div className="text-gray-500 text-sm">Repository</div>
                                        <div className="col-span-2 text-white font-medium">{githubMeta ? githubMeta.repoFullName : form.repoUrl || '-'}</div>
                                    </div>
                                    <div className="grid grid-cols-3 gap-4 border-b border-gray-800 pb-4">
                                        <div className="text-gray-500 text-sm">Strategy</div>
                                        <div className="col-span-2 text-white font-medium">{deployStrategy}</div>
                                    </div>
                                    <div className="grid grid-cols-3 gap-4 border-b border-gray-800 pb-4">
                                        <div className="text-gray-500 text-sm">Env Vars</div>
                                        <div className="col-span-2 text-white font-medium">{envVars.filter(e => e.key && e.value).length} configured</div>
                                    </div>
                                    <div className="grid grid-cols-3 gap-4">
                                        <div className="text-gray-500 text-sm">Database</div>
                                        <div className="col-span-2 text-white font-medium">
                                            {dbOption === 'none' ? 'None' : dbOption === 'new' ? `Provisioning new ${newDbEngine}` : 'Linking existing'}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer Controls */}
                {!isCreating && (
                    <div className="p-5 border-t border-gray-800/50 bg-gray-900/50 flex justify-between items-center rounded-b-xl">
                        <button
                            type="button"
                            onClick={step === 'connect' ? onClose : goBack}
                            className="px-5 py-2.5 text-gray-400 hover:text-white font-medium rounded-lg hover:bg-gray-800 transition-colors"
                        >
                            {step === 'connect' ? 'Cancel' : 'Back'}
                        </button>
                        
                        <button
                            type="button"
                            onClick={step === 'review' ? handleFinalSubmit : goNext}
                            disabled={step === 'database' && dbOption === 'existing' && !selectedDbId}
                            className={`px-6 py-2.5 font-medium rounded-lg transition-all shadow-lg flex items-center gap-2 ${step === 'review' ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-500/25' : 'bg-white text-black hover:bg-gray-200'}`}
                        >
                            {step === 'review' ? (
                                <>Deploy Project <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg></>
                            ) : (
                                'Continue'
                            )}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
