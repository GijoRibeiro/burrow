from pathlib import Path
import subprocess,tempfile,os
script=Path(__file__).resolve().parent.parent/'app/setup/install.command'
# Export Bash functions to intercept discovery/install calls; no real package manager runs.
# CLT_MISSING=1 simulates a Mac without Command Line Tools until `xcode-select --install` ran.
base='''command() { if [ "$1" = "-v" ]; then case "$2" in brew) echo brew; return 0;; npm) return "$NPM_MISSING";; tmux|claude|codex) return "$TOOLS_PRESENT";; esac; fi; builtin command "$@"; }
git() { return "$TOOLS_PRESENT"; }
brew() { printf '%s\\n' "$*" >> "$INSTALL_LOG"; [ "$BREW_FAIL" = 0 ] || return 1; case "$*" in "install --cask"*) return "$BREW_FAIL_CASK";; esac; }
npm() { printf 'npm %s\\n' "$*" >> "$INSTALL_LOG"; }
xcode-select() { case "$1" in --install) printf '%s\\n' "xcode-select --install" >> "$INSTALL_LOG"; touch "$TMPDIR/clt";; -p) [ "$CLT_MISSING" = 0 ] || [ -e "$TMPDIR/clt" ];; esac; }
sleep() { :; }
export -f command git brew npm xcode-select sleep
exec /bin/bash "$INSTALL_SCRIPT" "$INSTALL_CHOICE"
'''
cases=[('required',1,['install git','install tmux'],{}),('claude',1,['install --cask claude-code'],{}),('codex',1,['install --cask codex'],{}),
 ('required',0,[],{}),('claude',0,[],{}),('codex',0,[],{}),('invalid',1,[],{}),
 # Command Line Tools are installed before git is probed or Homebrew runs.
 ('required',1,['xcode-select --install','install git','install tmux'],{'CLT_MISSING':'1'}),
 # A failing cask falls back to npm when npm exists, otherwise the step fails.
 ('claude',1,['install --cask claude-code','npm install -g @anthropic-ai/claude-code'],{'BREW_FAIL_CASK':'1'}),
 ('codex',1,['install --cask codex','npm install -g @openai/codex'],{'BREW_FAIL_CASK':'1'}),
 ('codex',1,['install --cask codex'],{'BREW_FAIL_CASK':'1','NPM_MISSING':'1','FAILS':'Codex'}),
 # Failures never abort before the summary.
 ('required',1,['install git','install tmux'],{'BREW_FAIL':'1','FAILS':'Git, tmux'})]
for choice,missing,expected,extra in cases:
 with tempfile.TemporaryDirectory(prefix='burrow-install-test-') as root:
  log=Path(root)/'install.log'
  env={**os.environ,'TMPDIR':root,'INSTALL_LOG':str(log),'INSTALL_SCRIPT':str(script),'INSTALL_CHOICE':choice,'TOOLS_PRESENT':str(missing),'CLT_MISSING':'0','BREW_FAIL':'0','BREW_FAIL_CASK':'0','NPM_MISSING':'0',**{k:v for k,v in extra.items() if k!='FAILS'}}
  out=subprocess.run(['/bin/bash','-c',base],env=env,capture_output=True,text=True)
  fails=extra.get('FAILS')
  assert out.returncode==(1 if choice=='invalid' or fails else 0),(choice,extra,out.returncode,out.stdout,out.stderr)
  assert (log.read_text().splitlines() if log.exists() else [])==expected,(choice,extra,log.read_text() if log.exists() else '')
  assert not list(Path(root).glob('*.lock'))
  if choice!='invalid':
   assert 'Return to Cloovies — it detects tools automatically.' in out.stdout,(choice,out.stdout)
   assert all(f'\n{tool:<8} ' in out.stdout for tool in ['git','tmux','claude','codex','gh']),(choice,out.stdout)
   if fails: assert f'Not finished: {fails}.' in out.stdout,(choice,out.stdout)
   else: assert 'Not finished' not in out.stdout,(choice,out.stdout)
print('Installer: required, optional, existing-tool, invalid-choice, CLT ordering, npm fallback, failure summary and lock cleanup checks passed; no real installations.')
