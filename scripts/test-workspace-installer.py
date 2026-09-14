from pathlib import Path
import subprocess,tempfile,os
script=Path(__file__).resolve().parent.parent/'app/setup/install.command'
# Export Bash functions to intercept discovery/install calls; no real package manager runs.
base='''command() { if [ "$1" = "-v" ]; then case "$2" in brew) echo brew; return 0;; tmux|claude|codex) return "$TOOLS_PRESENT";; esac; fi; builtin command "$@"; }
git() { return "$TOOLS_PRESENT"; }
brew() { printf '%s\\n' "$*" >> "$INSTALL_LOG"; }
export -f command git brew
exec /bin/bash "$INSTALL_SCRIPT" "$INSTALL_CHOICE"
'''
for choice,missing,expected in [('required',1,['install git','install tmux']),('claude',1,['install --cask claude-code']),('codex',1,['install --cask codex']),('required',0,[]),('claude',0,[]),('codex',0,[]),('invalid',1,[])]:
 with tempfile.TemporaryDirectory(prefix='burrow-install-test-') as root:
  log=Path(root)/'install.log'
  env=dict(os.environ, TMPDIR=root,INSTALL_LOG=str(log),INSTALL_SCRIPT=str(script),INSTALL_CHOICE=choice,TOOLS_PRESENT=str(missing))
  out=subprocess.run(['/bin/bash','-c',base],env=env,capture_output=True,text=True)
  assert out.returncode==(1 if choice=='invalid' else 0),(choice,out.stderr)
  assert (log.read_text().splitlines() if log.exists() else [])==expected
  assert not list(Path(root).glob('*.lock'))
print('Installer: required, optional, existing-tool, invalid-choice and lock cleanup checks passed; no real installations.')
