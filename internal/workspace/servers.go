package workspace

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type HostedApp struct {
	Port    int    `json:"port"`
	URL     string `json:"url"`
	Process string `json:"process"`
	Source  string `json:"source"` // terminal ancestry, or a shared checkout
}
type serverDiscovery struct {
	mu      sync.Mutex
	checked time.Time
	apps    map[string][]HostedApp
	err     error
}
type listener struct {
	pid, port     int
	process, host string
}

// This scan is independent of workspace/activity polling. One bounded, cached
// scan serves every visible panel; no transcript parsing or workspace mutation.
func (m *Manager) hostedApps(ctx context.Context) (map[string][]HostedApp, error) {
	d := &m.servers
	d.mu.Lock()
	defer d.mu.Unlock()
	if time.Since(d.checked) < 5*time.Second {
		return d.apps, d.err
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	d.apps, d.err = m.discoverApps(ctx)
	d.checked = time.Now()
	return d.apps, d.err
}
func scanCommand(ctx context.Context, dir, bin string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.WaitDelay = time.Second
	if bin == "git" {
		isolateCloneProcess(cmd)
	}
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	return strings.TrimSpace(string(out)), err
}
func (m *Manager) discoverApps(ctx context.Context) (map[string][]HostedApp, error) {
	apps := map[string][]HostedApp{}
	m.mu.Lock()
	terminals := append([]Terminal(nil), m.state.Terminals...)
	projects := append([]Project(nil), m.state.Projects...)
	m.mu.Unlock()
	if len(terminals) == 0 {
		return apps, nil
	}
	out, err := scanCommand(ctx, "", "lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn")
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1 && out == "" {
			return apps, nil
		}
		return nil, fmt.Errorf("Could not check running apps: %w", err)
	}
	listeners := parseListeners(out)
	if len(listeners) == 0 {
		return apps, nil
	}
	pids := []string{}
	seen := map[int]bool{}
	for _, l := range listeners {
		if !seen[l.pid] {
			pids = append(pids, strconv.Itoa(l.pid))
			seen[l.pid] = true
		}
	}
	out, err = scanCommand(ctx, "", "lsof", "-a", "-p", strings.Join(pids, ","), "-d", "cwd", "-Fn")
	if err != nil && out == "" {
		return nil, fmt.Errorf("Could not identify app folders: %w", err)
	}
	dirs := parseProcessDirs(out)
	parents := map[int]int{}
	out, _ = scanCommand(ctx, "", "ps", "-axo", "pid=,ppid=")
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 {
			pid, _ := strconv.Atoi(f[0])
			parents[pid], _ = strconv.Atoi(f[1])
		}
	}
	panes := map[string]int{}
	out, _ = scanCommand(ctx, "", "tmux", "-L", m.socket, "-f", "/dev/null", "list-panes", "-a", "-F", "#{session_name} #{pane_dead} #{pane_pid}")
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) == 3 && f[1] == "0" {
			panes[f[0]], _ = strconv.Atoi(f[2])
		}
	}
	roots := []string{}
	for _, p := range projects {
		roots = append(roots, p.Path)
		// Include worktrees with no agents, so a parent's panel cannot claim them.
		out, err := scanCommand(ctx, p.Path, "git", "worktree", "list", "--porcelain")
		if err != nil && p.Git {
			return nil, fmt.Errorf("Could not identify checkout servers: %w", err)
		}
		for _, line := range strings.Split(out, "\n") {
			if strings.HasPrefix(line, "worktree ") {
				roots = append(roots, strings.TrimPrefix(line, "worktree "))
			}
		}
	}
	for _, t := range terminals {
		roots = append(roots, t.Path)
	}
	type match struct {
		l      listener
		owners map[string]string
	}
	matches := []match{}
	for _, l := range listeners {
		owners := serverOwners(l.pid, dirs[l.pid], terminals, roots, panes, parents)
		if len(owners) > 0 {
			matches = append(matches, match{l, owners})
		}
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	slots := make(chan struct{}, 8)
	for _, m := range matches {
		wg.Add(1)
		go func(m match) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-slots }()
			address := probeApp(ctx, m.l)
			if address == "" {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for id, source := range m.owners {
				apps[id] = append(apps[id], HostedApp{m.l.port, address, m.l.process, source})
			}
		}(m)
	}
	wg.Wait()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("Checking running apps timed out; retrying shortly")
	}
	for id := range apps {
		sort.Slice(apps[id], func(i, j int) bool { return apps[id][i].Port < apps[id][j].Port })
	}
	return apps, nil
}
func parseListeners(out string) []listener {
	var pid int
	var process string
	result := []listener{}
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(line[1:])
			process = ""
		case 'c':
			process = line[1:]
		case 'n':
			host, portText, err := net.SplitHostPort(line[1:])
			if err != nil {
				continue
			}
			port, _ := strconv.Atoi(portText)
			if host == "*" || host == "0.0.0.0" || host == "::" {
				host = "127.0.0.1"
			}
			ip := net.ParseIP(host)
			if pid <= 0 || port <= 0 || port > 65535 || ip == nil || !ip.IsLoopback() {
				continue
			}
			key := fmt.Sprintf("%d:%d", pid, port)
			if seen[key] {
				continue
			}
			seen[key] = true
			result = append(result, listener{pid, port, process, host})
		}
	}
	return result
}
func parseProcessDirs(out string) map[int]string {
	dirs := map[int]string{}
	pid := 0
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 2 {
			continue
		}
		if line[0] == 'p' {
			pid, _ = strconv.Atoi(line[1:])
		}
		if line[0] == 'n' && pid > 0 {
			dirs[pid] = line[1:]
		}
	}
	return dirs
}
func serverOwners(pid int, cwd string, terminals []Terminal, roots []string, panes map[string]int, parents map[int]int) map[string]string {
	owners := map[string]string{}
	for _, t := range terminals {
		if descendantDepth(pid, panes[sessionName(t.ID)], parents) >= 0 {
			owners[t.ID] = "terminal"
		}
	}
	if len(owners) > 0 {
		return owners
	}
	if cwd == "" {
		return owners
	}
	best := ""
	for _, root := range roots {
		if folderWithin(cwd, root) && len(root) > len(best) {
			best = root
		}
	}
	for _, t := range terminals {
		if best != "" && t.Path == best {
			owners[t.ID] = "checkout"
		}
	}
	return owners
}
func probeApp(ctx context.Context, l listener) string {
	for _, scheme := range []string{"https", "http"} {
		probeCtx, cancel := context.WithTimeout(ctx, 1200*time.Millisecond)
		address := net.JoinHostPort(l.host, strconv.Itoa(l.port))
		transport := &http.Transport{
			Proxy: nil, DisableKeepAlives: true,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "tcp", address)
			},
			// Dev certificates are often self-signed. This identifies a local server;
			// opening the link still uses the browser's normal certificate checks.
			TLSClientConfig:        &tls.Config{InsecureSkipVerify: true},
			MaxResponseHeaderBytes: 64 << 10,
		}
		client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		req, _ := http.NewRequestWithContext(probeCtx, http.MethodHead, scheme+"://"+net.JoinHostPort("localhost", strconv.Itoa(l.port))+"/", nil)
		resp, err := client.Do(req)
		if err == nil {
			resp.Body.Close()
			host := "localhost"
			if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
				for i, name := range resp.TLS.PeerCertificates[0].DNSNames {
					if i >= 8 {
						break
					}
					if name == "localhost" || strings.Contains(name, "*") {
						continue
					}
					ips, e := net.DefaultResolver.LookupIPAddr(probeCtx, name)
					local := e == nil && len(ips) > 0
					for _, ip := range ips {
						if !ip.IP.IsLoopback() {
							local = false
						}
					}
					if local {
						host = name
						break
					}
				}
			}
			transport.CloseIdleConnections()
			cancel()
			return scheme + "://" + net.JoinHostPort(host, strconv.Itoa(l.port))
		}
		transport.CloseIdleConnections()
		cancel()
	}
	return ""
}
