# Optional agent teamwork

Ordinary projects, worktrees, Claude/Codex terminals, shells, and the cross-project canvas keep working independently. Teamwork is opt-in.

## Child worktrees

Right-click any checkout row and choose **Create child worktree…**. The new branch starts from that checkout's latest commit. Uncommitted edits stay in the parent. Each checkout remains an independent directory under the project's `.worktrees` folder, while the sidebar displays its parent/child relationship. Creating a child does not start an agent.

Existing and externally created worktrees remain flat. Missing parents do not hide surviving checkouts. The app refuses to remove a parent checkout while it still has child checkouts. Terminal arrangement stays independent of this hierarchy.

## Delegate a task

Right-click a Claude or Codex terminal and choose **Delegate task…**, or use **Tasks and inbox → Delegate task**. Choose the parent agent, child branch name, agent provider, task title, and instructions. The parent must be checked out on a branch.

The app creates a child worktree and starts the selected agent in YOLO mode with task context and coordination instructions. The parent remains available; the child terminal is added to the canvas. A failed launch rolls back the new task and clean checkout.

Newly delegated agents know how to check messages and report status. For an existing parent or independent agent, open **Tasks and inbox → Connect an existing agent**, select the message recipient, and copy those instructions into its prompt once. This is deliberately explicit: the app does not inject messages into a busy terminal. You can also read and reply to all task messages yourself in the panel.

## Messages and status

Messages are durable and pull-based. Agents check their inbox between work steps or use a bounded wait when expecting a reply. A busy agent is not interrupted automatically. Messages remain queued until the recipient explicitly acknowledges them; merely viewing the panel does not acknowledge them. Agents need to follow the supplied coordination instructions for timely replies.

Statuses are **working**, **waiting** (needs an answer), **done**, and **canceled**. They are explicitly reported, independent of terminal running/stopped status. Marking a task canceled does not kill its process. Stop or terminate the terminal separately if needed. Done requires a clean checkout and a completion summary; agents must commit their changes first. Restarting a delegated terminal supplies its current task context and tells it not to repeat completed or canceled work.

## Review and integration

A done task records the exact result commit. **Review changes** shows its committed changes since the common ancestor with the parent. **Integrate into parent** asks for confirmation, then merges that recorded commit. It requires the original parent branch, an unchanged parent commit since review, a clean parent checkout, and no existing merge/rebase/cherry-pick. A conflicting merge is aborted; the parent returns to its previous committed state. Git hooks and repository configuration still apply. Large diffs are truncated in the preview and should be reviewed fully in the terminal.

There is no automatic merging, scheduling, dependency graph, or autonomous dispatch loop. An agent can delegate a smaller task using the same CLI, creating another level of child worktrees.

## Agent CLI

The standalone server creates a local `bin/burrow` launcher next to its workspace state. Managed agents receive their identity and that directory on PATH. The launch prompt also contains the absolute command path. For existing terminals, the panel generates a command with an explicit agent ID. No global CLI installation or project instruction-file changes are required.

```sh
burrow help
burrow agents
burrow tasks
burrow task
burrow inbox
burrow send parent 'Which response format should I use?'
burrow wait 60
burrow ack MESSAGE_ID
burrow status waiting 'Need the API response format'
burrow status done 'Implemented the endpoint; unit tests passed'
burrow delegate api-child codex 'Add API tests' 'Cover successful and failing requests; commit your changes.'
```

For long messages, `send ... -`, `status ... -`, and the final `delegate` argument `-` read stdin. Commands print JSON. The app must be running for the CLI to work; messages and tasks remain on disk if it closes. Reopen the app and retry after a connection error. The launcher is refreshed on startup, so it follows the installed server across updates.

The local server validates an agent-specific token for agent API calls and derives the sender from that identity. Tokens live in the owner-readable workspace state, are not printed by the CLI, and are excluded from browser snapshots. This prevents accidental sender mix-ups; it is not a sandbox between agents that have broad access to the same user's files. Task conversations are retained locally with workspace metadata, and no cloud coordination service is used.
