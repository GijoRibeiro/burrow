//go:build !windows

package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestGitTimeoutStopsDescendants(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "git")
	// The child closes its output pipes, so WaitDelay alone cannot stop it.
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n(sleep 0.4; touch survived) >/dev/null 2>&1 &\nwait\n"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := commandContext(ctx, dir, bin); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected timeout: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(dir, "survived")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("timed-out Git child kept running: %v", err)
	}
}
