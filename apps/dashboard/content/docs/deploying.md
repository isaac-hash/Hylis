# Deploying Your App

Whether you use the Dashboard or the `hylius deploy` CLI command, Hylius pushes your application to your VPS using an **atomic symlink-swap** strategy — ensuring zero-downtime for every deployment.

When triggered from the Dashboard, the deployment is routed instantly over WebSockets to the connected **Hylius Agent**, eliminating the need to establish new SSH connections.

---

## How Deployment Works

```
1. Clone your Git repo into a timestamped release directory on the VPS
2. Build a Docker image (Dockerfile → Railpack → Nixpacks, in that order)
3. Start the new container(s)
4. Atomically swap the symlink from the old release to the new one
5. Old container is gracefully stopped
```

Every release directory is retained on the server, making instant rollbacks possible.

---

## Running `hylius deploy`

Navigate to your project directory and run:

```bash
hylius deploy
```

### Interactive Prompts

```
🔍 Configuration needed for deployment

? VPS Host IP:              › 203.0.113.42
? VPS Username:             › root
? SSH Port:                 › 22
? Target Path on VPS:       › /var/www/my-app
? Git Repository URL:       › https://github.com/your-org/your-repo.git
? Authentication Method:    › SSH Agent (Recommended)
```

After answering, you'll see live server logs as your app builds and starts:

```
[Server] Step 1/8 : FROM node:20-alpine
[Server] Step 2/8 : WORKDIR /app
[Server] ...
✔ Deployment Successful! Release ID: 1713049234512
   Duration: 14320ms
   Commit: a3f92c1
```

---

## Deployment Strategies

Hylius selects a build strategy based on what exists in your project root:

| Strategy           | Trigger                          | Description                                                |
| ------------------ | -------------------------------- | ---------------------------------------------------------- |
| **Docker Compose** | `compose.yaml` exists            | Runs `docker compose up -d --build`                        |
| **Dockerfile**     | `Dockerfile` exists (no compose) | Builds and runs a single container                         |
| **Auto-generate**  | Neither exists                   | Railpack detects your stack and generates Docker artifacts |

> [!TIP]
> You don't need a `Dockerfile` to deploy. Hylius will detect your project type (Node.js, Python, PHP, Go, etc.) via Railpack and generate the right Docker configuration automatically.

---

## Deploying a Local Directory

You can deploy directly from a local folder without pushing to GitHub first:

```bash
hylius deploy
# When asked for Git Repository URL, enter a local path:
? Git Repository URL: › ./  (or an absolute path like /home/username/my-app)
```

Hylius will:

1. Bundle your project (excluding `node_modules`, `.git`, `.next`, `dist`)
2. Upload the archive over SSH (SFTP)
3. Deploy from the uploaded bundle

This is useful for:

- Hot fixes that aren't committed yet
- Deploying monorepo sub-packages
- Testing before pushing to Git

---

## Environment Variables on the VPS

Hylius does not manage environment variables for you at the CLI level. The recommended approach is to create a `.env` file directly on your VPS in the deployment target directory:

```bash
# SSH into your VPS
ssh root@YOUR_VPS_IP

# Create your env file in the deploy path
nano /var/www/my-app/.env
```

Your `compose.yaml` or `Dockerfile` should then reference it with `env_file: .env`.

> [!NOTE]
> If you use the **Hylius Dashboard**, environment variables can be managed through the web UI under **Projects → Env Variables**. The dashboard's GitHub Actions CI pipeline fetches them automatically at build time.

---

## CI/CD Mode (Headless Deployment)

When the `CI` or `GITHUB_ACTIONS` environment variable is set, `hylius deploy` requires no prompts and reads config from env vars:

| Variable               | Description                    | Required                         |
| ---------------------- | ------------------------------ | -------------------------------- |
| `HYLIUS_HOST`          | VPS IP address                 | Yes                              |
| `HYLIUS_REPO_URL`      | Git URL to clone on the server | Yes                              |
| `HYLIUS_TARGET_PATH`   | Remote path to deploy into     | Yes                              |
| `HYLIUS_USER`          | SSH username                   | No (defaults to `root`)          |
| `HYLIUS_PORT`          | SSH port                       | No (defaults to `22`)            |
| `HYLIUS_SSH_KEY`       | Full SSH private key content   | Auth required                    |
| `HYLIUS_SSH_KEY_PATH`  | Path to private key file       | Auth required                    |
| `HYLIUS_PASSWORD`      | SSH password                   | Auth required                    |
| `GHCR_PAT`             | GitHub Container Registry Token| Optional                         |
| `HYLIUS_BRANCH`        | Git branch to clone            | No (defaults to `main`)          |
| `HYLIUS_BUILD_COMMAND` | Build command                  | No (defaults to `npm run build`) |
| `HYLIUS_START_COMMAND` | Start command                  | No (defaults to PM2)             |

### Example `.env` for CI testing:

```bash
HYLIUS_HOST=203.0.113.42
HYLIUS_USER=root
HYLIUS_SSH_KEY="-----BEGIN OPENSSH PRIVATE KEY-----\n..."
HYLIUS_REPO_URL=https://github.com/your-org/your-repo.git
HYLIUS_TARGET_PATH=/var/www/my-app
```

---

## Framework-Specific Tips

### Node.js / Next.js

Make sure your app listens on `0.0.0.0` and not `localhost`:

```js
// next.config.js — no change needed, Next.js binds correctly by default

// For custom express/node servers:
app.listen(3000, "0.0.0.0");
```

### Python / FastAPI

Bind Uvicorn to `0.0.0.0` so Docker port mapping works:

```python
# main.py
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

### Laravel (PHP)

Add the `pdo_pgsql` extension if you're using PostgreSQL:

```json
// composer.json
"require": {
    "ext-pdo_pgsql": "*"
}
```

Then run `hylius deploy` (or redeploy from the dashboard) to rebuild the container with the new extension.

---

## After Deployment

Your app is live! To verify:

```bash
curl http://YOUR_VPS_IP
# or
curl http://YOUR_VPS_IP:PORT
```

To automate future deploys on every `git push`, see the [CI/CD Guide](./CI-CD.md).
