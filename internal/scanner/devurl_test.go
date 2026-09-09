package scanner

import (
	"net"
	"testing"
)

func TestIsLocalHost(t *testing.T) {
	local := []string{"localhost", "127.0.0.1", "0.0.0.0", "::1",
		"foo.local", "bar.localhost", "svc.test", "db.internal",
		"app.local.cloover.co", "local.cloover.co"}
	for _, h := range local {
		if !isLocalHost(h) {
			t.Errorf("isLocalHost(%q) = false, want true", h)
		}
	}
	remote := []string{"cloover.co", "app.cloover.co", "example.com", "api.github.com"}
	for _, h := range remote {
		if isLocalHost(h) {
			t.Errorf("isLocalHost(%q) = true, want false", h)
		}
	}
}

// collectDevURLs is the heart of detection: reduce to origins (drop
// path/query), require a port, normalize bind-all hosts, accept custom local
// domains, and keep only origins that are announced or referenced repeatedly.
func TestCollectDevURLs(t *testing.T) {
	assertEq := func(t *testing.T, got, want []string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("got %v, want %v", got, want)
			}
		}
	}

	t.Run("announced strips path and normalizes", func(t *testing.T) {
		in := "  Local:   http://localhost:5173/\nlistening on http://0.0.0.0:4443\n" +
			"server running at http://127.0.0.1:8080\nLocal: https://app.local.cloover.co:3020/\n"
		// All announced (count 1 each) → order is stable-by-count (all equal → first-seen).
		assertEq(t, collectDevURLs([]byte(in)), []string{
			"http://localhost:5173", "http://localhost:4443",
			"http://localhost:8080", "https://app.local.cloover.co:3020",
		})
	})

	t.Run("one-off mention dropped, repeated kept", func(t *testing.T) {
		in := "curl http://localhost:9999/health\n" + // 1x, not announced → dropped
			"GET http://localhost:3000/a GET http://localhost:3000/b GET http://localhost:3000/c\n" // 3x → kept
		assertEq(t, collectDevURLs([]byte(in)), []string{"http://localhost:3000"})
	})

	t.Run("most referenced first", func(t *testing.T) {
		in := "Local: http://localhost:5173/\n" + // announced, 1x
			"hit http://localhost:3000 http://localhost:3000 http://localhost:3000 http://localhost:3000\n" // 4x
		assertEq(t, collectDevURLs([]byte(in)), []string{"http://localhost:3000", "http://localhost:5173"})
	})

	t.Run("bare host and production url ignored", func(t *testing.T) {
		in := "open http://localhost now, docs https://cloover.co/guide\n"
		if got := collectDevURLs([]byte(in)); len(got) != 0 {
			t.Fatalf("got %v, want empty", got)
		}
	})
}

func TestHostPortOf(t *testing.T) {
	cases := map[string]string{
		"http://localhost:5173":         "localhost:5173",
		"http://localhost:5173/":        "localhost:5173",
		"https://app.local.co:3020/x/y": "app.local.co:3020",
		"not-a-url":                     "",
	}
	for in, want := range cases {
		if got := hostPortOf(in); got != want {
			t.Errorf("hostPortOf(%q) = %q, want %q", in, got, want)
		}
	}
}

// Liveness is what makes a chip disappear when its server is closed: the
// probe marks the URL dead, detectDevURLs stops returning it, and — because
// the URL stays cached — it comes back if the port answers again.
func TestDevURLLiveness(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	liveURL := "http://" + ln.Addr().String()

	// Grab a port that's guaranteed free by binding and releasing it.
	ln2, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deadURL := "http://" + ln2.Addr().String()
	ln2.Close()

	s := New(t.TempDir(), t.TempDir())
	s.devURLs = map[string][]string{"sess": {liveURL, deadURL}}

	// Before any probe, both show (never-probed URLs default to visible).
	// The cwd doesn't resolve to a session log, so detectDevURLs only
	// filters the seeded cache.
	if got := s.detectDevURLs("/nonexistent", "sess"); len(got) != 2 {
		t.Fatalf("before probe: got %v, want both URLs", got)
	}

	s.refreshDevURLLiveness()
	got := s.detectDevURLs("/nonexistent", "sess")
	if len(got) != 1 || got[0] != liveURL {
		t.Fatalf("after probe: got %v, want [%s]", got, liveURL)
	}

	// Server closed → chip gone on the next probe.
	ln.Close()
	s.refreshDevURLLiveness()
	if got := s.detectDevURLs("/nonexistent", "sess"); len(got) != 0 {
		t.Fatalf("after close: got %v, want empty", got)
	}

	// Same port answers again → chip returns (cache was kept, not dropped).
	ln3, err := net.Listen("tcp", ln.Addr().String())
	if err != nil {
		t.Skipf("port %s got reused by another process", ln.Addr())
	}
	defer ln3.Close()
	s.refreshDevURLLiveness()
	got = s.detectDevURLs("/nonexistent", "sess")
	if len(got) != 1 || got[0] != liveURL {
		t.Fatalf("after restart: got %v, want [%s]", got, liveURL)
	}
}

func TestPruneDevURLCache(t *testing.T) {
	s := New(t.TempDir(), t.TempDir())
	s.devURLs = map[string][]string{
		"kept": {"http://localhost:3000"},
		"gone": {"http://localhost:4000"},
	}
	s.devURLScanned = map[string]bool{"kept": true, "gone": true}

	s.pruneDevURLCache(map[string]bool{"kept": true})

	if _, ok := s.devURLs["gone"]; ok {
		t.Error("devURLs entry for vanished session not pruned")
	}
	if _, ok := s.devURLScanned["gone"]; ok {
		t.Error("devURLScanned entry for vanished session not pruned")
	}
	if _, ok := s.devURLs["kept"]; !ok {
		t.Error("devURLs entry for live session was pruned")
	}
}
