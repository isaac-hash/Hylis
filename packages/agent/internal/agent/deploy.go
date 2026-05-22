package agent

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type deployPayload struct {
	Project struct {
		Name              string            `json:"name"`
		RepoURL           string            `json:"repoUrl"`
		Branch            string            `json:"branch"`
		DeployPath        string            `json:"deployPath"`
		BuildCommand      string            `json:"buildCommand"`
		StartCommand      string            `json:"startCommand"`
		DeployStrategy    string            `json:"deployStrategy"`
		Env               map[string]string `json:"env"`
		GhcrImage         string            `json:"ghcrImage"`
		DockerComposeYaml string            `json:"dockerComposeYaml"`
		ContainerName     string            `json:"containerName"`
		DockerComposeFile string            `json:"dockerComposeFile"`
		AnalyticsScript   string            `json:"analyticsScript"` // Pre-built <script> tag; empty = skip
		SentryDsn         string            `json:"sentryDsn"`
		RegistryAuth      *struct {
			Registry string `json:"registry"`
			Username string `json:"username"`
			Password string `json:"password"`
		} `json:"registryAuth,omitempty"`
	} `json:"project"`
	Domains []struct {
		Hostname     string `json:"hostname"`
		UpstreamPort string `json:"upstreamPort"`
	} `json:"domains"`
	TLSMode string `json:"tlsMode"`
	Trigger string `json:"trigger"`
}

type deployResult struct {
	Success   bool   `json:"success"`
	ReleaseID string `json:"releaseId"`
	URL       string `json:"url,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (a *Agent) handleDeploy(msg Message) {
	var p deployPayload
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		a.sendError(msg.CommandID, "invalid deploy payload: "+err.Error())
		return
	}

	go func() {
		result := a.executeDeploy(msg.CommandID, &p)
		resultJSON, _ := json.Marshal(result)
		a.send <- Message{
			Type:      "command_done",
			CommandID: msg.CommandID,
			Done:      true,
			Data:      string(resultJSON),
			ExitCode:  boolToInt(!result.Success),
		}
	}()
}

func (a *Agent) executeDeploy(commandID string, p *deployPayload) deployResult {
	log := func(s string) { a.sendChunk(commandID, s) }

	releaseID := time.Now().Format("20060102150405")
	releasePath := filepath.Join(p.Project.DeployPath, "releases", releaseID)
	currentPath := filepath.Join(p.Project.DeployPath, "current")

	containerName := p.Project.ContainerName
	if containerName == "" {
		containerName = p.Project.Name + "-app"
	}

	log(fmt.Sprintf("\x1b[36m[%s] Starting deployment for %s...\x1b[0m\n", releaseID, p.Project.Name))

	if err := os.MkdirAll(releasePath, 0755); err != nil {
		return deployResult{Error: "mkdir failed: " + err.Error()}
	}

	// Pre-flight: ensure hylius docker network
	runLocal("docker network create hylius 2>/dev/null || true", nil)
	// Remove stale container
	runLocal(fmt.Sprintf("docker rm -f %s > /dev/null 2>&1 || true", containerName), nil)
	// Prune dangling images
	runLocal("docker image prune -f > /dev/null 2>&1 || true", nil)

	// Clone or write compose yaml
	strategy := p.Project.DeployStrategy
	if strategy != "ghcr-pull" {
		if p.Project.DockerComposeYaml != "" {
			composePath := filepath.Join(releasePath, "docker-compose.yml")
			if err := os.WriteFile(composePath, []byte(p.Project.DockerComposeYaml), 0644); err != nil {
				return deployResult{Error: "write compose: " + err.Error()}
			}
			log("Template compose file written.\n")
		} else {
			branch := p.Project.Branch
			if branch == "" {
				branch = "main"
			}
			log(fmt.Sprintf("Cloning %s (%s)...\n", p.Project.RepoURL, branch))
			code := runStream(
				fmt.Sprintf("git clone -b %s --depth 1 %s %s", branch, p.Project.RepoURL, releasePath),
				log,
			)
			if code != 0 {
				return deployResult{Error: "git clone failed"}
			}
		}
	}

	// Resolve strategy
	if strategy == "" || strategy == "auto" {
		strategy = resolveDeployStrategy(releasePath)
	}
	log(fmt.Sprintf("Deploy strategy: %s\n", strategy))

	// Inject analytics and error tracking scripts (before build so frameworks can pick it up)
	if p.Project.AnalyticsScript != "" || p.Project.SentryDsn != "" {
		injectTrackingScripts(releasePath, p.Project.AnalyticsScript, p.Project.SentryDsn, strategy, log)
	}

	// Write .env file for compose strategies
	if isComposeStrategy(strategy) && len(p.Project.Env) > 0 {
		writeEnvFile(releasePath, p.Project.Env, log)
	}

	var finalURL string
	var deployErr error

	switch strategy {
	case "docker-compose", "compose-server", "compose-registry":
		finalURL, deployErr = a.deployCompose(releasePath, currentPath, p, log)
	case "railpack":
		finalURL, deployErr = a.deployRailpack(releasePath, currentPath, containerName, p, log)
	case "dockerfile":
		finalURL, deployErr = a.deployDockerfile(releasePath, currentPath, containerName, p, log)
	case "ghcr-pull":
		finalURL, deployErr = a.deployGHCR(releasePath, currentPath, containerName, p, log)
	case "nixpacks":
		finalURL, deployErr = a.deployNixpacks(releasePath, currentPath, containerName, p, log)
	default: // pm2
		finalURL, deployErr = a.deployPM2(releasePath, currentPath, p, log)
	}

	if deployErr != nil {
		return deployResult{Error: deployErr.Error()}
	}

	// Symlink
	runLocal(fmt.Sprintf("ln -sfn %s %s", releasePath, currentPath), nil)

	// Open UFW firewall for the assigned port (matches SSH deploy path behaviour)
	if finalURL != "" {
		port := extractPort(finalURL)
		if port != "" && port != "80" && port != "443" {
			log(fmt.Sprintf("Opening UFW firewall for port %s...\n", port))
			runLocal(fmt.Sprintf("ufw allow %s/tcp > /dev/null 2>&1 || true", port), nil)
		}
	}

	// Configure Caddy if domains provided
	if len(p.Domains) > 0 && finalURL != "" {
		appPort := extractPort(finalURL)
		domains := make([]caddyDomain, len(p.Domains))
		for i, d := range p.Domains {
			port := d.UpstreamPort
			if port == "" {
				port = appPort
			}
			domains[i] = caddyDomain{Hostname: d.Hostname, UpstreamPort: port}
		}
		tlsMode := p.TLSMode
		if tlsMode == "" {
			tlsMode = "production"
		}
		if err := configureCaddy(domains, tlsMode, log); err != nil {
			log(fmt.Sprintf("\x1b[33mWarning: Caddy update failed: %v\x1b[0m\n", err))
		} else if len(domains) > 0 {
			finalURL = "https://" + domains[0].Hostname
		}
	}

	log(fmt.Sprintf("\n\x1b[32m✅ Deployment successful! Release: %s\x1b[0m\n", releaseID))
	if finalURL != "" {
		log(fmt.Sprintf("\x1b[36m🌐 URL: %s\x1b[0m\n", finalURL))
	}

	return deployResult{Success: true, ReleaseID: releaseID, URL: finalURL}
}

// ─── Strategy implementations ─────────────────────────────────────────────────

func (a *Agent) deployCompose(releasePath, currentPath string, p *deployPayload, log func(string)) (string, error) {
	composeFile := p.Project.DockerComposeFile
	if composeFile == "" {
		composeFile = "docker-compose.yml"
	}
	if _, err := os.Stat(filepath.Join(releasePath, composeFile)); os.IsNotExist(err) {
		composeFile = "compose.yaml"
	}

	projectName := composeProjectName(p.Project.Name)
	log(fmt.Sprintf("Running Docker Compose (%s)...\n", composeFile))
	code := runStream(
		fmt.Sprintf("cd %s && docker compose -p %s -f %s up -d --build --remove-orphans", releasePath, projectName, composeFile),
		log,
	)
	if code != 0 {
		return "", fmt.Errorf("docker compose failed")
	}

	// Detect mapped port
	out, _ := exec.Command("docker", "ps", "--filter", "name="+projectName, "--format", "{{.Ports}}").Output()
	port := extractPortFromDockerPS(string(out))
	url := "http://localhost"
	if port != "" {
		url = "http://localhost:" + port
	}
	return url, nil
}

func (a *Agent) deployRailpack(releasePath, currentPath, containerName string, p *deployPayload, log func(string)) (string, error) {
	imageName := imageName(p.Project.Name)
	hostPort := findFreePort(3011)
	envArgs := buildEnvArgs(p.Project.Env)
	containerPort := envOrDefault(p.Project.Env, "PORT", "3000")

	// Ensure buildkit running
	runLocal("docker start buildkit 2>/dev/null || docker run --privileged -d --name buildkit --restart unless-stopped moby/buildkit", nil)
	log(fmt.Sprintf("Building with Railpack: %s\n", imageName))
	code := runStream(
		fmt.Sprintf("cd %s && BUILDKIT_HOST=docker-container://buildkit railpack build . --name %s%s", releasePath, imageName, envArgs),
		log,
	)
	if code != 0 {
		return "", fmt.Errorf("railpack build failed")
	}
	return a.runContainer(containerName, imageName, hostPort, containerPort, envArgs, log)
}

func (a *Agent) deployDockerfile(releasePath, currentPath, containerName string, p *deployPayload, log func(string)) (string, error) {
	img := imageName(p.Project.Name)
	hostPort := findFreePort(3011)
	containerPort := envOrDefault(p.Project.Env, "PORT", "3000")
	envArgs := buildEnvArgs(p.Project.Env)
	buildArgs := buildBuildArgs(p.Project.Env, "--build-arg")

	log(fmt.Sprintf("Building Docker image: %s\n", img))
	code := runStream(fmt.Sprintf("cd %s && docker build %s -t %s .", releasePath, buildArgs, img), log)
	if code != 0 {
		return "", fmt.Errorf("docker build failed")
	}
	return a.runContainer(containerName, img, hostPort, containerPort, envArgs, log)
}

func (a *Agent) deployGHCR(releasePath, currentPath, containerName string, p *deployPayload, log func(string)) (string, error) {
	image := p.Project.GhcrImage
	if image == "" {
		return "", fmt.Errorf("no ghcrImage set — wait for GitHub Actions to build the image first")
	}
	hostPort := findFreePort(3011)
	containerPort := envOrDefault(p.Project.Env, "PORT", "3000")
	envArgs := buildEnvArgs(p.Project.Env)

	if p.Project.RegistryAuth != nil {
		auth := p.Project.RegistryAuth
		log(fmt.Sprintf("Authenticating with registry: %s\n", auth.Registry))
		
		cmd := fmt.Sprintf("echo '%s' | docker login %s -u '%s' --password-stdin", 
			strings.ReplaceAll(auth.Password, "'", "'\\''"), 
			auth.Registry, 
			strings.ReplaceAll(auth.Username, "'", "'\\''"))
			
		if code := runStream(cmd, log); code != 0 {
			return "", fmt.Errorf("docker login failed")
		}
	}

	log(fmt.Sprintf("Pulling image: %s\n", image))
	if code := runStream("docker pull "+image, log); code != 0 {
		return "", fmt.Errorf("docker pull failed")
	}
	return a.runContainer(containerName, image, hostPort, containerPort, envArgs, log)
}

func (a *Agent) deployNixpacks(releasePath, currentPath, containerName string, p *deployPayload, log func(string)) (string, error) {
	img := imageName(p.Project.Name)
	hostPort := findFreePort(3011)
	containerPort := envOrDefault(p.Project.Env, "PORT", "3000")
	envArgs := buildEnvArgs(p.Project.Env)
	buildArgs := buildBuildArgs(p.Project.Env, "--env")

	log(fmt.Sprintf("Building with Nixpacks: %s\n", img))
	code := runStream(fmt.Sprintf("cd %s && nixpacks build . --name %s%s", releasePath, img, buildArgs), log)
	if code != 0 {
		return "", fmt.Errorf("nixpacks build failed")
	}
	return a.runContainer(containerName, img, hostPort, containerPort, envArgs, log)
}

func (a *Agent) deployPM2(releasePath, currentPath string, p *deployPayload, log func(string)) (string, error) {
	pkgManager := "npm"
	if fileExists(filepath.Join(releasePath, "pnpm-lock.yaml")) {
		pkgManager = "pnpm"
	} else if fileExists(filepath.Join(releasePath, "yarn.lock")) {
		pkgManager = "yarn"
	}
	log(fmt.Sprintf("Installing deps with %s...\n", pkgManager))
	if code := runStream(fmt.Sprintf("cd %s && %s install", releasePath, pkgManager), log); code != 0 {
		return "", fmt.Errorf("install failed")
	}

	if p.Project.BuildCommand != "" {
		log("Running build...\n")
		if code := runStream(fmt.Sprintf("cd %s && %s", releasePath, p.Project.BuildCommand), log); code != 0 {
			return "", fmt.Errorf("build failed")
		}
	}

	runLocal(fmt.Sprintf("ln -sfn %s %s", releasePath, currentPath), nil)
	runLocal(fmt.Sprintf("pm2 delete %q > /dev/null 2>&1 || true", p.Project.Name), nil)

	startCmd := fmt.Sprintf("cd %s && pm2 start %s --name %q -- start", currentPath, pkgManager, p.Project.Name)
	if p.Project.StartCommand != "" {
		startCmd = fmt.Sprintf("cd %s && %s", currentPath, p.Project.StartCommand)
	}

	log("Starting with PM2...\n")
	if code := runStream(startCmd, log); code != 0 {
		return "", fmt.Errorf("pm2 start failed")
	}
	return "http://localhost:3000", nil
}

func (a *Agent) runContainer(name, image, hostPort, containerPort string, envArgs string, log func(string)) (string, error) {
	cmd := fmt.Sprintf(
		"docker rm -f %s > /dev/null 2>&1 || true && docker run -d --name %s%s -e PORT=%s --network hylius --restart unless-stopped -p %s:%s %s",
		name, name, envArgs, containerPort, hostPort, containerPort, image,
	)
	log(fmt.Sprintf("Starting container %s (port %s→%s)...\n", name, hostPort, containerPort))
	if code := runStream(cmd, log); code != 0 {
		return "", fmt.Errorf("docker run failed")
	}
	url := fmt.Sprintf("http://localhost:%s", hostPort)
	log(fmt.Sprintf("\x1b[36m🌐 Application URL: %s\x1b[0m\n", url))
	return url, nil
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func resolveDeployStrategy(path string) string {
	for _, f := range []string{"docker-compose.yml", "compose.yaml"} {
		if fileExists(filepath.Join(path, f)) {
			return "docker-compose"
		}
	}
	if fileExists(filepath.Join(path, "Dockerfile")) {
		return "dockerfile"
	}
	if fileExists(filepath.Join(path, "nixpacks.toml")) {
		return "nixpacks"
	}
	return "railpack"
}

func isComposeStrategy(s string) bool {
	return s == "docker-compose" || s == "compose-server" || s == "compose-registry"
}

// ─── Analytics & Error Tracking Script Injection ───────────────────────────────────────────────

func injectTrackingScripts(releasePath, analyticsScript, sentryDsn, strategy string, log func(string)) {
	if strategy == "ghcr-pull" {
		log("[Tracking] Skipping injection — pre-built image. Enable a sidecar proxy for GHCR projects.\n")
		return
	}

	injected := false

	var scriptBuilder strings.Builder
	if analyticsScript != "" {
		scriptBuilder.WriteString(analyticsScript)
	}
	if sentryDsn != "" {
		sentryScript := fmt.Sprintf(`<script src="https://browser.sentry-cdn.com/7.73.0/bundle.min.js" crossorigin="anonymous"></script><script>Sentry.init({dsn: "%s"});</script>`, sentryDsn)
		scriptBuilder.WriteString("\n" + sentryScript)
	}
	script := scriptBuilder.String()

	if script == "" {
		return
	}

	// Define a WalkDirFunc to search for files
	err := filepath.WalkDir(releasePath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // ignore errors
		}
		
		// Stop if already injected
		if injected {
			return filepath.SkipDir
		}

		// Skip irrelevant directories
		if d.IsDir() {
			name := d.Name()
			if name == "node_modules" || name == "vendor" || name == ".git" || name == "dist" || name == "build" {
				return filepath.SkipDir
			}
			return nil
		}

		// 1. Next.js app router layout (layout.tsx or layout.jsx)
		name := d.Name()
		if name == "layout.tsx" || name == "layout.jsx" {
			if injectIntoNextLayout(path, script, log) {
				injected = true
				return filepath.SkipDir
			}
		}

		// 2. Next.js pages router document (_document.tsx or _document.jsx)
		if name == "_document.tsx" || name == "_document.jsx" {
			if injectIntoHead(path, "</Head>", script, log) {
				injected = true
				return filepath.SkipDir
			}
		}

		// 3. Laravel Blade (*.blade.php) - could be in layouts or standalone like welcome.blade.php
		if strings.HasSuffix(name, ".blade.php") {
			if injectIntoHead(path, "</head>", script, log) {
				injected = true
				return filepath.SkipDir
			}
		}

		// 4. Generic index.html
		if name == "index.html" {
			if injectIntoHead(path, "</head>", script, log) {
				injected = true
				return filepath.SkipDir
			}
		}

		return nil
	})

	if err != nil {
		log(fmt.Sprintf("[Tracking] WalkDir error: %v\n", err))
	}

	if !injected {
		log("[Analytics] Could not find a suitable injection point. Add the script tag manually.\n")
		log(fmt.Sprintf("[Analytics] Script: %s\n", script))
	}
}

// injectIntoNextLayout injects a Next.js <Script> component into layout.tsx.
// It imports Script from 'next/script' and adds it inside the <body> tag.
func injectIntoNextLayout(path, rawScript string, log func(string)) bool {
	content, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	src := string(content)

	// Skip if already injected
	if strings.Contains(src, "data-website-id") || strings.Contains(src, "Sentry.init") {
		log(fmt.Sprintf("[Tracking] Script already present in %s\n", filepath.Base(path)))
		return true
	}

	var scripts []string

	// Check for Umami
	scriptSrc := extractAttr(rawScript, "src")
	siteId := extractAttr(rawScript, "data-website-id")
	if scriptSrc != "" && siteId != "" && strings.Contains(scriptSrc, "umami") {
		scripts = append(scripts, fmt.Sprintf(`<Script defer src="%s" data-website-id="%s" strategy="afterInteractive" />`, scriptSrc, siteId))
	}

	// Check for Sentry
	if strings.Contains(rawScript, "Sentry.init") {
		// Extract DSN
		prefix := `dsn: "`
		start := strings.Index(rawScript, prefix)
		if start > 0 {
			start += len(prefix)
			end := strings.Index(rawScript[start:], `"`)
			if end > 0 {
				dsn := rawScript[start : start+end]
				sentryScript := fmt.Sprintf(`<Script src="https://browser.sentry-cdn.com/7.73.0/bundle.min.js" strategy="beforeInteractive" crossorigin="anonymous" />
      <Script id="sentry-init" strategy="afterInteractive" dangerouslySetInnerHTML={{ __html: "Sentry.init({ dsn: '%s' });" }} />`, dsn)
				scripts = append(scripts, sentryScript)
			}
		}
	}

	if len(scripts) == 0 {
		return false
	}

	nextScript := strings.Join(scripts, "\n      ")

	// Add import if not present
	if !strings.Contains(src, `from 'next/script'`) && !strings.Contains(src, `from "next/script"`) {
		src = strings.Replace(src, "import ", `import Script from 'next/script';`+"\nimport ", 1)
	}

	// Inject before </body>
	if strings.Contains(src, "</body>") {
		src = strings.Replace(src, "</body>", nextScript+"\n      </body>", 1)
	} else {
		// Fallback: inject at end of file before closing JSX
		src = src + "\n" + nextScript
	}

	if err := os.WriteFile(path, []byte(src), 0644); err != nil {
		log(fmt.Sprintf("[Tracking] Failed to write %s: %v\n", filepath.Base(path), err))
		return false
	}
	log(fmt.Sprintf("[Tracking] ✅ Injected Next.js Script component into %s\n", filepath.Base(path)))
	return true
}

// injectIntoHead inserts the script tag before a closing tag (e.g. </head> or </Head>).
func injectIntoHead(path, closingTag, script string, log func(string)) bool {
	content, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	src := string(content)

	if strings.Contains(src, "data-website-id") {
		log(fmt.Sprintf("[Analytics] Script already present in %s\n", filepath.Base(path)))
		return true
	}

	lowerSrc := strings.ToLower(src)
	lowerTag := strings.ToLower(closingTag)
	idx := strings.LastIndex(lowerSrc, lowerTag)
	if idx < 0 {
		return false
	}

	// Find the actual position in original src preserving original case
	src = src[:idx] + "\n    " + script + "\n" + src[idx:]

	if err := os.WriteFile(path, []byte(src), 0644); err != nil {
		log(fmt.Sprintf("[Analytics] Failed to write %s: %v\n", filepath.Base(path), err))
		return false
	}
	log(fmt.Sprintf("[Analytics] ✅ Injected tracking script into %s\n", filepath.Base(path)))
	return true
}

// extractAttr pulls an HTML attribute value from a raw tag string.
func extractAttr(tag, attr string) string {
	prefix := attr + `="`
	start := strings.Index(tag, prefix)
	if start < 0 {
		prefix = attr + `='`
		start = strings.Index(tag, prefix)
		if start < 0 {
			return ""
		}
	}
	start += len(prefix)
	end := strings.IndexAny(tag[start:], `"'`)
	if end < 0 {
		return ""
	}
	return tag[start : start+end]
}


func writeEnvFile(path string, env map[string]string, log func(string)) {
	var lines []string
	for k, v := range env {
		lines = append(lines, k+"="+strings.ReplaceAll(v, "\n", "\\n"))
	}
	content := strings.Join(lines, "\n")
	encoded := base64.StdEncoding.EncodeToString([]byte(content))
	runLocal(fmt.Sprintf("echo '%s' | base64 -d > %s/.env", encoded, path), nil)
	log(fmt.Sprintf("Wrote %d env vars to .env\n", len(env)))
}

func buildEnvArgs(env map[string]string) string {
	var sb strings.Builder
	for k, v := range env {
		v = strings.ReplaceAll(v, `"`, `\"`)
		sb.WriteString(fmt.Sprintf(` -e "%s=%s"`, k, v))
	}
	return sb.String()
}

func buildBuildArgs(env map[string]string, flag string) string {
	var sb strings.Builder
	for k, v := range env {
		v = strings.ReplaceAll(v, `"`, `\"`)
		sb.WriteString(fmt.Sprintf(` %s "%s=%s"`, flag, k, v))
	}
	return sb.String()
}

func composeProjectName(name string) string {
	return strings.ToLower(strings.NewReplacer(" ", "-", "_", "-").Replace(name))
}

func imageName(name string) string {
	slug := strings.ToLower(name)
	for _, c := range []string{" ", "_", "."} {
		slug = strings.ReplaceAll(slug, c, "-")
	}
	return slug + ":latest"
}

func envOrDefault(env map[string]string, key, def string) string {
	if v, ok := env[key]; ok && v != "" {
		return v
	}
	return def
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func extractPort(url string) string {
	parts := strings.Split(url, ":")
	if len(parts) == 3 {
		return parts[2]
	}
	return "3000"
}

func extractPortFromDockerPS(output string) string {
	// output like "0.0.0.0:3011->3000/tcp"
	for _, part := range strings.Fields(output) {
		if idx := strings.Index(part, "->"); idx > 0 {
			hostPart := part[:idx]
			colonIdx := strings.LastIndex(hostPart, ":")
			if colonIdx >= 0 {
				return hostPart[colonIdx+1:]
			}
		}
	}
	return ""
}

func findFreePort(start int) string {
	for p := start; p <= 3100; p++ {
		out, _ := exec.Command("bash", "-c",
			fmt.Sprintf("docker ps --format '{{.Ports}}' | grep -q ':%d->' || echo FREE", p),
		).Output()
		if strings.TrimSpace(string(out)) == "FREE" {
			return fmt.Sprintf("%d", p)
		}
	}
	return fmt.Sprintf("%d", start)
}

func runLocal(cmd string, log func(string)) int {
	c := exec.Command("bash", "-c", cmd)
	if err := c.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		return 1
	}
	return 0
}

func runStream(cmd string, log func(string)) int {
	c := exec.Command("bash", "-c", cmd)
	c.Stdout = &logWriter{log: log}
	c.Stderr = &logWriter{log: log}
	if err := c.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		return 1
	}
	return 0
}

// logWriter adapts an io.Writer to a log callback
type logWriter struct{ log func(string) }

func (w *logWriter) Write(p []byte) (n int, err error) {
	w.log(string(p))
	return len(p), nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
