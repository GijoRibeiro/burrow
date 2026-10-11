package workspace

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

// Close codes the browser can distinguish: a WebSocket client never sees the
// HTTP status of a failed upgrade, only the close frame.
const closeTerminalStopped = 4410

// Idle terminals send nothing, so both sides ping. The server drops clients
// that stop answering; the browser reconnects when pings stop arriving.
var (
	pingInterval = 20 * time.Second
	pongWait     = 60 * time.Second
)

func dimension(value string, fallback int) uint16 {
	v, err := strconv.Atoi(value)
	if err != nil || v < 2 || v > 1000 {
		v = fallback
	}
	return uint16(v)
}

// Each browser connection attaches a disposable tmux client through its own PTY.
// Disconnecting kills only that client. The shell and history remain in tmux,
// including when the application daemon itself is restarted.
func (m *Manager) connect(w http.ResponseWriter, r *http.Request) {
	t, err := m.Terminal(r.PathValue("id"))
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	stopped := false
	if _, err = m.tmux("has-session", "-t", "="+sessionName(t.ID)); err != nil {
		stopped = true
	}
	up := websocket.Upgrader{CheckOrigin: localRequest}
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	if stopped {
		conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(closeTerminalStopped, "terminal is stopped"), time.Now().Add(time.Second))
		return
	}
	cmd := exec.Command("tmux", "-L", m.socket, "-f", "/dev/null", "-T", "256,RGB", "attach-session", "-t", "="+sessionName(t.ID))
	// Never inherit an enclosing tmux session or tmux's terminal type.
	for _, v := range os.Environ() {
		if !strings.HasPrefix(v, "TMUX=") && !strings.HasPrefix(v, "TERM=") && !strings.HasPrefix(v, "COLORTERM=") {
			cmd.Env = append(cmd.Env, v)
		}
	}
	cmd.Env = append(cmd.Env, "TERM=xterm-256color", "COLORTERM=truecolor")
	streamPTY(conn, cmd, dimension(r.URL.Query().Get("cols"), 100), dimension(r.URL.Query().Get("rows"), 30), false)
}

// streamPTY runs cmd on a pseudo-terminal and bridges it to a WebSocket:
// binary frames carry output, JSON text frames carry input, resize and
// keepalive. When reportExit is set, a final {"type":"exit","code":n} frame
// tells the browser how the program ended before the socket closes.
func streamPTY(conn *websocket.Conn, cmd *exec.Cmd, cols, rows uint16, reportExit bool) {
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1011, "could not start terminal"), time.Now().Add(time.Second))
		return
	}
	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			f.Close()
			if cmd.Process != nil {
				cmd.Process.Kill()
			}
		})
	}
	defer cleanup()
	var writeMu sync.Mutex
	write := func(kind int, data []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteMessage(kind, data)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 32*1024)
		for {
			n, e := f.Read(buf)
			if n > 0 {
				if write(websocket.BinaryMessage, buf[:n]) != nil {
					cleanup()
					return
				}
			}
			if e != nil {
				return
			}
		}
	}()
	pings := make(chan struct{})
	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-pings:
				return
			case <-ticker.C:
				if write(websocket.TextMessage, []byte(`{"type":"ping"}`)) != nil {
					cleanup()
					return
				}
			}
		}
	}()
	defer close(pings)
	// The program may end on its own (an installer finishing, a client
	// detaching). Report that instead of waiting for the browser to notice.
	exited := make(chan int, 1)
	go func() {
		<-done
		state, _ := cmd.Process.Wait()
		code := -1
		if state != nil {
			code = state.ExitCode()
		}
		exited <- code
	}()
	inputs := make(chan []byte)
	readErr := make(chan error, 1)
	go func() {
		conn.SetReadLimit(1 << 20)
		conn.SetReadDeadline(time.Now().Add(pongWait))
		for {
			_, data, e := conn.ReadMessage()
			if e != nil {
				readErr <- e
				return
			}
			conn.SetReadDeadline(time.Now().Add(pongWait))
			inputs <- data
		}
	}()
	for {
		select {
		case code := <-exited:
			if reportExit {
				write(websocket.TextMessage, []byte(`{"type":"exit","code":`+strconv.Itoa(code)+`}`))
			}
			cleanup()
			conn.Close()
			return
		case <-readErr:
			cleanup()
			<-done
			cmd.Process.Wait()
			return
		case data := <-inputs:
			var msg struct {
				Type string `json:"type"`
				Data string `json:"data"`
				Cols uint16 `json:"cols"`
				Rows uint16 `json:"rows"`
			}
			if json.Unmarshal(data, &msg) != nil {
				cleanup()
				continue
			}
			switch msg.Type {
			case "input":
				if _, e := f.Write([]byte(msg.Data)); e != nil {
					cleanup()
				}
			case "resize":
				if msg.Cols >= 2 && msg.Cols <= 1000 && msg.Rows >= 2 && msg.Rows <= 1000 {
					pty.Setsize(f, &pty.Winsize{Cols: msg.Cols, Rows: msg.Rows})
				}
			case "ping":
				write(websocket.TextMessage, []byte(`{"type":"pong"}`))
			case "pong":
				// The read deadline above already extended liveness.
			}
		}
	}
}
