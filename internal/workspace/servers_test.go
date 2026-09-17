package workspace

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestParseListeners(t *testing.T) {
	ls := parseListeners("p123\ncnode\nf12\nn*:3000\nf13\nn[::]:3000\np456\ncnext server\nn127.0.0.1:3090\nn[::1]:6096\nn192.168.1.1:22\nn*:bad\nn*:99999")
	if len(ls) != 3 || ls[0].port != 3000 || ls[0].host != "127.0.0.1" || ls[1].process != "next server" || ls[2].host != "::1" {
		t.Fatalf("unexpected listeners: %+v", ls)
	}
	dirs := parseProcessDirs("p123\nfcwd\nn/tmp/my project/app\np456\nfcwd\nn/tmp/second")
	if dirs[123] != "/tmp/my project/app" || dirs[456] != "/tmp/second" {
		t.Fatal(dirs)
	}
}
func TestServerOwnership(t *testing.T) {
	ts := []Terminal{{ID: "main", Path: "/repo"}, {ID: "one", Path: "/repo/.worktrees/one"}, {ID: "shared", Path: "/repo/.worktrees/one"}, {ID: "two", Path: "/repo/.worktrees/two"}}
	roots := []string{"/repo", "/repo/.worktrees/one", "/repo/.worktrees/two", "/repo/.worktrees/empty"}
	panes := map[string]int{sessionName("one"): 10, sessionName("two"): 20}
	parents := map[int]int{10: 1, 20: 1, 30: 10, 40: 1}
	// Exact ancestry is stronger than cwd, and does not leak to another agent.
	owners := serverOwners(30, "/repo", ts, roots, panes, parents)
	if len(owners) != 1 || owners["one"] != "terminal" {
		t.Fatal(owners)
	}
	// Detached processes survive their shell and are shared only in that checkout.
	owners = serverOwners(40, "/repo/.worktrees/one/app", ts, roots, panes, parents)
	if len(owners) != 2 || owners["one"] != "checkout" || owners["shared"] != "checkout" {
		t.Fatal(owners)
	}
	for _, cwd := range []string{"/repo/.worktrees/empty/app", "/repository/app", "/unrelated", ""} {
		if owners = serverOwners(40, cwd, ts, roots, panes, parents); len(owners) != 0 {
			t.Fatalf("%s: %v", cwd, owners)
		}
	}
}
func testListener(t *testing.T, address string) listener {
	t.Helper()
	host, p, e := net.SplitHostPort(address)
	if e != nil {
		t.Fatal(e)
	}
	port, _ := strconv.Atoi(p)
	return listener{1, port, "fixture", host}
}
func TestProbeHostedApp(t *testing.T) {
	for _, secure := range []bool{false, true} {
		t.Run(strconv.FormatBool(secure), func(t *testing.T) {
			calls := 0
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != "HEAD" {
					t.Error("probe must not request bodies")
				}
				// Redirects identify an app but must not trigger a second request.
				w.Header().Set("Location", "http://example.com")
				w.WriteHeader(307)
			})
			var s *httptest.Server
			if secure {
				s = httptest.NewTLSServer(handler)
			} else {
				s = httptest.NewServer(handler)
			}
			defer s.Close()
			l := testListener(t, s.Listener.Addr().String())
			scheme := "http"
			if secure {
				scheme = "https"
			}
			got := probeApp(context.Background(), l)
			if got != scheme+"://localhost:"+strconv.Itoa(l.port) || calls != 1 {
				t.Fatalf("%q (%d calls)", got, calls)
			}
			s.Close()
			if got = probeApp(context.Background(), l); got != "" {
				t.Fatal("stopped app still returned", got)
			}
		})
	}
}
func TestProbeIgnoresNonHTTPListener(t *testing.T) {
	s, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	go func() {
		for {
			c, e := s.Accept()
			if e != nil {
				return
			}
			c.Write([]byte("database protocol\n"))
			c.Close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if got := probeApp(ctx, testListener(t, s.Addr().String())); got != "" {
		t.Fatal(got)
	}
}
