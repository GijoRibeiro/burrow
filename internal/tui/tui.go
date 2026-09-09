// Package tui implements the Bubble Tea terminal UI for Cloovies.
package tui

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/gorilla/websocket"

	"github.com/gijo/cloovies/internal/sprites"
)

// agent mirrors the JSON state from the daemon.
type agent struct {
	PID         int    `json:"pid"`
	SessionID   string `json:"sessionId"`
	Cwd         string `json:"cwd"`
	Name        string `json:"name"`
	CreatureID  string `json:"creatureId"`
	Status      string `json:"status"`
	CurrentTask string `json:"currentTask"`
}

type stateMsg struct {
	Agents []agent `json:"agents"`
}

type cmdResponseMsg struct {
	Text string `json:"text"`
}

type wsMsg struct {
	Type   string  `json:"type"`
	Agents []agent `json:"agents,omitempty"`
	Text   string  `json:"text,omitempty"`
}

type tickMsg time.Time
type connectedMsg struct{}
type wsDataMsg wsMsg
type wsErrorMsg struct{ err error }

// Model is the Bubble Tea model.
type Model struct {
	agents       []agent
	creatureMap  map[string]int // sessionID -> creature index
	creatureNext int
	frame        int // animation frame (0 or 1)
	chatInput    string
	chatResponse string
	wsURL        string
	ws           *websocket.Conn
	width        int
	height       int
	quitting     bool
}

// New creates a new TUI model without a connection.
func New(wsURL string) Model {
	return Model{
		wsURL:       wsURL,
		creatureMap: make(map[string]int),
	}
}

// NewWithConn creates a TUI model with a pre-established WebSocket.
func NewWithConn(wsURL string, ws *websocket.Conn) Model {
	return Model{
		wsURL:       wsURL,
		ws:          ws,
		creatureMap: make(map[string]int),
	}
}

func (m Model) Init() tea.Cmd {
	if m.ws != nil {
		// Already connected — start listening and ticking
		return tea.Batch(
			listenWS(m.ws),
			tickEvery(),
		)
	}
	return tea.Batch(
		connectWS(m.wsURL),
		tickEvery(),
	)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC, tea.KeyEsc:
			m.quitting = true
			return m, tea.Quit
		case tea.KeyEnter:
			if m.chatInput != "" {
				cmd := m.chatInput
				m.chatInput = ""
				return m, sendCommand(m.ws, cmd)
			}
		case tea.KeyBackspace:
			if len(m.chatInput) > 0 {
				m.chatInput = m.chatInput[:len(m.chatInput)-1]
			}
		case tea.KeyRunes:
			m.chatInput += string(msg.Runes)
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case connectedMsg:
		// connection established, start reading
		return m, listenWS(m.ws)

	case wsDataMsg:
		ws := wsMsg(msg)
		switch ws.Type {
		case "state":
			m.agents = ws.Agents
			// Assign creatures to new agents
			for _, a := range m.agents {
				if _, ok := m.creatureMap[a.SessionID]; !ok {
					m.creatureMap[a.SessionID] = m.creatureNext % len(sprites.AllCreatures)
					m.creatureNext++
				}
			}
		case "command_response":
			m.chatResponse = ws.Text
		}
		return m, listenWS(m.ws)

	case wsErrorMsg:
		// Reconnect after error
		return m, tea.Tick(2*time.Second, func(t time.Time) tea.Msg {
			return tickMsg(t)
		})

	case tickMsg:
		m.frame = (m.frame + 1) % 2
		if m.ws == nil {
			return m, tea.Batch(connectWS(m.wsURL), tickEvery())
		}
		return m, tickEvery()
	}

	return m, nil
}

func (m Model) View() string {
	if m.quitting {
		return ""
	}

	// Styles
	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("15"))

	dimStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("8"))

	// Top bar
	agentCount := fmt.Sprintf("%d agent", len(m.agents))
	if len(m.agents) != 1 {
		agentCount += "s"
	}
	topBar := lipgloss.JoinHorizontal(lipgloss.Center,
		titleStyle.Render("CLOOVIES"),
		strings.Repeat(" ", max(1, m.width-30)),
		dimStyle.Render(agentCount),
		"  ",
		dimStyle.Render(time.Now().Format("15:04")),
	)

	// Agent frames
	frames := make([]string, 0, len(m.agents))
	for _, a := range m.agents {
		frames = append(frames, m.renderAgentFrame(a))
	}

	var grid string
	if len(frames) == 0 {
		grid = dimStyle.Render("\n  No agents running. Start Claude Code in another terminal.\n")
	} else {
		// Lay frames out horizontally, wrapping
		grid = joinFrames(frames, m.width)
	}

	// Chat response
	responseStr := ""
	if m.chatResponse != "" {
		responseStr = dimStyle.Render("  " + m.chatResponse)
	}

	// Chat bar
	chatBar := fmt.Sprintf("  > %s█", m.chatInput)

	// Compose
	return topBar + "\n" + grid + "\n" + responseStr + "\n" + chatBar + "\n"
}

func (m Model) renderAgentFrame(a agent) string {
	creatureIdx := m.creatureMap[a.SessionID]
	creature := sprites.AllCreatures[creatureIdx]

	// Get current animation frame
	frameLines := creature.Frames[m.frame%len(creature.Frames)]

	// Creature name
	name := a.Name
	if name == "" {
		name = creature.Name
	}

	// Status
	status := a.Status
	if status == "" {
		status = "idle"
	}

	// Project path (shortened)
	project := shortenPath(a.Cwd)

	// Task
	task := a.CurrentTask
	if len(task) > 20 {
		task = task[:17] + "..."
	}

	// Build frame content
	nameStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("15"))
	dimStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("8"))

	innerWidth := 18
	content := "\n"
	for _, line := range frameLines {
		// Center the 16-char sprite in the frame
		pad := (innerWidth - 16) / 2
		content += strings.Repeat(" ", pad) + line + strings.Repeat(" ", pad) + "\n"
	}
	content += "\n"
	content += centerText(nameStyle.Render(strings.ToUpper(name)), innerWidth) + "\n"
	content += centerText(dimStyle.Render(strings.ToUpper(status)), innerWidth) + "\n"
	content += centerText(dimStyle.Render(project), innerWidth) + "\n"
	if task != "" {
		content += centerText(dimStyle.Render(task), innerWidth) + "\n"
	}

	// Dither border — fixed pattern, no shifting
	borderWidth := innerWidth + 2
	topBorder := sprites.DitherBorder(borderWidth, 0)
	botBorder := sprites.DitherBorder(borderWidth, 1)

	lines := strings.Split(content, "\n")
	var result strings.Builder
	result.WriteString(topBorder + "\n")
	for i, line := range lines {
		visLen := lipgloss.Width(line)
		padRight := innerWidth - visLen
		if padRight < 0 {
			padRight = 0
		}
		if i%2 == 0 {
			result.WriteString("░" + line + strings.Repeat(" ", padRight) + "░\n")
		} else {
			result.WriteString("▓" + line + strings.Repeat(" ", padRight) + "▓\n")
		}
	}
	result.WriteString(botBorder)

	return result.String()
}

func joinFrames(frames []string, maxWidth int) string {
	if len(frames) == 0 {
		return ""
	}

	// Join horizontally with gaps, wrap when exceeding width
	gap := "  "
	var rows []string
	var currentRow []string
	currentWidth := 0
	frameWidth := 22 // approximate

	for _, f := range frames {
		if currentWidth+frameWidth > maxWidth && len(currentRow) > 0 {
			rows = append(rows, lipgloss.JoinHorizontal(lipgloss.Top, currentRow...))
			currentRow = nil
			currentWidth = 0
		}
		if len(currentRow) > 0 {
			currentRow = append(currentRow, gap)
			currentWidth += 2
		}
		currentRow = append(currentRow, f)
		currentWidth += frameWidth
	}
	if len(currentRow) > 0 {
		rows = append(rows, lipgloss.JoinHorizontal(lipgloss.Top, currentRow...))
	}

	return "  " + strings.Join(rows, "\n\n  ")
}

func centerText(s string, width int) string {
	visLen := lipgloss.Width(s)
	if visLen >= width {
		return s
	}
	pad := (width - visLen) / 2
	return strings.Repeat(" ", pad) + s
}

func shortenPath(path string) string {
	if path == "" {
		return ""
	}
	parts := strings.Split(path, "/")
	return parts[len(parts)-1]
}

// --- WebSocket commands ---

func connectWS(url string) tea.Cmd {
	return func() tea.Msg {
		return connectedMsg{}
	}
}

func listenWS(ws *websocket.Conn) tea.Cmd {
	return func() tea.Msg {
		if ws == nil {
			return wsErrorMsg{fmt.Errorf("no connection")}
		}
		_, msg, err := ws.ReadMessage()
		if err != nil {
			return wsErrorMsg{err}
		}
		var data wsMsg
		if err := json.Unmarshal(msg, &data); err != nil {
			return wsErrorMsg{err}
		}
		return wsDataMsg(data)
	}
}

func sendCommand(ws *websocket.Conn, text string) tea.Cmd {
	return func() tea.Msg {
		if ws == nil {
			return nil
		}
		cmd := map[string]string{"type": "command", "text": text}
		data, _ := json.Marshal(cmd)
		ws.WriteMessage(websocket.TextMessage, data)
		return nil
	}
}

func tickEvery() tea.Cmd {
	return tea.Tick(800*time.Millisecond, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
