package server

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

// roundTripFunc lets a test stand in for the GitHub API without a network.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func stubClient(body string, err error) *http.Client {
	return &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		if err != nil {
			return nil, err
		}
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
		}, nil
	})}
}

const sampleRelease = `{
  "tag_name": "v0.1.4",
  "body": "Bug fixes and new avatars.",
  "assets": [
    { "name": "something-else.txt", "browser_download_url": "https://example.com/other.txt" },
    { "name": "bitwise-macos.zip", "browser_download_url": "https://example.com/bitwise-macos.zip" }
  ]
}`

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"0.1.3", "0.1.3", 0},
		{"0.1.4", "0.1.3", 1},
		{"0.1.3", "0.1.4", -1},
		{"0.2.0", "0.1.9", 1},
		{"1.0.0", "0.9.9", 1},
		{"v0.1.4", "0.1.3", 1},  // tolerate a leading v
		{"0.1.4", "v0.1.4", 0},
		{"0.1.10", "0.1.9", 1},  // numeric, not lexical
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestCheckForUpdate_Available(t *testing.T) {
	info, err := checkForUpdate(stubClient(sampleRelease, nil), "0.1.3", "GijoRibeiro/bitwise")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !info.Available {
		t.Errorf("Available = false, want true (0.1.4 > 0.1.3)")
	}
	if info.Latest != "0.1.4" {
		t.Errorf("Latest = %q, want 0.1.4", info.Latest)
	}
	if info.Current != "0.1.3" {
		t.Errorf("Current = %q, want 0.1.3", info.Current)
	}
	if info.DownloadURL != "https://example.com/bitwise-macos.zip" {
		t.Errorf("DownloadURL = %q, want the bitwise-macos.zip asset", info.DownloadURL)
	}
}

func TestCheckForUpdate_UpToDate(t *testing.T) {
	info, err := checkForUpdate(stubClient(sampleRelease, nil), "0.1.4", "GijoRibeiro/bitwise")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.Available {
		t.Errorf("Available = true, want false (0.1.4 == 0.1.4)")
	}
}

func TestCheckForUpdate_DevBuildNeverOffered(t *testing.T) {
	info, err := checkForUpdate(stubClient(sampleRelease, nil), "0.0.0-dev", "GijoRibeiro/bitwise")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.Available {
		t.Errorf("Available = true, want false for a dev build")
	}
}

// displayVersion enriches the diagnostics panel without disturbing the
// updater's dev-detection: a stamped release shows its clean number, an
// un-stamped build shows the git ref + "-dev", and a build with neither falls
// back to the sentinel. currentVersion must stay the bare sentinel for dev
// builds so the updater never nags (covered by DevBuildNeverOffered above).
func TestDisplayVersion(t *testing.T) {
	saveV, saveG := buildVersion, buildGitDescribe
	defer func() { buildVersion, buildGitDescribe = saveV, saveG }()

	buildVersion, buildGitDescribe = "0.4.2", "v0.4.2-0-gabc123"
	if got := displayVersion(); got != "0.4.2" {
		t.Errorf("release build: displayVersion() = %q, want %q", got, "0.4.2")
	}

	buildVersion, buildGitDescribe = "", "v0.4.1-3-gc5455de-dirty"
	if got := displayVersion(); got != "v0.4.1-3-gc5455de-dirty-dev" {
		t.Errorf("dev build: displayVersion() = %q, want git ref + -dev", got)
	}
	if currentVersion() != devVersion {
		t.Errorf("dev build: currentVersion() = %q, want sentinel %q (updater must still see a dev build)", currentVersion(), devVersion)
	}

	buildVersion, buildGitDescribe = "", ""
	if got := displayVersion(); got != devVersion {
		t.Errorf("no info: displayVersion() = %q, want sentinel %q", got, devVersion)
	}
}

func TestCheckForUpdate_NetworkError(t *testing.T) {
	_, err := checkForUpdate(stubClient("", errors.New("no network")), "0.1.3", "GijoRibeiro/bitwise")
	if err == nil {
		t.Errorf("expected an error on network failure, got nil")
	}
}
