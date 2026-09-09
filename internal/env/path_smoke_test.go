package env

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// TestSmokeAugmentOnMinimalPATH verifies the augmenter recovers a usable
// dev environment from a launchd-minimal PATH. Not a hermetic test — it
// inspects the actual host. Skipped if the host has no nvm/homebrew.
func TestSmokeAugmentOnMinimalPATH(t *testing.T) {
	home, _ := os.UserHomeDir()
	saved := os.Getenv("PATH")
	t.Cleanup(func() { os.Setenv("PATH", saved) })

	os.Setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
	AugmentPATH(home)
	got := os.Getenv("PATH")
	t.Logf("PATH after augment: %s", got)

	if p, err := exec.LookPath("npm"); err == nil {
		t.Logf("npm resolved to: %s", p)
		if !strings.HasPrefix(p, home+"/.nvm") && !strings.HasPrefix(p, "/opt/homebrew") && !strings.HasPrefix(p, "/usr/local") {
			t.Errorf("npm resolved to unexpected location: %s", p)
		}
	} else {
		t.Log("npm not found (host has no Node installed — skipping)")
	}
	if p, err := exec.LookPath("node"); err == nil {
		t.Logf("node resolved to: %s", p)
	}
}
