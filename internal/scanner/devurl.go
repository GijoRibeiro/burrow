package scanner

// Local dev-server URL detection and liveness ("server chips" in the
// client). Detection scans the session log for local origins the agent's
// dev servers announced (or that the agent keeps hitting); liveness
// re-probes the detected set every scan tick so a chip disappears shortly
// after its server is closed — and comes back if the port answers again.

import (
	"net"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// maxDevURLsPerAgent caps how many server chips one agent can accumulate, so a
// log that mentions many local ports can't grow the list without bound.
const maxDevURLsPerAgent = 8

// devURLMentionThreshold is how many times a local origin must appear in a
// scan to count as a real running server (vs a one-off mention) when it wasn't
// explicitly announced. Repeated references mean the agent keeps hitting it.
const devURLMentionThreshold = 3

// maxDevURLScan caps the one-time whole-file scan for a dev-server URL.
// Beyond this we fall back to the tail — a URL that far back is almost
// certainly stale anyway, and the read stays bounded.
const maxDevURLScan = 64 << 20 // 64 MiB

// devURLProbeTimeout bounds each liveness dial. Loopback connects (or is
// refused) instantly; the timeout only matters for custom local domains
// that resolve but don't answer.
const devURLProbeTimeout = 500 * time.Millisecond

// devURLCandidateRe matches an http(s) URL with an explicit port. Requiring a
// port is what separates a dev server from a bare "http://localhost" mention
// or a production link — dev servers always bind a port. The host is validated
// separately (isLocalHost) so custom local domains like
// app.local.cloover.co:3020 are caught, not just loopback. The match is the
// origin only (up to the port); the path/query an agent happened to curl is
// discarded so the link stays the stable server root.
var devURLCandidateRe = regexp.MustCompile(`https?://[a-zA-Z0-9.\-]+:\d+`)

// devURLAnnounceRe finds a candidate URL sitting right after a dev-server
// startup phrase ("Local:", "listening on", "running at", …). These are
// high-confidence — they name the server root, not an endpoint the agent
// fetched. [^\n] keeps the phrase and URL on the same log line.
var devURLAnnounceRe = regexp.MustCompile(`(?i)(?:local|listening(?: on)?|running(?: at| on)?|ready(?: on| in)?|serving|started|preview|available|network)[^\n]{0,60}?(https?://[a-zA-Z0-9.\-]+:\d+)`)

// isLocalHost reports whether a URL host is a local dev address: loopback, or
// a hostname carrying a "local"/"test"/"internal" label (covers *.local,
// *.localhost, *.test and custom split-DNS domains like app.local.cloover.co).
func isLocalHost(h string) bool {
	h = strings.ToLower(h)
	switch h {
	case "localhost", "127.0.0.1", "0.0.0.0", "::1":
		return true
	}
	if strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".localhost") ||
		strings.HasSuffix(h, ".test") || strings.HasSuffix(h, ".internal") {
		return true
	}
	// A "local" label anywhere: app.local.cloover.co, local.cloover.co.
	return strings.Contains(h, ".local.") || strings.HasPrefix(h, "local.")
}

// hostOf extracts the hostname from a scheme://host:port[/…] URL.
func hostOf(u string) string {
	i := strings.Index(u, "://")
	if i < 0 {
		return ""
	}
	rest := u[i+3:]
	if j := strings.IndexAny(rest, ":/"); j >= 0 {
		rest = rest[:j]
	}
	return rest
}

// hostPortOf extracts "host:port" for dialing. Detected URLs always carry an
// explicit port (devURLCandidateRe requires one).
func hostPortOf(u string) string {
	i := strings.Index(u, "://")
	if i < 0 {
		return ""
	}
	rest := u[i+3:]
	if j := strings.IndexByte(rest, '/'); j >= 0 {
		rest = rest[:j]
	}
	return rest
}

// normalizeLocalURL rewrites bind-all / loopback hosts to localhost so the
// link is actually clickable (0.0.0.0 isn't browsable on many systems).
func normalizeLocalURL(u string) string {
	u = strings.Replace(u, "://0.0.0.0:", "://localhost:", 1)
	u = strings.Replace(u, "://127.0.0.1:", "://localhost:", 1)
	return u
}

// collectDevURLs returns the distinct local server origins in data that look
// like real running servers: either announced by a server-start line, or
// referenced at least devURLMentionThreshold times (a server the agent keeps
// hitting). One-off mentions are dropped as noise. Order is most-referenced
// first so the busiest server leads.
func collectDevURLs(data []byte) []string {
	announced := map[string]bool{}
	for _, m := range devURLAnnounceRe.FindAllSubmatch(data, -1) {
		u := normalizeLocalURL(string(m[1]))
		if isLocalHost(hostOf(u)) {
			announced[u] = true
		}
	}

	counts := map[string]int{}
	var order []string // first-seen order, for stable tie-breaking
	for _, m := range devURLCandidateRe.FindAll(data, -1) {
		u := normalizeLocalURL(string(m))
		if !isLocalHost(hostOf(u)) {
			continue
		}
		if counts[u] == 0 {
			order = append(order, u)
		}
		counts[u]++
	}

	var out []string
	for _, u := range order {
		if announced[u] || counts[u] >= devURLMentionThreshold {
			out = append(out, u)
		}
	}
	// Most-referenced first; stable within equal counts (order is first-seen).
	sort.SliceStable(out, func(i, j int) bool { return counts[out[i]] > counts[out[j]] })
	return out
}

// detectDevURLs scans the session log for local server URLs the agent started
// and returns the ones still answering. Servers print their URL once, so once
// the line scrolls out of the tail window we keep the accumulated set cached;
// a URL leaves the returned list only while its liveness probe fails (see
// refreshDevURLLiveness). New origins are appended (order preserved so chips
// don't jump around) up to maxDevURLsPerAgent. Manual pins are client-side.
func (s *Scanner) detectDevURLs(cwd, sessionID string) []string {
	logPath := s.findSessionLog(cwd, sessionID)
	if logPath != "" {
		s.devURLMu.Lock()
		firstScan := !s.devURLScanned[sessionID]
		s.devURLMu.Unlock()

		// First sight of a session: read the whole log (bounded) so URLs
		// printed before the daemon started — now scrolled past the tail —
		// are still recovered. Every later tick only reads the tail.
		var data []byte
		var err error
		if firstScan {
			if fi, statErr := os.Stat(logPath); statErr == nil && fi.Size() <= maxDevURLScan {
				data, err = os.ReadFile(logPath)
			} else {
				data, err = readFileTail(logPath, 64*1024)
			}
		} else {
			data, err = readFileTail(logPath, 64*1024)
		}

		s.devURLMu.Lock()
		if err == nil {
			if s.devURLs == nil {
				s.devURLs = map[string][]string{}
			}
			existing := s.devURLs[sessionID]
			seen := make(map[string]bool, len(existing))
			for _, u := range existing {
				seen[u] = true
			}
			for _, u := range collectDevURLs(data) {
				if seen[u] || len(existing) >= maxDevURLsPerAgent {
					continue
				}
				existing = append(existing, u)
				seen[u] = true
			}
			s.devURLs[sessionID] = existing
		}
		if s.devURLScanned == nil {
			s.devURLScanned = map[string]bool{}
		}
		s.devURLScanned[sessionID] = true
		s.devURLMu.Unlock()
	}

	s.devURLMu.Lock()
	defer s.devURLMu.Unlock()
	cached := s.devURLs[sessionID]
	live := make([]string, 0, len(cached))
	for _, u := range cached {
		// Never-probed URLs show immediately; the next tick's probe
		// corrects them if the port is already gone.
		if alive, probed := s.devURLAlive[u]; probed && !alive {
			continue
		}
		live = append(live, u)
	}
	if len(live) == 0 {
		return nil
	}
	return live
}

// devURLReachable reports whether anything is listening at the URL's
// host:port. A TCP connect is enough — we only need "server still up",
// not a valid HTTP response.
func devURLReachable(u string) bool {
	hp := hostPortOf(u)
	if hp == "" {
		return false
	}
	conn, err := net.DialTimeout("tcp", hp, devURLProbeTimeout)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// refreshDevURLLiveness re-probes every cached dev URL and stores the results
// for detectDevURLs to filter by on the next tick. Dead URLs stay in the
// devURLs cache on purpose: the startup line that announced them has long
// scrolled out of the tail window, so dropping them would lose the chip for
// good — keeping them means a server restarted on the same port reappears as
// soon as the port answers. Dials run concurrently, so a tick pays at most
// one probe timeout, and loopback dials settle instantly.
func (s *Scanner) refreshDevURLLiveness() {
	s.devURLMu.Lock()
	urls := map[string]bool{}
	for _, list := range s.devURLs {
		for _, u := range list {
			urls[u] = true
		}
	}
	s.devURLMu.Unlock()

	alive := make(map[string]bool, len(urls))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for u := range urls {
		wg.Add(1)
		go func(u string) {
			defer wg.Done()
			ok := devURLReachable(u)
			mu.Lock()
			alive[u] = ok
			mu.Unlock()
		}(u)
	}
	wg.Wait()

	s.devURLMu.Lock()
	s.devURLAlive = alive
	s.devURLMu.Unlock()
}

// pruneDevURLCache drops per-session dev-URL state for sessions whose files
// are gone, so the caches stay bounded to what the sessions dir holds instead
// of growing until the daemon restarts.
func (s *Scanner) pruneDevURLCache(liveSessions map[string]bool) {
	s.devURLMu.Lock()
	defer s.devURLMu.Unlock()
	for sid := range s.devURLs {
		if !liveSessions[sid] {
			delete(s.devURLs, sid)
		}
	}
	for sid := range s.devURLScanned {
		if !liveSessions[sid] {
			delete(s.devURLScanned, sid)
		}
	}
}
