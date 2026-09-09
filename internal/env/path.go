// Package env normalises the process environment so subsequent subprocess
// spawns and PATH lookups behave the same whether the daemon was started
// from a terminal or a GUI launcher.
//
// macOS GUI launches (Finder, .app bundle, Dock) start with a minimal PATH
// — typically /usr/bin:/bin:/usr/sbin:/sbin — that omits everywhere users
// actually install dev tools: ~/.local/bin, /opt/homebrew/bin, and version
// managers like nvm. Symptoms include `claude` / `npm` / `node` being
// "not found" inside the daemon even though they work fine in the user's
// shell. The fix is to prepend the canonical locations once at startup.
package env

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// AugmentPATH prepends commonly-used tool directories onto $PATH for the
// current process so child processes inherit them. Idempotent and safe to
// call multiple times (existing entries aren't duplicated meaningfully —
// the lookup still resolves to the first match). Pass the resolved home
// directory.
func AugmentPATH(home string) {
	candidates := []string{
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, "go", "bin"),
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/local/sbin",
	}
	if nvm := nvmDefaultBin(home); nvm != "" {
		candidates = append(candidates, nvm)
	}

	cur := os.Getenv("PATH")
	existing := map[string]bool{}
	for _, p := range strings.Split(cur, ":") {
		existing[p] = true
	}

	// Prepend in reverse so the first listed candidate ends up at the front
	// of PATH after the loop.
	for i := len(candidates) - 1; i >= 0; i-- {
		p := candidates[i]
		if existing[p] {
			continue
		}
		if _, err := os.Stat(p); err != nil {
			continue
		}
		cur = p + ":" + cur
		existing[p] = true
	}
	os.Setenv("PATH", cur)
}

// nvmDefaultBin returns the absolute path to the bin/ directory of the
// nvm-managed Node version that an interactive shell would activate, or
// "" if nvm isn't installed / no version is available. We can't shell out
// to nvm itself (it's a shell function, not a binary), so we replicate the
// resolution by reading ~/.nvm/ directly.
//
// Resolution order:
//   1. ~/.nvm/alias/default points to a literal version → use it.
//   2. ~/.nvm/alias/default points to another alias (e.g. lts/*) → resolve
//      transitively up to a small depth so cycles can't hang us.
//   3. Fall back to the highest installed version under
//      ~/.nvm/versions/node/, so a freshly-installed nvm with no default
//      still works.
func nvmDefaultBin(home string) string {
	versionsDir := filepath.Join(home, ".nvm", "versions", "node")
	installed := listNvmVersions(versionsDir)
	if len(installed) == 0 {
		return ""
	}

	if v := resolveNvmAlias(home, "default", 8); v != "" {
		if hasVersion(installed, v) {
			return filepath.Join(versionsDir, v, "bin")
		}
	}

	// Highest installed wins. Reasonable default for someone using nvm but
	// without a `nvm alias default` set.
	sort.Slice(installed, func(i, j int) bool {
		return compareSemverDesc(installed[i], installed[j])
	})
	return filepath.Join(versionsDir, installed[0], "bin")
}

// resolveNvmAlias follows ~/.nvm/alias/<name> up to depth hops. Returns the
// terminal version string (e.g. "v22.1.0") or "" if it can't resolve.
// `lts/*` is a special token nvm uses for "current LTS" — when we hit it
// we pick the highest version listed across the lts/<codename> files.
func resolveNvmAlias(home, name string, depth int) string {
	if depth <= 0 {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".nvm", "alias", name))
	if err != nil {
		return ""
	}
	ref := strings.TrimSpace(string(data))
	if ref == "" {
		return ""
	}
	// Literal version like "v22.1.0" or "22.1.0" — normalise + return.
	if !strings.Contains(ref, "/") && (ref[0] == 'v' || (ref[0] >= '0' && ref[0] <= '9')) {
		if ref[0] != 'v' {
			ref = "v" + ref
		}
		// Light validation: must look like vMAJOR.MINOR.PATCH-ish.
		if len(parseSemver(ref)) > 0 {
			return ref
		}
	}
	// `lts/*` — pick the highest version across lts/<codename>.
	if ref == "lts/*" {
		ltsDir := filepath.Join(home, ".nvm", "alias", "lts")
		entries, err := os.ReadDir(ltsDir)
		if err != nil {
			return ""
		}
		var best string
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			v := resolveNvmAlias(home, "lts/"+e.Name(), depth-1)
			if v == "" {
				continue
			}
			if best == "" || compareSemverDesc(v, best) {
				best = v
			}
		}
		return best
	}
	// Other alias (e.g. lts/iron, node, stable) — recurse.
	return resolveNvmAlias(home, ref, depth-1)
}

func listNvmVersions(versionsDir string) []string {
	entries, err := os.ReadDir(versionsDir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, "v") {
			continue
		}
		if len(parseSemver(name)) == 0 {
			continue
		}
		out = append(out, name)
	}
	return out
}

func hasVersion(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// parseSemver returns [major, minor, patch] for "vM.m.p" or nil if the
// string doesn't look like a version. Pre-release suffixes are tolerated
// (everything after the patch is ignored).
func parseSemver(v string) []int {
	v = strings.TrimPrefix(v, "v")
	// Strip pre-release / build metadata.
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.SplitN(v, ".", 3)
	if len(parts) == 0 {
		return nil
	}
	out := make([]int, 0, 3)
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}

// compareSemverDesc returns true if a > b (so it sorts descending).
func compareSemverDesc(a, b string) bool {
	pa, pb := parseSemver(a), parseSemver(b)
	for i := 0; i < 3; i++ {
		va, vb := 0, 0
		if i < len(pa) {
			va = pa[i]
		}
		if i < len(pb) {
			vb = pb[i]
		}
		if va != vb {
			return va > vb
		}
	}
	return false
}
