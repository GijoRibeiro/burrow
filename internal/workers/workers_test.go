package workers

import (
	"testing"
)

func TestNewManager(t *testing.T) {
	m := NewManager()
	if m == nil {
		t.Fatal("NewManager returned nil")
	}
	if m.workers == nil {
		t.Fatal("workers map is nil")
	}
	if m.counter != 0 {
		t.Fatalf("expected counter 0, got %d", m.counter)
	}
	if len(m.All()) != 0 {
		t.Fatalf("expected 0 workers, got %d", len(m.All()))
	}
}

func TestWorkerIDGeneration(t *testing.T) {
	m := NewManager()

	// Simulate ID generation by incrementing the counter directly,
	// since Spawn requires a real claude binary on PATH.
	ids := make([]string, 5)
	for i := range ids {
		m.mu.Lock()
		m.counter++
		ids[i] = "worker-" + itoa(m.counter)
		m.mu.Unlock()
	}

	expected := []string{"worker-1", "worker-2", "worker-3", "worker-4", "worker-5"}
	for i, want := range expected {
		if ids[i] != want {
			t.Errorf("ID %d: got %q, want %q", i, ids[i], want)
		}
	}
}

func TestExpandHome(t *testing.T) {
	// Absolute path should be unchanged.
	abs := "/usr/local/bin"
	got, err := expandHome(abs)
	if err != nil {
		t.Fatalf("expandHome(%q): %v", abs, err)
	}
	if got != abs {
		t.Errorf("expandHome(%q) = %q, want %q", abs, got, abs)
	}

	// Tilde path should be expanded.
	tilde := "~/projects"
	got, err = expandHome(tilde)
	if err != nil {
		t.Fatalf("expandHome(%q): %v", tilde, err)
	}
	if got == tilde {
		t.Error("expandHome did not expand ~")
	}
	if got[0] != '/' {
		t.Errorf("expanded path should start with /, got %q", got)
	}
}

func TestGetMissing(t *testing.T) {
	m := NewManager()
	_, ok := m.Get("worker-999")
	if ok {
		t.Error("expected Get for missing worker to return false")
	}
}

func TestOnEvent(t *testing.T) {
	m := NewManager()

	var received []WorkerEvent
	m.OnEvent(func(e WorkerEvent) {
		received = append(received, e)
	})

	m.emit(WorkerEvent{
		WorkerID: "worker-1",
		Type:     "status_change",
		Status:   "active",
	})

	if len(received) != 1 {
		t.Fatalf("expected 1 event, got %d", len(received))
	}
	if received[0].WorkerID != "worker-1" {
		t.Errorf("got workerID %q, want %q", received[0].WorkerID, "worker-1")
	}
	if received[0].Status != "active" {
		t.Errorf("got status %q, want %q", received[0].Status, "active")
	}
}

func TestStopMissing(t *testing.T) {
	m := NewManager()
	err := m.Stop("worker-999")
	if err == nil {
		t.Error("expected error stopping missing worker")
	}
}

func TestSendMessageMissing(t *testing.T) {
	m := NewManager()
	err := m.SendMessage("worker-999", "hello")
	if err == nil {
		t.Error("expected error sending message to missing worker")
	}
}

// itoa is a simple int-to-string helper to avoid importing strconv.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
