package workspace

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCommandTimeoutIdentifiesOperationAndFolder(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := commandContext(ctx, dir, "/bin/sh", "-c", "exec sleep 5")
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), dir) || !strings.Contains(err.Error(), "exec sleep 5") {
		t.Fatalf("missing timeout context: %v", err)
	}
}
