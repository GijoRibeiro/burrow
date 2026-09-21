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
	if _, err = m.tmux("has-session", "-t", "="+sessionName(t.ID)); err != nil {
		http.Error(w, "terminal is stopped", 410)
		return
	}
	up := websocket.Upgrader{CheckOrigin: localRequest}
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	cmd := exec.Command("tmux", "-L", m.socket, "-f", "/dev/null", "-T", "256,RGB", "attach-session", "-t", "="+sessionName(t.ID))
	// Never inherit an enclosing tmux session or tmux's terminal type.
	for _, v := range os.Environ() {
		if !strings.HasPrefix(v, "TMUX=") && !strings.HasPrefix(v, "TERM=") && !strings.HasPrefix(v, "COLORTERM=") {
			cmd.Env = append(cmd.Env, v)
		}
	}
	cmd.Env = append(cmd.Env, "TERM=xterm-256color", "COLORTERM=truecolor")
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: dimension(r.URL.Query().Get("cols"), 100), Rows: dimension(r.URL.Query().Get("rows"), 30)})
	if err != nil {
		conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1011, "could not attach terminal"), time.Now().Add(time.Second))
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
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer conn.Close()
		buf := make([]byte, 32*1024)
		for {
			n, e := f.Read(buf)
			if n > 0 {
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if conn.WriteMessage(websocket.BinaryMessage, buf[:n]) != nil {
					return
				}
			}
			if e != nil {
				return
			}
		}
	}()
	conn.SetReadLimit(1 << 20)
	for {
		_, data, e := conn.ReadMessage()
		if e != nil {
			break
		}
		var msg struct {
			Type string `json:"type"`
			Data string `json:"data"`
			Cols uint16 `json:"cols"`
			Rows uint16 `json:"rows"`
		}
		if json.Unmarshal(data, &msg) != nil {
			break
		}
		switch msg.Type {
		case "input":
			if _, e = f.Write([]byte(msg.Data)); e != nil {
				cleanup()
			}
		case "resize":
			if msg.Cols >= 2 && msg.Cols <= 1000 && msg.Rows >= 2 && msg.Rows <= 1000 {
				pty.Setsize(f, &pty.Winsize{Cols: msg.Cols, Rows: msg.Rows})
			}
		}
	}
	cleanup()
	<-done
	cmd.Wait()
}
