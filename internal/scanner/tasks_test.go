package scanner

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// writeTask drops a single TodoWrite-style task file into the session's
// task dir. Mirrors the on-disk shape Claude Code writes.
func writeTask(t *testing.T, tasksDir, sessionID string, num int, status, subject string) {
	t.Helper()
	dir := filepath.Join(tasksDir, sessionID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("setup: %v", err)
	}
	body := fmt.Sprintf(`{"id":"%d","subject":%q,"status":%q,"activeForm":%q}`,
		num, subject, status, subject)
	if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("%d.json", num)), []byte(body), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
}

func taskByID(tasks []Task, id string) *Task {
	for i := range tasks {
		if tasks[i].ID == id {
			return &tasks[i]
		}
	}
	return nil
}

// The motivating case: an agent left two old todos pending, then created
// and completed many higher-numbered todos. The stragglers must be
// flagged abandoned; the completed ones must not.
func TestFindCurrentTask_AbandonedStragglers(t *testing.T) {
	home := t.TempDir()
	tasksDir := filepath.Join(home, "tasks")
	sid := "sess-abandon"

	writeTask(t, tasksDir, sid, 18, "completed", "Responsive tray")
	writeTask(t, tasksDir, sid, 19, "pending", "Mobile DnD note")   // straggler
	writeTask(t, tasksDir, sid, 21, "pending", "Mobile layout")     // straggler
	writeTask(t, tasksDir, sid, 22, "completed", "Demo polish")
	writeTask(t, tasksDir, sid, 31, "completed", "Submit polish")

	s := New(filepath.Join(home, "sessions"), tasksDir)
	current, status, tasks := s.findCurrentTask(sid)

	if current != "" || status != "" {
		t.Errorf("no live in_progress task, expected empty current/status, got %q/%q", current, status)
	}
	if a := taskByID(tasks, "19"); a == nil || !a.Abandoned {
		t.Errorf("task 19 should be abandoned (completed 22/31 came later), got %+v", a)
	}
	if a := taskByID(tasks, "21"); a == nil || !a.Abandoned {
		t.Errorf("task 21 should be abandoned, got %+v", a)
	}
	if a := taskByID(tasks, "18"); a == nil || a.Abandoned {
		t.Errorf("completed task 18 must never be abandoned, got %+v", a)
	}
	if a := taskByID(tasks, "31"); a == nil || a.Abandoned {
		t.Errorf("completed task 31 must never be abandoned, got %+v", a)
	}
}

// A genuinely-pending task that is the HIGHEST id (nothing completed
// after it) is live work, not abandoned — must not be flagged.
func TestFindCurrentTask_TrailingPendingNotAbandoned(t *testing.T) {
	home := t.TempDir()
	tasksDir := filepath.Join(home, "tasks")
	sid := "sess-trailing"

	writeTask(t, tasksDir, sid, 1, "completed", "Step one")
	writeTask(t, tasksDir, sid, 2, "completed", "Step two")
	writeTask(t, tasksDir, sid, 3, "pending", "Step three (next up)")

	s := New(filepath.Join(home, "sessions"), tasksDir)
	_, _, tasks := s.findCurrentTask(sid)

	if a := taskByID(tasks, "3"); a == nil || a.Abandoned {
		t.Errorf("trailing pending task 3 must NOT be abandoned (nothing completed after it), got %+v", a)
	}
}

// An in_progress task that's been skipped (a higher id completed) must
// be abandoned AND must not become the agent's reported current task.
func TestFindCurrentTask_AbandonedInProgressNotCurrent(t *testing.T) {
	home := t.TempDir()
	tasksDir := filepath.Join(home, "tasks")
	sid := "sess-skipped"

	writeTask(t, tasksDir, sid, 1, "in_progress", "Stuck old task")
	writeTask(t, tasksDir, sid, 2, "completed", "Newer finished task")

	s := New(filepath.Join(home, "sessions"), tasksDir)
	current, status, tasks := s.findCurrentTask(sid)

	if a := taskByID(tasks, "1"); a == nil || !a.Abandoned {
		t.Errorf("in_progress task 1 should be abandoned (task 2 completed after), got %+v", a)
	}
	if current != "" || status != "" {
		t.Errorf("abandoned in_progress must not be reported as current, got %q/%q", current, status)
	}
}
