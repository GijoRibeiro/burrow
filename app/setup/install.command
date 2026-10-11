#!/bin/bash
# This installer runs only when a person chooses Install in first-run setup.
# No `set -e`: each step records its own outcome so the summary always prints.
set -uo pipefail
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
failed=""
fail() { failed="${failed:+$failed, }$1"; printf '\n!! %s did not finish. Read the error above, then retry from Cloovies.\n' "$1"; }

# Apple Command Line Tools must exist before anything calls `git`: on a Mac
# without them /usr/bin/git only opens Apple's install dialog and exits non-zero.
has_clt() { xcode-select -p >/dev/null 2>&1; }
ensure_clt() {
  has_clt && return 0
  printf 'Apple Command Line Tools are needed for Git and Homebrew. macOS now shows an install dialog:\n'
  printf 'choose Install and wait for it to finish (a few minutes, longer on slow connections).\n'
  printf 'This window continues by itself once the tools are installed.\n\n'
  xcode-select --install >/dev/null 2>&1 || true
  waited=0
  until has_clt; do
    sleep 10; waited=$((waited + 10))
    if [ "$waited" -ge 1800 ]; then printf 'Command Line Tools were not installed after 30 minutes.\n'; return 1; fi
    [ $((waited % 60)) -ne 0 ] || printf 'Still waiting for Command Line Tools (%d min)...\n' "$((waited / 60))"
  done
  printf 'Command Line Tools installed.\n'
}
ensure_brew() {
  command -v brew >/dev/null 2>&1 && return 0
  printf 'Homebrew is needed to install these tools. Its installer may ask for your Mac password.\n\n'
  installer_file="$(mktemp -t cloovies-homebrew)" || return 1
  /usr/bin/curl --fail --location --show-error --silent https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$installer_file" || return 1
  /bin/bash "$installer_file" || return 1
  command -v brew >/dev/null 2>&1
}
has_git() {
  # Without Command Line Tools the Apple git shim must not be probed.
  if has_clt; then git --version >/dev/null 2>&1; return; fi
  real=$(command -v git 2>/dev/null) || return 1
  [ "$real" != /usr/bin/git ] && "$real" --version >/dev/null 2>&1
}
brew_install() { ensure_clt && ensure_brew && brew install "$@"; }
# Casks need Homebrew; the npm package is the fallback when the cask or Homebrew itself fails.
install_agent() { # <cask> <npm package>
  brew_install --cask "$1" && return 0
  if command -v npm >/dev/null 2>&1; then
    printf '\nHomebrew could not install %s. Trying npm instead.\n' "$1"
    npm install -g "$2"
  else
    return 1
  fi
}

printf '\nCloovies setup — %s\n\n' "$choice"
case "$choice" in
 required)
  if ensure_clt; then
    if ! has_git; then brew_install git || fail Git; fi
  else
    fail "Command Line Tools"; failed="$failed, Git"
  fi
  if ! command -v tmux >/dev/null 2>&1; then brew_install tmux || fail tmux; fi
  ;;
 claude)
  if ! command -v claude >/dev/null 2>&1; then install_agent claude-code @anthropic-ai/claude-code || fail "Claude Code"; fi
  ;;
 codex)
  if ! command -v codex >/dev/null 2>&1; then install_agent codex @openai/codex || fail Codex; fi
  ;;
 github)
  if ! command -v gh >/dev/null 2>&1; then brew_install gh || fail "GitHub CLI"; fi
  if command -v gh >/dev/null 2>&1; then gh auth login --hostname github.com --git-protocol https --web || fail "GitHub sign-in"; fi
  ;;
esac

tool_present() { case "$1" in git) has_git ;; *) command -v "$1" >/dev/null 2>&1 ;; esac; }
tool_version() { case "$1" in tmux) tmux -V ;; *) "$1" --version ;; esac 2>/dev/null | head -n 1; }
printf '\n%-8s %-11s %s\n' Tool Status Version
for tool in git tmux claude codex gh; do
  if tool_present "$tool"; then
    version=$(tool_version "$tool"); printf '%-8s %-11s %s\n' "$tool" installed "${version:-(version unknown)}"
  else
    printf '%-8s %-11s %s\n' "$tool" missing -
  fi
done
if [ -n "$failed" ]; then printf '\nNot finished: %s. Fix the error shown above and retry from Cloovies.\n' "$failed"; fi
printf '\nReturn to Cloovies — it detects tools automatically.\n'
[ -z "$failed" ]
