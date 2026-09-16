# Updating a development build with running terminals

The native app and its tmux descendants share macOS's attribution for folder
permissions. Ad-hoc signatures identify a specific build, so old and new builds
of the same bundle ID can repeatedly replace each other's Documents permission.
Apple describes this limitation in [Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).

In particular, do not leave an older `.app` alongside a replacement after moving
it out of the installation path. Surviving terminals can remain attributed to
that moved bundle, even after its GUI has quit. This caused the September 14
development update's repeating folder permission dialog.

For a local update:

1. Stage and verify the new signed bundle before touching the installed copy.
2. Record the existing workspace tmux pane IDs and process IDs. Quit the GUI and
   wait for its owned HTTP server to stop; keep the tmux server and agents alive.
3. Move the installed bundle aside and put the verified replacement at the
   original installation path.
4. Before reopening the app, retire the moved copy:

   ```sh
   python3 scripts/retire-app-backup.py /path/to/previous.app /path/to/Cloovies.app
   ```

   This checks both signatures and matching bundle IDs, saves and verifies a ZIP
   of the old bundle, and replaces its old path with a symlink to the installed
   app. The original bundle remains recoverable without leaving a competing app
   identity at the path retained by older processes. Keep the redirect while
   those processes are alive. If interrupted during retirement, the verified ZIP
   is the recovery copy.
5. Reopen the installed app. macOS may ask once for the new build's folder access.
   Verify that the workspace loads, pane process IDs are unchanged, and folder
   access from both the app and the existing tmux server succeeds without
   repeated prompts. Do not reset TCC or grant broader permissions as a fix.

The native repair was verified with the existing tmux server running a separate,
read-only Git probe; no prompts or commands were sent to working agents.

Native readiness uses `/api/workspace/health`, which does not scan repositories.
A slow Git operation therefore cannot cause repeated startup scans. Git timeouts
also stop descendants, including the child process launched by Apple's Git shim.
If an updated build opens but Git scans time out on an existing project, try
**Add project → Browse** and select that project's folder again to renew the
native folder selection. You can cancel the Add project dialog afterward. This
restored folder access during the v0.5.1 update and survived a normal relaunch.

For distribution, sign successive releases with the same Developer ID identity
and notarize them. The current ad-hoc preview does not provide permission
continuity across releases. `CLOOVIES_SIGN_IDENTITY` selects the packaging signing
identity when a distribution certificate is available.

Run `python3 scripts/test-app-backup.py` on macOS to check archival, redirection,
idempotency, and refusal of unsafe inputs using disposable signed bundles.
