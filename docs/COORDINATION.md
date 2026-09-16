# Optional agent teamwork

Ordinary projects, worktrees, Claude/Codex terminals, shells, and the cross-project canvas keep working independently. Teamwork is opt-in.

## A head agent and a team canvas

Choose **+ Head agent**, pick a project checkout and Claude or Codex, and describe
what you want to work on. For example: “Check my Linear tickets, help me choose
three, and coordinate one worker per ticket.” Use **Linear connection** in the
sidebar to connect your personal API key once. The head uses your existing CLI
account; no extra AI subscription or API key is required by Burrow. Provider
sign-in or first-folder trust screens can still appear: use **Terminal view** to
complete them. Workers are created after approval, but a provider awaiting its
own onboarding needs your attention before it can work.

The head can read your assigned open tickets, fetch full ticket descriptions,
discuss scope in its terminal, and propose a team. Empty Linear searches return
up to 50 open assigned tickets; search by title or identifier to narrow the list.
Proposed workers appear as dashed cards. **Review plan** shows the rationale,
provider, branch, ticket link, and instructions for each worker. **Approve and
start team** creates one child checkout and terminal per item. **Ask for a
different plan** dismisses it and sends feedback to the head; continue the
conversation before it proposes a replacement.

Plans support up to 12 independent assignments. Each team belongs to the head's
project and starts from the head checkout's committed state. Use separate heads
for different projects. For dependent work, let the head propose the next batch
after you integrate its prerequisites. The head is instructed to coordinate and
leave implementation to isolated workers.

The head receives worker questions and status updates through its durable inbox.
It is instructed to keep a `wait 60` loop while supervising, reply to workers,
acknowledge messages, and summarize results to you. This is a real CLI agent
following instructions, not a guaranteed always-on scheduler: if it stops or
returns to its prompt, ask it to resume supervision. Closing the app preserves
processes, but coordination requests need the local app server to be running.

**Team canvas** and **Terminals** are two views of the same sessions. The canvas
supports dragging cards, panning, zooming, fitting, arranging, and choosing one
head's team or all agents. Select a creature to open its normal terminal beside
the graph. **Open in terminals** adds it to the regular terminal layout. Switching
views preserves the split layout, drafts, creatures, and running processes. Tab
and Shift+Tab move among agents on the canvas, or visible panes in terminal view.
Canvas positions, zoom, view choice, and sidebar filtering persist locally.

Launch progress is saved. **Retry remaining workers** resumes a partial launch
without duplicating successful workers, including after restarting the app. A
worker whose identity was saved immediately before an interrupted launch is
started on retry. Existing stopped or exited agents are not silently restarted.
Results still require review and explicit integration in **Tasks and inbox**;
heads do not automatically merge changes, terminate agents, or update Linear.

**Active agents only** hides sidebar projects without a running Claude or Codex
process. It does not remove projects, stop shells, or alter your terminal layout.

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

There is no automatic merging or dependency scheduler. Ordinary agents can delegate smaller tasks with the CLI, creating another level of child worktrees. Head agents use reviewed team plans instead of the direct delegation command.

## Agent CLI

The standalone server creates a local `bin/burrow` launcher next to its workspace state. Managed agents receive their identity and that directory on PATH. The launch prompt also contains the absolute command path. For existing terminals, the panel generates a command with an explicit agent ID. No global CLI installation or project instruction-file changes are required.

```sh
burrow help
burrow linear
burrow linear ENG-123
burrow issue ENG-123
burrow plans
burrow propose '{"title":"Morning work","summary":"Independent fixes","items":[{"issueId":"ENG-123","name":"eng-123-menu","program":"codex","title":"Fix menu","instructions":"Implement, test, and commit the menu fix."}]}'
burrow send user 'The workers are running; I am checking their progress.'
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
