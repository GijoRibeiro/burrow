# Workspace comparison

Checked against the installed Orca 1.4.178 CLI and its version-matched guides on September 14, 2026. This compares the current workspace app, not unused legacy services in this repository. It is not a complete Orca feature inventory.

| Capability | This app | Orca |
| --- | --- | --- |
| Projects, worktrees, persistent terminals | Supported; a canvas can mix terminals across projects | Supported |
| Worktrees from Linear | Ticket search, editable branch, saved issue link, ticket context in new agent drafts | Also supports richer ticket triage, state changes, comments, relations, and PR links |
| Agent providers | Claude Code and Codex launch buttons; other CLIs can run in a shell | Additional managed provider choices, including OMP, Pi, and Grok |
| Repository setup | Manual commands in each checkout | Configurable setup hooks and terminal defaults |
| Worktree organization | Optional parent/child relationships; existing worktrees stay flat | Parent/child lineage, comments, and worktree status |
| Scheduled work | Not implemented | Scheduled automations targeting workspaces or new worktrees |
| Agent coordination | Optional delegation, durable messages, explicit task status, and reviewed integration; independent sessions remain available | Structured messaging, task dependencies, dispatch, and worker coordination |
| Browser and previews | Open external links and local image thumbnails | Worktree-scoped embedded browser and browser automation |
| Remote environments | Local workspace | Remote environment management capabilities |
| Programmatic control | Local HTTP API | A documented CLI for worktrees, terminals, browser, Linear, and automations |

The next practical additions would be repository setup hooks, richer Linear workflow updates, and an integrated browser preview. Those would remove repeated manual steps while preserving the cross-project terminal canvas.

## Naming ideas

- **Termlings** — terminal companions; playful and immediately connected to the product.
- **Shellkin** — a family of small creatures living in your shells.
- **Promptlings** — little AI companions, with less emphasis on the terminal itself.
- **Burrow** — a shared home for your working creatures; already the repository's working name.

These are creative suggestions; domain, trademark, and package-name availability have not been checked. No product rename is included in this change.
