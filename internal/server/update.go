package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// buildVersion is the release version this binary was built from (e.g.
// "0.1.4"), injected at link time via -ldflags "-X .../server.buildVersion=…".
// Empty in `go run`; treated as the dev sentinel so the updater never nags
// developers.
var buildVersion string

// buildGitDescribe is `git describe --tags --always --dirty` captured at build
// time (e.g. "v0.4.1-3-gc5455de" or "…-dirty"), injected via -ldflags. Always
// set by the Makefile, even for dev builds. Used only by displayVersion for the
// diagnostics panel — NOT by the updater, which still treats an empty
// buildVersion as a dev build (see currentVersion).
var buildGitDescribe string

const devVersion = "0.0.0-dev"

// updateRepo is the GitHub repo the updater checks for releases.
const updateRepo = "GijoRibeiro/bitwise"

// releaseAsset is the macOS download attached to a GitHub release.
const releaseAssetName = "bitwise-macos.zip"

// UpdateInfo is the result of an update check, returned by /api/update/check.
type UpdateInfo struct {
	Current     string `json:"current"`
	Latest      string `json:"latest"`
	Available   bool   `json:"available"`
	DownloadURL string `json:"downloadURL"`
	Notes       string `json:"notes,omitempty"`
	Error       string `json:"error,omitempty"`
}

// currentVersion returns the running version for UPDATER logic, defaulting to
// the dev sentinel when not injected at build time. Keep this keyed on
// buildVersion alone — the updater relies on devVersion to never nag a dev
// build (see checkForUpdate).
func currentVersion() string {
	if buildVersion == "" {
		return devVersion
	}
	return buildVersion
}

// displayVersion is the human-facing version for the diagnostics panel. A
// release build (buildVersion stamped via `make … VERSION=vX`) shows the clean
// number; a dev build shows the git ref it was built from with a "-dev" suffix
// so a local rebuild still tells you which commit it is — falling back to the
// sentinel only when no git info was injected. Deliberately separate from
// currentVersion so enriching the display can't affect updater dev-detection.
func displayVersion() string {
	if buildVersion != "" {
		return buildVersion
	}
	if buildGitDescribe != "" {
		return buildGitDescribe + "-dev"
	}
	return devVersion
}

// compareVersions compares two dotted numeric versions (tolerating a leading
// "v"). Returns -1 if a < b, 0 if equal, 1 if a > b. Non-numeric or missing
// components are treated as 0, so "0.1" == "0.1.0".
func compareVersions(a, b string) int {
	pa := versionParts(a)
	pb := versionParts(b)
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

func versionParts(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	fields := strings.Split(v, ".")
	out := make([]int, 0, len(fields))
	for _, f := range fields {
		n, _ := strconv.Atoi(strings.TrimSpace(f))
		out = append(out, n)
	}
	return out
}

// githubRelease mirrors the slice of the GitHub "latest release" payload we use.
type githubRelease struct {
	TagName string `json:"tag_name"`
	Body    string `json:"body"`
	Assets  []struct {
		Name        string `json:"name"`
		DownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

// checkForUpdate fetches the latest release for `repo` and compares it to
// currentVer. A dev build never reports an available update.
func checkForUpdate(client *http.Client, currentVer, repo string) (UpdateInfo, error) {
	info := UpdateInfo{Current: currentVer}

	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return info, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := client.Do(req)
	if err != nil {
		return info, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return info, fmt.Errorf("github returned %d", resp.StatusCode)
	}

	var rel githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return info, err
	}

	info.Latest = strings.TrimPrefix(rel.TagName, "v")
	info.Notes = rel.Body
	for _, a := range rel.Assets {
		if a.Name == releaseAssetName {
			info.DownloadURL = a.DownloadURL
			break
		}
	}

	// Never offer an update to a dev build, and only when the release is
	// strictly newer.
	info.Available = currentVer != devVersion && compareVersions(info.Latest, currentVer) > 0
	return info, nil
}

// handleUpdateCheck serves GET /api/update/check. Network/parse failures are
// reported in the Error field with Available=false — the check never blocks
// or errors the client.
func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	info, err := checkForUpdate(client, currentVersion(), updateRepo)
	if err != nil {
		info.Error = err.Error()
		info.Available = false
	}
	_ = json.NewEncoder(w).Encode(info)
}
