# Working on this project

The current app is a local workspace for projects, Git worktrees, and persistent terminals. Read `README.md` for setup and `docs/WORKSPACE.md` for architecture. The original Bitwise dashboard is retained at `/legacy.html`; see `docs/LEGACY-DASHBOARD.md`.

## Current implementation

- `internal/workspace/`: Git projects, terminal lifecycle, activity and image previews, HTTP/WebSocket transport.
- `cmd/workspace/`: standalone loopback server.
- `web/src/workspace/`: TypeScript workspace UI and xterm terminal panes.
- `app/workspace.swift`: native macOS wrapper.
- `scripts/build-workspace-app.sh`: standalone Apple Silicon app build.

## Build and verify

```sh
make build-workspace
make workspace-app  # macOS with Xcode Command Line Tools

go test ./...
go test -race ./internal/workspace
cd web
npm test
npm run test:workspace
```

Build the frontend before Go tests: the Go binary embeds `web/dist`. Workspace integration tests use temporary Git repositories and dedicated tmux sockets. Never run tests against a user's live terminals or remove their session state. Keep shell processes alive when a pane is hidden or the app closes.

## UI

DM Sans for interface text, Google Sans Code for terminal/code text, small pixel creatures, per-terminal colors, and restrained motion. Respect reduced motion. Agent view shows a quieter transcript; Terminal view preserves the CLI's native ANSI formatting.

## Persistence

The current compatibility identifiers use `~/.cloovies/workspace.json`, tmux socket `cloovies-workspace`, and `CLOOVIES_*` environment variables. Preserve them unless a tested migration is part of the change.
