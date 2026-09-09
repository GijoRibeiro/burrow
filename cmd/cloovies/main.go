package main

import (
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/gorilla/websocket"

	"github.com/gijo/cloovies/internal/tui"
)

func main() {
	host := flag.String("host", "localhost:3333", "Daemon address")
	flag.Parse()

	wsURL := fmt.Sprintf("ws://%s/ws", *host)

	// Connect to daemon
	u, err := url.Parse(wsURL)
	if err != nil {
		log.Fatalf("invalid URL: %v", err)
	}

	ws, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Cannot connect to daemon at %s\nMake sure clooviesd is running: make daemon\n", wsURL)
		os.Exit(1)
	}

	model := tui.NewWithConn(wsURL, ws)

	p := tea.NewProgram(model, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		log.Fatal(err)
	}

	ws.Close()
}
