// Worktree-spawn popover. Anchored to an agent frame; renders a tiny
// form (name input + Spawn / Cancel buttons + inline error) and, when
// asked, a list of *existing* worktrees under .claude/worktrees/ above
// the form so the user can either "resume" (spin a new tmux+claude in
// an already-on-disk worktree) or create a brand-new one. Lifecycle:
// `open(anchor, onConfirm, options?)` mounts the popover. `onConfirm`
// is called with the validated name for new-worktree spawns; the caller
// is responsible for sending the WebSocket request, surfacing errors
// back via `setError`, and calling `close()` on success. We keep the
// popover dumb about transport so it can be reused if the spawn path
// ever moves to HTTP. The caller drives the existing-list via
// `handle.setExisting(rows)` once the server response comes back.

let activeEl: HTMLElement | null = null;
let activeAnchor: HTMLElement | null = null;
let activeErrorEl: HTMLElement | null = null;
let activeNameInput: HTMLInputElement | null = null;
let activeSpawnBtn: HTMLButtonElement | null = null;

export interface SpawnRequest {
  name: string;
}

export interface ExistingWorktreeRow {
  name: string;
  branch: string;
  hasSession: boolean;
}

export interface SpawnHandle {
  setError: (msg: string) => void;
  setBusy: (busy: boolean) => void;
  setExisting: (rows: ExistingWorktreeRow[]) => void;
  close: () => void;
}

export function openWorktreeSpawn(
  anchor: HTMLElement,
  onConfirm: (req: SpawnRequest, handle: SpawnHandle) => void,
  options?: {
    existing?: ExistingWorktreeRow[];
    onResume?: (name: string) => void;
    onDelete?: (name: string) => void;
    loading?: boolean;
  },
): SpawnHandle {
  closeWorktreeSpawn();

  const popover = document.createElement('div');
  popover.className = 'worktree-spawn-popover';

  const title = document.createElement('div');
  title.className = 'worktree-spawn-title';
  title.textContent = 'spawn sibling in worktree';
  popover.appendChild(title);

  // Existing-worktrees section (initially either a loading placeholder
  // or empty/hidden). The placeholder lives at a fixed slot so we can
  // swap it for the actual list once `setExisting` is called without
  // having to re-build the rest of the popover.
  const existingSlot = document.createElement('div');
  existingSlot.className = 'worktree-spawn-existing-slot';
  popover.appendChild(existingSlot);

  // Divider between existing list and new-worktree form — only shown
  // when there's actually an existing section visible above it.
  const divider = document.createElement('div');
  divider.className = 'worktree-spawn-divider';
  divider.textContent = 'new worktree';
  divider.style.display = 'none';
  popover.appendChild(divider);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'worktree-spawn-name';
  nameInput.placeholder = 'name (e.g. login-redesign)';
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  popover.appendChild(nameInput);

  const errorEl = document.createElement('div');
  errorEl.className = 'worktree-spawn-error';
  popover.appendChild(errorEl);

  const buttonRow = document.createElement('div');
  buttonRow.className = 'worktree-spawn-buttons';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'worktree-spawn-cancel';
  cancelBtn.textContent = 'cancel';
  cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); closeWorktreeSpawn(); });
  buttonRow.appendChild(cancelBtn);

  const spawnBtn = document.createElement('button');
  spawnBtn.className = 'worktree-spawn-go';
  spawnBtn.textContent = 'spawn';
  buttonRow.appendChild(spawnBtn);

  popover.appendChild(buttonRow);

  const renderExisting = (rows: ExistingWorktreeRow[]) => {
    existingSlot.replaceChildren();
    if (rows.length === 0) {
      divider.style.display = 'none';
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'worktree-spawn-existing';

    const header = document.createElement('div');
    header.className = 'worktree-spawn-existing-title';
    header.textContent = 'existing worktrees';
    wrap.appendChild(header);

    for (const row of rows) {
      const r = document.createElement('div');
      r.className = 'worktree-spawn-existing-row';

      const label = document.createElement('div');
      label.className = 'row-label';
      const nm = document.createElement('div');
      nm.className = 'worktree-spawn-existing-name';
      nm.textContent = row.name;
      label.appendChild(nm);
      const br = document.createElement('div');
      br.className = 'worktree-spawn-existing-branch';
      br.textContent = row.branch || '(detached)';
      label.appendChild(br);
      r.appendChild(label);

      if (row.hasSession) {
        const running = document.createElement('div');
        running.className = 'worktree-spawn-existing-running';
        running.textContent = 'running';
        r.appendChild(running);
      } else {
        const btn = document.createElement('button');
        btn.className = 'worktree-spawn-existing-resume';
        btn.textContent = 'resume';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (options?.onResume) options.onResume(row.name);
          closeWorktreeSpawn();
        });
        r.appendChild(btn);

        // Delete: only offered when no session is running in the
        // worktree — pulling the directory out from under a live agent
        // is never what the user wants. Transport is the caller's job
        // (it re-drives `setExisting` after the server responds); the
        // row is marked busy after confirmation so a slow round-trip
        // can't double-fire.
        if (options?.onDelete) {
          const delBtn = document.createElement('button');
          delBtn.className = 'worktree-spawn-existing-delete';
          delBtn.textContent = '×';
          delBtn.title = `delete worktree "${row.name}"`;
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const ok = window.confirm(
              `Delete worktree "${row.name}"? This removes its working directory.`,
            );
            if (!ok) return;
            delBtn.disabled = true;
            delBtn.textContent = '…';
            options.onDelete!(row.name);
          });
          r.appendChild(delBtn);
        }
      }
      wrap.appendChild(r);
    }
    existingSlot.appendChild(wrap);
    divider.style.display = '';
  };

  // Initial render: either explicit `existing`, or a loading placeholder
  // if the caller asked for it, or empty.
  if (options?.existing && options.existing.length > 0) {
    renderExisting(options.existing);
  } else if (options?.loading) {
    const loading = document.createElement('div');
    loading.className = 'worktree-spawn-loading';
    loading.textContent = 'loading existing worktrees…';
    existingSlot.appendChild(loading);
  }

  const handle: SpawnHandle = {
    setError: (msg) => { errorEl.textContent = msg; },
    setBusy: (busy) => {
      spawnBtn.disabled = busy;
      spawnBtn.textContent = busy ? '…' : 'spawn';
      nameInput.disabled = busy;
    },
    setExisting: (rows) => {
      // Guard against the popover already having been dismissed while a
      // slow list_worktrees response was in flight.
      if (!popover.parentElement) return;
      renderExisting(rows);
      // The popover just grew — recompute placement so it doesn't
      // overflow the viewport now that it's taller.
      repositionPopover();
    },
    close: closeWorktreeSpawn,
  };

  const submit = () => {
    const name = nameInput.value.trim();
    if (!name) { handle.setError('name required'); return; }
    handle.setError('');
    onConfirm({ name }, handle);
  };

  spawnBtn.addEventListener('click', (e) => { e.stopPropagation(); submit(); });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeWorktreeSpawn(); }
  });

  // Mount as a fixed-position popover anchored near the agent frame.
  // Mount onto document.body so a transformed / overflow:hidden
  // ancestor doesn't clip it.
  document.body.appendChild(popover);
  popover.style.position = 'fixed';
  popover.style.zIndex = '1000';
  // Position smartly based on viewport space: prefer to the right of
  // and aligned with the top of the anchor button. If that would
  // overflow the viewport, flip horizontally / vertically so the
  // popover stays fully on screen. This matters when agent tiles fill
  // the screen and the spawn button sits near the bottom-right corner
  // — without a flip, the popover would render below the visible
  // viewport. Re-runs after `setExisting` grows the content.
  const repositionPopover = (): void => {
    const ar = anchor.getBoundingClientRect();
    const pr = popover.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    // Horizontal: right of anchor by default; flip to left of anchor
    // if popover would overflow the right edge.
    let left = ar.right + margin;
    if (left + pr.width > vw - margin) {
      left = ar.left - margin - pr.width;
      if (left < margin) left = margin;
    }
    // Vertical: align with anchor top by default; flip upward (popover
    // bottom aligned with anchor bottom) if it would overflow.
    let top = ar.top + margin;
    if (top + pr.height > vh - margin) {
      top = ar.bottom - pr.height - margin;
      if (top < margin) top = margin;
    }
    popover.style.top = `${Math.round(top)}px`;
    popover.style.left = `${Math.round(left)}px`;
  };
  // Hide while we measure to avoid a one-frame flash at (0,0).
  popover.style.visibility = 'hidden';
  popover.style.top = '0px';
  popover.style.left = '0px';
  repositionPopover();
  popover.style.visibility = '';

  activeEl = popover;
  activeAnchor = anchor;
  activeErrorEl = errorEl;
  activeNameInput = nameInput;
  activeSpawnBtn = spawnBtn;

  nameInput.focus();

  // Click-outside to dismiss. Defer attachment so the click that opened
  // the popover doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('mousedown', onOutsideClick, true);
  }, 0);

  return handle;
}

export function closeWorktreeSpawn(): void {
  if (activeEl) {
    activeEl.remove();
    activeEl = null;
    activeAnchor = null;
    activeErrorEl = null;
    activeNameInput = null;
    activeSpawnBtn = null;
    document.removeEventListener('mousedown', onOutsideClick, true);
  }
}

function onOutsideClick(e: MouseEvent): void {
  if (!activeEl) return;
  const target = e.target as Node;
  if (activeEl.contains(target) || (activeAnchor && activeAnchor.contains(target))) return;
  closeWorktreeSpawn();
}

// Unused-bindings warning suppressor — `activeErrorEl`, `activeNameInput`,
// `activeSpawnBtn` are held for future programmatic control.
export const __keepAlive = () => [activeErrorEl, activeNameInput, activeSpawnBtn];
