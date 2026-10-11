// workspace is the small standalone terminal-workspace server. It does not
// scan agent transcripts or launch any agent processes on startup.
package main

import (
	"context"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	cloovies "github.com/gijo/cloovies"
	"github.com/gijo/cloovies/internal/agentcli"
	"github.com/gijo/cloovies/internal/env"
	"github.com/gijo/cloovies/internal/workspace"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "agent" {
		if err := agentcli.Run(os.Args[2:], os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	port := flag.Int("port", 3333, "Local HTTP port")
	web := flag.String("web", "", "Built web directory (defaults to embedded assets)")
	flag.Parse()
	home, _ := os.UserHomeDir()
	env.AugmentPATH(home)
	m, err := workspace.NewDefault()
	if err != nil {
		log.Fatal(err)
	}
	defer m.CloseClones()
	m.SetInstaller(cloovies.EmbeddedInstaller)
	if err := m.ConfigureAgentRuntime(fmt.Sprintf("http://127.0.0.1:%d", *port)); err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	handler := m.Handler()
	mux.Handle("/api/workspace", handler)
	mux.Handle("/api/workspace/", handler)
	if *web != "" {
		mux.Handle("/", http.FileServer(http.Dir(*web)))
	} else {
		sub, err := fs.Sub(cloovies.EmbeddedWeb, "web/dist")
		if err != nil {
			log.Fatal(err)
		}
		mux.Handle("/", http.FileServer(http.FS(sub)))
	}
	srv := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", *port), Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	m.OnShutdown(stop)
	// The native app passes its own PID. When it is gone (crash, force quit),
	// exit so a later launch never adopts an orphaned, possibly stale server.
	// tmux keeps the terminals either way.
	if parent, err := strconv.Atoi(os.Getenv("CLOOVIES_PARENT_PID")); err == nil && parent > 1 {
		go func() {
			for {
				time.Sleep(2 * time.Second)
				if os.Getppid() != parent || syscall.Kill(parent, 0) != nil {
					log.Printf("parent process %d is gone; stopping", parent)
					stop()
					return
				}
			}
		}()
	}
	m.StartComplaintMonitor(ctx)
	defer func() { stop(); m.WaitComplaintShutdown() }()
	go func() {
		<-ctx.Done()
		timeout, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(timeout)
	}()
	// Bind before announcing readiness, and fail loudly: a silent zero exit on a
	// busy port left the native app waiting for a server that never came.
	listener, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		log.Printf("cannot listen on %s: %v (is another Cloovies or service using this port?)", srv.Addr, err)
		os.Exit(1)
	}
	log.Printf("Cloovies workspace %s at http://%s", workspace.Version(), srv.Addr)
	if err := srv.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Print(err)
		os.Exit(1)
	}
}
