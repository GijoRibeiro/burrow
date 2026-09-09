package workers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Worker represents a running Claude Code process.
type Worker struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"`
	Task      string    `json:"task"`
	Status    string    `json:"status"` // "starting", "active", "idle", "done", "error"
	StartedAt time.Time `json:"startedAt"`

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
}

// WorkerEvent represents an event emitted by a worker.
type WorkerEvent struct {
	WorkerID string
	Type     string // "status_change", "output", "done", "error"
	Status   string // new status for status_change
	Text     string // output text
	Error    string // error message
}

// streamJSON represents a line of Claude's --output-format stream-json output.
type streamJSON struct {
	Type    string          `json:"type"`
	Content json.RawMessage `json:"content"`
}

// Manager manages multiple Claude Code worker processes.
type Manager struct {
	mu       sync.RWMutex
	workers  map[string]*Worker
	counter  int
	handlers []func(WorkerEvent)
}

// NewManager creates a new worker manager.
func NewManager() *Manager {
	return &Manager{
		workers: make(map[string]*Worker),
	}
}

// Spawn starts a new claude process with the given task in the given directory.
// Returns the generated worker ID.
func (m *Manager) Spawn(path string, task string) (string, error) {
	expanded, err := expandHome(path)
	if err != nil {
		return "", fmt.Errorf("expanding path: %w", err)
	}

	m.mu.Lock()
	m.counter++
	id := fmt.Sprintf("worker-%d", m.counter)
	m.mu.Unlock()

	cmd := exec.Command("claude", "-p", task, "--output-format", "stream-json", "--verbose")
	cmd.Dir = expanded

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return "", fmt.Errorf("creating stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("creating stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("starting claude process: %w", err)
	}

	w := &Worker{
		ID:        id,
		Path:      path,
		Task:      task,
		Status:    "starting",
		StartedAt: time.Now(),
		cmd:       cmd,
		stdin:     stdin,
		stdout:    stdout,
	}

	m.mu.Lock()
	m.workers[id] = w
	m.mu.Unlock()

	m.emit(WorkerEvent{
		WorkerID: id,
		Type:     "status_change",
		Status:   "starting",
	})

	go m.readOutput(w)

	return id, nil
}

// SendMessage writes a message to a running worker's stdin.
func (m *Manager) SendMessage(workerID string, text string) error {
	m.mu.RLock()
	w, ok := m.workers[workerID]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("worker %s not found", workerID)
	}

	if w.stdin == nil {
		return fmt.Errorf("worker %s stdin is closed", workerID)
	}

	msg := text
	if !strings.HasSuffix(msg, "\n") {
		msg += "\n"
	}

	_, err := io.WriteString(w.stdin, msg)
	if err != nil {
		return fmt.Errorf("writing to worker %s: %w", workerID, err)
	}

	return nil
}

// Stop sends SIGINT to the worker, waits 5s, then SIGKILL if still alive.
func (m *Manager) Stop(workerID string) error {
	m.mu.RLock()
	w, ok := m.workers[workerID]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("worker %s not found", workerID)
	}

	return m.stopWorker(w)
}

// StopAll stops all workers.
func (m *Manager) StopAll() {
	m.mu.RLock()
	all := make([]*Worker, 0, len(m.workers))
	for _, w := range m.workers {
		all = append(all, w)
	}
	m.mu.RUnlock()

	for _, w := range all {
		m.stopWorker(w)
	}
}

// Get returns a worker by ID.
func (m *Manager) Get(workerID string) (Worker, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	w, ok := m.workers[workerID]
	if !ok {
		return Worker{}, false
	}

	return Worker{
		ID:        w.ID,
		Path:      w.Path,
		Task:      w.Task,
		Status:    w.Status,
		StartedAt: w.StartedAt,
	}, true
}

// All returns a snapshot of all workers.
func (m *Manager) All() []Worker {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]Worker, 0, len(m.workers))
	for _, w := range m.workers {
		result = append(result, Worker{
			ID:        w.ID,
			Path:      w.Path,
			Task:      w.Task,
			Status:    w.Status,
			StartedAt: w.StartedAt,
		})
	}

	return result
}

// OnEvent registers a callback for worker events.
func (m *Manager) OnEvent(handler func(WorkerEvent)) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.handlers = append(m.handlers, handler)
}

// stopWorker sends SIGINT, waits 5s, then SIGKILL if needed.
func (m *Manager) stopWorker(w *Worker) error {
	if w.cmd == nil || w.cmd.Process == nil {
		m.removeWorker(w.ID)
		return nil
	}

	// Send SIGINT.
	if err := w.cmd.Process.Signal(syscall.SIGINT); err != nil {
		// Process may already be done.
		m.removeWorker(w.ID)
		return nil
	}

	// Wait up to 5 seconds for graceful shutdown.
	done := make(chan error, 1)
	go func() {
		done <- w.cmd.Wait()
	}()

	select {
	case <-done:
		// Exited gracefully.
	case <-time.After(5 * time.Second):
		// Force kill.
		w.cmd.Process.Kill()
		<-done
	}

	m.removeWorker(w.ID)
	return nil
}

// removeWorker removes a worker from the internal map.
func (m *Manager) removeWorker(id string) {
	m.mu.Lock()
	delete(m.workers, id)
	m.mu.Unlock()
}

// setStatus updates a worker's status and emits a status_change event.
func (m *Manager) setStatus(w *Worker, status string) {
	m.mu.Lock()
	w.Status = status
	m.mu.Unlock()

	m.emit(WorkerEvent{
		WorkerID: w.ID,
		Type:     "status_change",
		Status:   status,
	})
}

// emit sends an event to all registered handlers.
func (m *Manager) emit(event WorkerEvent) {
	m.mu.RLock()
	handlers := make([]func(WorkerEvent), len(m.handlers))
	copy(handlers, m.handlers)
	m.mu.RUnlock()

	for _, h := range handlers {
		h(event)
	}
}

// readOutput reads stdout from the worker process line by line and emits events.
func (m *Manager) readOutput(w *Worker) {
	scanner := bufio.NewScanner(w.stdout)
	// Increase buffer size for potentially large JSON lines.
	scanner.Buffer(make([]byte, 0, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var msg streamJSON
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			// Not valid JSON; emit as raw output.
			m.emit(WorkerEvent{
				WorkerID: w.ID,
				Type:     "output",
				Text:     line,
			})
			continue
		}

		switch {
		case msg.Type == "tool_use":
			m.setStatus(w, "active")
		case msg.Type == "text" || msg.Type == "content_block_delta":
			m.setStatus(w, "active")
			m.emit(WorkerEvent{
				WorkerID: w.ID,
				Type:     "output",
				Text:     string(msg.Content),
			})
		case msg.Type == "result":
			m.setStatus(w, "idle")
			m.emit(WorkerEvent{
				WorkerID: w.ID,
				Type:     "output",
				Text:     string(msg.Content),
			})
		}
	}

	// Process exited. Wait for exit code.
	err := w.cmd.Wait()
	if err != nil {
		m.setStatus(w, "error")
		m.emit(WorkerEvent{
			WorkerID: w.ID,
			Type:     "error",
			Error:    err.Error(),
		})
	} else {
		m.setStatus(w, "done")
		m.emit(WorkerEvent{
			WorkerID: w.ID,
			Type:     "done",
		})
	}
}

// expandHome replaces a leading ~ with the user's home directory.
func expandHome(path string) (string, error) {
	if !strings.HasPrefix(path, "~") {
		return path, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	return strings.Replace(path, "~", home, 1), nil
}
