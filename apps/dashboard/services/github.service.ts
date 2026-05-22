import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import crypto from 'crypto';

// ─── Config ─────────────────────────────────────────────────

function getAppConfig() {
    const appId = process.env.GITHUB_APP_ID;
    const privateKeyB64 = process.env.GITHUB_APP_PRIVATE_KEY;
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

    if (!appId || !privateKeyB64) {
        throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY env vars are required');
    }

    // Private key is base64-encoded in env to avoid newline issues
    const privateKey = Buffer.from(privateKeyB64, 'base64').toString('utf-8');

    return { appId, privateKey, webhookSecret: webhookSecret || '' };
}

// ─── Octokit Instances ──────────────────────────────────────

/**
 * Create an App-level Octokit (for listing installations, etc.)
 */
export function getAppOctokit(): Octokit {
    const { appId, privateKey } = getAppConfig();
    return new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey },
    });
}

/**
 * Create an installation-scoped Octokit with a temporary token.
 * Token auto-expires after ~1 hour.
 */
export async function getInstallationOctokit(installationId: number): Promise<Octokit> {
    const { appId, privateKey } = getAppConfig();
    const auth = createAppAuth({ appId, privateKey });
    const installationAuth = await auth({ type: 'installation', installationId });

    return new Octokit({ auth: installationAuth.token });
}

/**
 * Get a raw installation token for external systems (e.g. Docker login)
 */
export async function getInstallationToken(installationId: number): Promise<string> {
    const { appId, privateKey } = getAppConfig();
    const auth = createAppAuth({ appId, privateKey });
    const { token } = await auth({ type: 'installation', installationId });
    return token;
}

// ─── Repo Listing ───────────────────────────────────────────

/**
 * List repositories accessible to a given installation.
 */
export async function listRepos(installationId: number) {
    const octokit = await getInstallationOctokit(installationId);
    const { data } = await octokit.apps.listReposAccessibleToInstallation({
        per_page: 100,
    });

    return data.repositories.map((repo) => ({
        id: repo.id,
        fullName: repo.full_name,
        name: repo.name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        cloneUrl: repo.clone_url,
        htmlUrl: repo.html_url,
        description: repo.description,
        language: repo.language,
        updatedAt: repo.updated_at,
    }));
}

// ─── Webhook Signature Verification ─────────────────────────

/**
 * Verify the GitHub webhook signature (x-hub-signature-256).
 */
export function verifyWebhookSignature(payload: string, signature: string): boolean {
    const { webhookSecret } = getAppConfig();
    if (!webhookSecret) {
        console.warn('[GitHub] GITHUB_WEBHOOK_SECRET not set — skipping signature verification');
        return true; // Allow in development
    }

    const expected = 'sha256=' + crypto
        .createHmac('sha256', webhookSecret)
        .update(payload, 'utf-8')
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected),
    );
}

/**
 * Generate a temporary clone URL for a private repo using installation token.
 */
export async function getAuthenticatedCloneUrl(
    installationId: number,
    repoFullName: string,
): Promise<string> {
    const { appId, privateKey } = getAppConfig();
    const auth = createAppAuth({ appId, privateKey });
    const { token } = await auth({ type: 'installation', installationId });

    return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
}

// ─── Deployments ────────────────────────────────────────────

export interface GitHubCreateDeploymentParams {
    installationId: number;
    repoFullName: string; // "owner/repo"
    ref: string; // branch name or commit hash
    environment?: string; // e.g. "production" or "Preview"
    description?: string;
}

/**
 * Creates a new GitHub deployment (status: pending).
 * Returns the deployment ID if successful, or null on failure.
 */
export async function createGitHubDeployment(params: GitHubCreateDeploymentParams): Promise<number | null> {
    const { installationId, repoFullName, ref, environment = 'production', description } = params;

    if (!repoFullName.includes('/')) return null;
    const [owner, repo] = repoFullName.split('/');

    try {
        const octokit = await getInstallationOctokit(installationId);
        const { data } = await octokit.repos.createDeployment({
            owner,
            repo,
            ref,
            environment,
            description,
            auto_merge: false,
            required_contexts: [], // bypass status checks
        });

        // GitHub API can sometimes return a message object if creation failed 
        // due to commit status checks (though we pass required_contexts: [])
        if ('id' in data) {
            return data.id;
        }
        return null;
    } catch (error: unknown) {
        console.error(`[GitHub] Failed to create deployment for ${repoFullName}@${ref}:`, error instanceof Error ? error.message : String(error));
        return null;
    }
}

export interface GitHubUpdateDeploymentStatusParams {
    installationId: number;
    repoFullName: string;
    deploymentId: number;
    state: 'error' | 'failure' | 'inactive' | 'in_progress' | 'queued' | 'pending' | 'success';
    environmentUrl?: string; // URL of the live site
    logUrl?: string; // URL back to dashboard logs
    description?: string;
}

/**
 * Updates the state of an existing GitHub deployment.
 */
export async function updateGitHubDeploymentStatus(params: GitHubUpdateDeploymentStatusParams): Promise<void> {
    const { installationId, repoFullName, deploymentId, state, environmentUrl, logUrl, description } = params;

    if (!repoFullName.includes('/')) return;
    const [owner, repo] = repoFullName.split('/');

    try {
        const octokit = await getInstallationOctokit(installationId);
        await octokit.repos.createDeploymentStatus({
            owner,
            repo,
            deployment_id: deploymentId,
            state,
            environment_url: environmentUrl,
            log_url: logUrl,
            description,
            auto_inactive: true, // auto mark older deployments to this environment as inactive
        });
    } catch (error: unknown) {
        console.error(`[GitHub] Failed to update status ${deploymentId} to ${state}:`, error instanceof Error ? error.message : String(error));
    }
}

export interface GitHubCreateCommentParams {
    installationId: number;
    repoFullName: string;
    prNumber: number;
    body: string;
}

/**
 * Creates a comment on a Pull Request.
 */
export async function createPullRequestComment(params: GitHubCreateCommentParams): Promise<void> {
    const { installationId, repoFullName, prNumber, body } = params;
    if (!repoFullName.includes('/')) return;
    const [owner, repo] = repoFullName.split('/');

    try {
        const octokit = await getInstallationOctokit(installationId);
        await octokit.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body
        });
    } catch (error: unknown) {
        console.error(`[GitHub] Failed to create PR comment for ${repoFullName}#${prNumber}:`, error instanceof Error ? error.message : String(error));
    }
}
