// Package agentcli exposes durable coordination to any agent that can run a shell command.
package agentcli

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/gijo/cloovies/internal/workspace"
)

const Help = `burrow — workspace agent coordination (JSON output)
  agents                                 List agents and IDs
  tasks                                  List your assigned/delegated tasks
  task [task-id]                         Read task context
  inbox                                  Read pending messages; does not acknowledge them
  wait [seconds]                         Wait up to 60 seconds for pending messages
  ack <message-id>                        Acknowledge a handled message
  send <agent-id|parent> <message>         Send a durable message
  status <working|waiting|done|canceled> [summary]
  delegate <branch> <claude|codex> <title> <instructions>
Messages/instructions may be '-' to read stdin. Quote multiword arguments.
Use inbox between work steps. Delivery is pull-based; no text is injected into terminals.
`

func Run(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("burrow", flag.ContinueOnError)
	fs.SetOutput(out)
	runtimeFile := fs.String("runtime", "", "Workspace runtime file")
	agentID := fs.String("agent", os.Getenv("BURROW_AGENT_ID"), "Agent ID (normally discovered automatically)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	args = fs.Args()
	if len(args) == 0 || args[0] == "help" {
		fmt.Fprint(out, Help)
		return nil
	}
	if *runtimeFile == "" {
		return errors.New("use the workspace's bin/burrow command")
	}
	data, err := os.ReadFile(*runtimeFile)
	if err != nil {
		return err
	}
	var runtime workspace.AgentRuntime
	if err = json.Unmarshal(data, &runtime); err != nil {
		return err
	}
	u, err := url.Parse(runtime.URL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		return errors.New("invalid local workspace address")
	}
	if *agentID == "" && os.Getenv("TMUX_PANE") != "" {
		raw, e := exec.Command("tmux", "display-message", "-p", "-t", os.Getenv("TMUX_PANE"), "#{session_name}").Output()
		if e == nil {
			*agentID = strings.TrimPrefix(strings.TrimSpace(string(raw)), "cw-")
		}
	}
	data, err = os.ReadFile(runtime.StateFile)
	if err != nil {
		return err
	}
	var state struct {
		AgentTokens map[string]string `json:"agentTokens"`
	}
	if err = json.Unmarshal(data, &state); err != nil {
		return err
	}
	token := state.AgentTokens[*agentID]
	if token == "" {
		return errors.New("run inside a managed agent terminal or supply --agent <id>")
	}
	action := workspace.AgentAction{Action: args[0]}
	wait := time.Duration(0)
	need := func(n int) error {
		if len(args) != n {
			return errors.New("invalid arguments; run burrow help")
		}
		return nil
	}
	readText := func(s string) (string, error) {
		if s != "-" {
			return s, nil
		}
		data, e := io.ReadAll(io.LimitReader(os.Stdin, 12001))
		return string(data), e
	}
	switch args[0] {
	case "agents", "tasks", "inbox":
		if err := need(1); err != nil {
			return err
		}
	case "task":
		if len(args) > 2 {
			return errors.New("usage: task [id]")
		}
		if len(args) == 2 {
			action.TaskID = args[1]
		}
	case "wait":
		seconds := 60
		if len(args) > 2 {
			return errors.New("usage: wait [seconds]")
		}
		if len(args) == 2 {
			var e error
			seconds, e = strconv.Atoi(args[1])
			if e != nil {
				return e
			}
		}
		if seconds < 1 || seconds > 60 {
			return errors.New("wait must be between 1 and 60 seconds")
		}
		wait = time.Duration(seconds) * time.Second
		action.Action = "inbox"
	case "ack":
		if err := need(2); err != nil {
			return err
		}
		action.MessageID = args[1]
	case "send":
		if err := need(3); err != nil {
			return err
		}
		action.To = args[1]
		action.Text, err = readText(args[2])
	case "status":
		if len(args) < 2 || len(args) > 3 {
			return errors.New("usage: status <state> [summary]")
		}
		action.Status = args[1]
		if len(args) == 3 {
			action.Text, err = readText(args[2])
		}
	case "delegate":
		if err := need(5); err != nil {
			return err
		}
		text, e := readText(args[4])
		err = e
		action.Delegate = &workspace.DelegateRequest{Name: args[1], Program: args[2], Title: args[3], Instructions: text}
	default:
		return errors.New("unknown command; run burrow help")
	}
	if err != nil {
		return err
	}
	payload, err := json.Marshal(action)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 90 * time.Second}
	deadline := time.Now().Add(wait)
	for {
		req, e := http.NewRequest("POST", runtime.URL+"/api/workspace/agent", bytes.NewReader(payload))
		if e != nil {
			return e
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Burrow-Agent", *agentID)
		req.Header.Set("Authorization", "Bearer "+token)
		response, e := client.Do(req)
		if e != nil {
			return fmt.Errorf("workspace unavailable; reopen the app and retry: %w", e)
		}
		data, e = io.ReadAll(io.LimitReader(response.Body, 8<<20))
		response.Body.Close()
		if e != nil {
			return e
		}
		if response.StatusCode != 200 {
			return fmt.Errorf("workspace: %s", strings.TrimSpace(string(data)))
		}
		if wait == 0 || string(bytes.TrimSpace(data)) != "[]" || time.Now().After(deadline) {
			_, e = out.Write(data)
			return e
		}
		time.Sleep(time.Second)
	}
}
