package agent

import (
	"bufio"
	"encoding/json"
	"os/exec"
)

type execPayload struct {
	Cmd string `json:"cmd"`
}

// handleExec runs an arbitrary shell command and streams output back.
func (a *Agent) handleExec(msg Message) {
	var p execPayload
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		a.sendError(msg.CommandID, "invalid exec payload: "+err.Error())
		return
	}

	cmd := exec.Command("bash", "-l", "-c", p.Cmd)
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		a.sendError(msg.CommandID, "exec start failed: "+err.Error())
		return
	}

	// Stream stdout + stderr concurrently
	done := make(chan struct{}, 2)
	streamPipe := func(r interface{ Scan() bool; Text() string }) {
		for r.Scan() {
			a.sendChunk(msg.CommandID, r.Text()+"\n")
		}
		done <- struct{}{}
	}
	go streamPipe(bufio.NewScanner(stdout))
	go streamPipe(bufio.NewScanner(stderr))
	<-done
	<-done

	exitCode := 0
	if err := cmd.Wait(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		}
	}
	a.sendDone(msg.CommandID, exitCode)
}

// handleGetMetrics returns a one-shot metrics snapshot.
func (a *Agent) handleGetMetrics(msg Message) {
	a.sendHeartbeat() // reuse heartbeat logic
	a.sendDone(msg.CommandID, 0)
}
