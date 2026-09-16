#!/bin/bash
# This installer runs only when a person chooses Install in first-run setup.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
choice="${1:-required}"
case "$choice" in required|claude|codex|github) ;; *) printf 'Unknown setup choice\n'; exit 1;; esac
setup_lock="${TMPDIR:-/tmp}/cloovies-setup-${UID}.lock"
if ! mkdir "$setup_lock" 2>/dev/null; then
  printf 'Another setup is running. Finish or close its Terminal window before retrying.\n'
  exit 1
fi
installer_file=""
cleanup() { [ -z "$installer_file" ] || rm -f "$installer_file"; rmdir "$setup_lock"; }
trap cleanup EXIT
printf '\nCloovies setup — %s\n\n' "$choice"
if ! command -v brew >/dev/null 2>&1 && { [ "$choice" != "github" ] || ! command -v gh >/dev/null 2>&1; }; then
  printf 'Homebrew is needed to install these tools. Its installer may ask for your Mac password and install Apple Command Line Tools.\n\n'
  installer_file="$(mktemp -t cloovies-homebrew)"
  /usr/bin/curl --fail --location --show-error --silent https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$installer_file"
  /bin/bash "$installer_file"
fi
case "$choice" in
 required)
  if ! git --version >/dev/null 2>&1; then brew install git; fi
  if ! command -v tmux >/dev/null 2>&1; then brew install tmux; fi
  ;;
 claude)
  if ! command -v claude >/dev/null 2>&1; then brew install --cask claude-code; fi
  ;;
 codex)
  if ! command -v codex >/dev/null 2>&1; then brew install --cask codex; fi
  ;;
 github)
  if ! command -v gh >/dev/null 2>&1; then brew install gh; fi
  gh auth login --hostname github.com --git-protocol https --web
  ;;
esac
printf '\nSetup finished. Return to Cloovies to continue.\n'
