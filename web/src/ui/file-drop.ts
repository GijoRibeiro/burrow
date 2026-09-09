// Drag-and-drop file/folder paths into a chat input.
//
// Browsers don't expose absolute filesystem paths from `dataTransfer.files`
// for security reasons. The reliable path source is the `text/uri-list`
// flavor of the drop, which Finder fills with `file://` URIs when dragging
// files or folders out. WKWebView preserves this; standard Safari often
// strips it. We support both routes and degrade to the file name if all
// else fails (better than nothing).
//
// Multi-lane targeting: at drop time we walk from the cursor's element
// up to the nearest <textarea> (could be #chat-input for the boss lane
// or any agent lane's .lane-input). The path lands wherever the user
// actually dropped, so picking the destination is "drop on it." A
// fallback to the original input keeps the boss path working when the
// drop lands somewhere off-chat.

let initialized = false;
let overlay: HTMLElement | null = null;
let dragDepth = 0; // dragenter/dragleave fire on every child; counter avoids flicker.

function buildOverlay(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'file-drop-overlay';
  el.innerHTML = `
    <div class="file-drop-inner">
      <div class="file-drop-title">drop folder or file</div>
      <div class="file-drop-sub">path will be inserted at the cursor</div>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}

function showOverlay(): void {
  if (!overlay) overlay = buildOverlay();
  overlay.classList.add('active');
}

function hideOverlay(): void {
  overlay?.classList.remove('active');
  dragDepth = 0;
}

// Pull absolute file-system paths out of a DataTransfer. Order of
// preference matches reliability: text/uri-list (Finder, WKWebView) first,
// then File.path (Electron-only — included for forward-compat), then the
// plain file name (always available, useful as a hint even without path).
function extractPaths(dt: DataTransfer): string[] {
  const paths: string[] = [];

  const uriList = dt.getData('text/uri-list');
  if (uriList) {
    for (const raw of uriList.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue; // skip comment lines per RFC 2483
      if (line.startsWith('file://')) {
        try {
          // file:///Users/x/Code becomes /Users/x/Code; decodeURI handles
          // percent-encoded spaces and unicode in the path.
          paths.push(decodeURI(line.replace(/^file:\/\//, '')));
        } catch {
          paths.push(line);
        }
      }
    }
  }

  if (paths.length === 0 && dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i++) {
      const f = dt.files[i] as File & { path?: string };
      paths.push(f.path || f.name);
    }
  }

  return paths;
}

// Wrap a path in single quotes if it contains characters that would
// break common shell tools or markdown rendering. Bare path otherwise.
function quoteIfNeeded(p: string): string {
  if (/[\s'"`$()&|;<>]/.test(p)) return `'${p.replace(/'/g, "'\\''")}'`;
  return p;
}

function insertIntoTextarea(input: HTMLTextAreaElement, text: string): void {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  // Pad with a space so the inserted path doesn't fuse onto neighboring
  // text. Trim a leading double-space if `before` already ends in one.
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
  const insertion = lead + text + trail;
  input.value = before + insertion + after;
  const cursor = (before + insertion).length;
  input.setSelectionRange(cursor, cursor);
  input.focus();
  // Auto-resize textareas usually listen to 'input' events.
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// Look for a <textarea> at or above `el`. Picks up the boss
// #chat-input or any agent lane's .lane-input depending on where the
// user actually dropped. Returns null when the cursor is over neither.
function nearestTextarea(el: EventTarget | null): HTMLTextAreaElement | null {
  let cur = el as HTMLElement | null;
  while (cur) {
    if (cur instanceof HTMLTextAreaElement) return cur;
    // Lane-aware: a drop anywhere inside a `.lane` element targets
    // that lane's input even if the user didn't land on the textarea
    // itself (the lane's history area is much larger than its input).
    if (cur.classList?.contains?.('lane')) {
      const ta = cur.querySelector<HTMLTextAreaElement>('textarea');
      if (ta) return ta;
    }
    cur = cur.parentElement;
  }
  return null;
}

export function initFileDrop(fallback: HTMLTextAreaElement): void {
  if (initialized) return;
  initialized = true;

  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer) return;
    if (!e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('text/uri-list')) return;
    dragDepth += 1;
    if (dragDepth === 1) showOverlay();
  });

  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    if (!e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('text/uri-list')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    // Highlight the lane the cursor is currently over so the user
    // sees which input will receive the path. Idempotent: previous
    // highlights are cleared before the new one lands.
    document.querySelectorAll('.file-drop-target').forEach((el) => el.classList.remove('file-drop-target'));
    const target = nearestTextarea(e.target);
    if (target) {
      const lane = target.closest('.lane') ?? target.closest('#chat-bar') ?? target;
      lane?.classList.add('file-drop-target');
    }
  });

  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      hideOverlay();
      document.querySelectorAll('.file-drop-target').forEach((el) => el.classList.remove('file-drop-target'));
    }
  });

  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer) return;
    const types = e.dataTransfer.types;
    document.querySelectorAll('.file-drop-target').forEach((el) => el.classList.remove('file-drop-target'));
    if (!types.includes('Files') && !types.includes('text/uri-list')) {
      hideOverlay();
      return;
    }
    e.preventDefault();
    hideOverlay();
    const paths = extractPaths(e.dataTransfer);
    if (paths.length === 0) return;
    const joined = paths.map(quoteIfNeeded).join(' ');
    // Pick the textarea closest to the drop point; fall back to the
    // boss input if the drop landed off-chat.
    const target = nearestTextarea(e.target) ?? fallback;
    insertIntoTextarea(target, joined);
    target.focus();
  });
}
