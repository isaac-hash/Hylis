package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)


type setupPayload struct {
	AgentToken string `json:"agentToken"`
	ServerURL  string `json:"serverUrl"`
	ServerID   string `json:"serverId"`
}

// handleSetup runs the initial VPS provisioning: Docker, Caddy, UFW, and agent config.
// This is only called once during server onboarding and mirrors setup.ts logic.
func (a *Agent) handleSetup(msg Message) {
	var p setupPayload
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		a.sendError(msg.CommandID, "invalid setup payload: "+err.Error())
		return
	}

	go func() {
		log := func(s string) { a.sendChunk(msg.CommandID, s) }
		if err := runSetup(log); err != nil {
			a.sendError(msg.CommandID, err.Error())
		} else {
			a.sendDone(msg.CommandID, 0)
		}
	}()
}

func runSetup(log func(string)) error {
	steps := []struct {
		name string
		cmds []string
	}{
		{
			name: "Updating package lists",
			cmds: []string{"apt-get update -y"},
		},
		{
			name: "Installing Docker",
			cmds: []string{
				"apt-get install -y ca-certificates curl gnupg lsb-release",
				"mkdir -p /etc/apt/keyrings",
				"curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg || true",
				`echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null`,
				"apt-get update -y",
				"apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin git",
			},
		},
		{
			name: "Installing Node.js + PM2",
			cmds: []string{
				"curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
				"apt-get install -y nodejs",
				"npm install -g pm2",
			},
		},
		{
			name: "Installing Railpack + BuildKit",
			cmds: []string{
				"curl -sSL https://railpack.com/install.sh | sh",
				"docker rm -f buildkit > /dev/null 2>&1 || true",
				"docker run --privileged -d --name buildkit --restart unless-stopped moby/buildkit",
			},
		},
		{
			name: "Setting up Caddy reverse proxy",
			cmds: []string{
				"mkdir -p /opt/hylius/caddy/data /opt/hylius/caddy/config",
				"test -f /opt/hylius/caddy/Caddyfile || echo '# Hylius Managed Caddyfile' > /opt/hylius/caddy/Caddyfile",
				"docker pull caddy:2-alpine",
				"docker rm -f hylius-caddy > /dev/null 2>&1 || true",
				"docker run -d --name hylius-caddy --restart unless-stopped --network host -v /opt/hylius/caddy/Caddyfile:/etc/caddy/Caddyfile -v /opt/hylius/caddy/data:/data -v /opt/hylius/caddy/config:/config caddy:2-alpine",
			},
		},
		{
			name: "Configuring UFW firewall",
			cmds: []string{
				"apt-get install -y ufw > /dev/null 2>&1 || true",
				"ufw allow 22/tcp > /dev/null 2>&1 || true",
				"ufw allow 80/tcp > /dev/null 2>&1 || true",
				"ufw allow 443/tcp > /dev/null 2>&1 || true",
				`echo "y" | ufw enable > /dev/null 2>&1 || true`,
			},
		},
	}

	for i, step := range steps {
		log(fmt.Sprintf("\x1b[33m[%d/%d] %s...\x1b[0m\n", i+1, len(steps), step.name))
		for _, cmd := range step.cmds {
			log(fmt.Sprintf("> %s\n", cmd))
			if code := runStream(cmd, log); code != 0 {
				return fmt.Errorf("step %q failed: %s", step.name, cmd)
			}
		}
		log(fmt.Sprintf("\x1b[32m✓ %s\x1b[0m\n\n", step.name))
	}

	log("\x1b[32m\x1b[1m✅ Server provisioning complete!\x1b[0m\n")
	return nil
}

// ─── Database handlers ────────────────────────────────────────────────────────

type provisionDBPayload struct {
	Name     string `json:"name"`
	Engine   string `json:"engine"`
	Version  string `json:"version"`
	DBName   string `json:"dbName"`
	DBUser   string `json:"dbUser"`
	Password string `json:"password"`
}

type provisionDBResult struct {
	Success      bool   `json:"success"`
	ContainerName string `json:"containerName"`
	Port         int    `json:"port"`
	DBName       string `json:"dbName"`
	DBUser       string `json:"dbUser"`
	Error        string `json:"error,omitempty"`
}

func (a *Agent) handleProvisionDB(msg Message) {
	var p provisionDBPayload
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		a.sendError(msg.CommandID, "invalid provision-db payload: "+err.Error())
		return
	}

	go func() {
		log := func(s string) { a.sendChunk(msg.CommandID, s) }
		result := provisionDB(&p, log)
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

func provisionDB(p *provisionDBPayload, log func(string)) provisionDBResult {
	slug := strings.ToLower(strings.ReplaceAll(p.Name, " ", "-"))
	containerName := "hylius-db-" + slug
	dbName := p.DBName
	if dbName == "" {
		dbName = strings.ReplaceAll(slug, "-", "_") + "_db"
	}
	dbUser := p.DBUser
	if dbUser == "" {
		dbUser = strings.ReplaceAll(slug, "-", "_") + "_user"
	}

	version := p.Version
	portRanges := map[string][3]int{
		"POSTGRES": {5432, 5532, 5432},
		"MYSQL":    {3306, 3406, 3306},
		"REDIS":    {6379, 6479, 6379},
	}
	portRange, ok := portRanges[p.Engine]
	if !ok {
		return provisionDBResult{Error: "unsupported engine: " + p.Engine}
	}
	if version == "" {
		versions := map[string]string{"POSTGRES": "16", "MYSQL": "8", "REDIS": "7"}
		version = versions[p.Engine]
	}

	hostPort := findFreePortInRange(portRange[0], portRange[1])
	containerPort := portRange[2]

	var image, runCmd string
	pass := strings.ReplaceAll(p.Password, "'", "'\\''")

	switch p.Engine {
	case "POSTGRES":
		image = fmt.Sprintf("postgres:%s-alpine", version)
		runCmd = fmt.Sprintf(
			"docker run -d --name %s --network hylius --restart unless-stopped -e POSTGRES_DB=%s -e POSTGRES_USER=%s -e POSTGRES_PASSWORD='%s' -p 127.0.0.1:%d:%d -v %s-data:/var/lib/postgresql/data %s",
			containerName, dbName, dbUser, pass, hostPort, containerPort, containerName, image,
		)
	case "MYSQL":
		image = fmt.Sprintf("mysql:%s", version)
		runCmd = fmt.Sprintf(
			"docker run -d --name %s --network hylius --restart unless-stopped -e MYSQL_DATABASE=%s -e MYSQL_USER=%s -e MYSQL_PASSWORD='%s' -e MYSQL_ROOT_PASSWORD='%s' -p 127.0.0.1:%d:%d -v %s-data:/var/lib/mysql %s",
			containerName, dbName, dbUser, pass, pass, hostPort, containerPort, containerName, image,
		)
	case "REDIS":
		image = fmt.Sprintf("redis:%s-alpine", version)
		runCmd = fmt.Sprintf(
			"docker run -d --name %s --network hylius --restart unless-stopped -p 127.0.0.1:%d:%d -v %s-data:/data %s redis-server --requirepass '%s' --appendonly yes",
			containerName, hostPort, containerPort, containerName, image, pass,
		)
	}

	runLocal("docker network create hylius 2>/dev/null || true", nil)
	runLocal(fmt.Sprintf("docker rm -f %s > /dev/null 2>&1 || true", containerName), nil)

	log(fmt.Sprintf("Pulling %s...\n", image))
	if code := runStream("docker pull "+image, log); code != 0 {
		return provisionDBResult{Error: "failed to pull " + image}
	}

	log(fmt.Sprintf("Starting %s container: %s\n", p.Engine, containerName))
	if code := runStream(runCmd, log); code != 0 {
		return provisionDBResult{Error: "docker run failed"}
	}

	log(fmt.Sprintf("\x1b[32m✅ %s started on port %d\x1b[0m\n", p.Engine, hostPort))
	return provisionDBResult{
		Success:      true,
		ContainerName: containerName,
		Port:         hostPort,
		DBName:       dbName,
		DBUser:       dbUser,
	}
}

type destroyDBPayload struct {
	ContainerName string `json:"containerName"`
	RemoveVolume  bool   `json:"removeVolume"`
}

func (a *Agent) handleDestroyDB(msg Message) {
	var p destroyDBPayload
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		a.sendError(msg.CommandID, err.Error())
		return
	}
	log := func(s string) { a.sendChunk(msg.CommandID, s) }
	runLocal(fmt.Sprintf("docker rm -f %s > /dev/null 2>&1 || true", p.ContainerName), nil)
	log(fmt.Sprintf("Container %s removed.\n", p.ContainerName))
	if p.RemoveVolume {
		runLocal(fmt.Sprintf("docker volume rm %s-data > /dev/null 2>&1 || true", p.ContainerName), nil)
		log("\x1b[33mVolume removed. Data permanently deleted.\x1b[0m\n")
	}
	a.sendDone(msg.CommandID, 0)
}

func findFreePortInRange(start, end int) int {
	for p := start; p <= end; p++ {
		cmd := fmt.Sprintf("docker ps --format '{{.Ports}}' | grep -q ':%d->' || echo FREE", p)
		out, err := execShellOutput(cmd)
		if err == nil && strings.TrimSpace(out) == "FREE" {
			return p
		}
	}
	return start
}

func execShellOutput(cmd string) (string, error) {
	out, err := exec.Command("bash", "-l", "-c", cmd).Output()
	return string(out), err
}

// ─── Caddy domain handler ─────────────────────────────────────────────────────

type caddyDomain struct {
	Hostname     string `json:"hostname"`
	UpstreamPort string `json:"upstreamPort"`
}

type configureCaddyPayload struct {
	Domains []caddyDomain `json:"domains"`
	TLSMode string         `json:"tlsMode"`
}

func (a *Agent) handleConfigureCaddy(msg Message) {
	var p configureCaddyPayload
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		a.sendError(msg.CommandID, err.Error())
		return
	}
	log := func(s string) { a.sendChunk(msg.CommandID, s) }
	if err := configureCaddy(p.Domains, p.TLSMode, log); err != nil {
		a.sendError(msg.CommandID, err.Error())
		return
	}
	a.sendDone(msg.CommandID, 0)
}

func configureCaddy(domains []caddyDomain, tlsMode string, log func(string)) error {
	const caddyfile = "/opt/hylius/caddy/Caddyfile"

	// Check if Umami is running
	umamiRunning := false
	out, err := execShellOutput("docker ps --filter name=hylius-umami-app --format '{{.Names}}' | grep -q hylius-umami-app && echo yes || echo no")
	if err == nil && strings.TrimSpace(out) == "yes" {
		umamiRunning = true
	}

	var blocks []string
	for _, d := range domains {
		tls := ""
		if tlsMode == "internal" {
			tls = "\n    tls internal"
		}

		umamiBlock := ""
		if umamiRunning {
			umamiBlock = "\n    handle_path /_umami/* {\n        reverse_proxy localhost:3100\n    }"
		}

		blocks = append(blocks, fmt.Sprintf("%s {%s%s\n    reverse_proxy localhost:%s\n}", d.Hostname, tls, umamiBlock, d.UpstreamPort))
	}

	content := fmt.Sprintf("# Hylius Managed Caddyfile — DO NOT EDIT MANUALLY\n# Last updated: %s\n\n%s\n",
		time.Now().Format(time.RFC3339),
		strings.Join(blocks, "\n\n"),
	)

	if err := os.WriteFile(caddyfile, []byte(content), 0644); err != nil {
		return fmt.Errorf("write caddyfile: %w", err)
	}
	log(fmt.Sprintf("Caddyfile updated with %d domain(s).\n", len(domains)))

	// Ensure Caddy is running
	runLocal("docker inspect -f '{{.State.Running}}' hylius-caddy 2>/dev/null | grep -q true || docker run -d --name hylius-caddy --restart unless-stopped --network host -v /opt/hylius/caddy/Caddyfile:/etc/caddy/Caddyfile -v /opt/hylius/caddy/data:/data -v /opt/hylius/caddy/config:/config caddy:2-alpine", nil)

	// Reload
	code := runLocal("docker exec hylius-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile", nil)
	if code != 0 {
		return fmt.Errorf("caddy reload failed")
	}
	log("Caddy reloaded successfully.\n")
	return nil
}
