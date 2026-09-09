// Preflight: pings /api/preflight on boot and on a poll interval,
// caches the latest report, and exposes a modal for displaying it.
// The pill UI was removed when this got folded into the Settings
// modal — see settings.ts's buildGeneralTab for the row that
// surfaces the status. Warn-only by design — failed checks surface
// here but don't disable any buttons.

type Severity = 'ok' | 'warn' | 'error';

type FixKind = 'shell' | 'link' | 'manual';

interface Fix {
  kind: FixKind;
  command?: string;
  url?: string;
  text: string;
}

interface Check {
  id: string;
  label: string;
  category: 'required' | 'dev' | 'optional';
  status: Severity;
  detail?: string;
  fix?: Fix;
}

interface Diagnostics {
  daemonPid: number;
  daemonUptime: string;
  buildRepoPath: string;
  bitwiseVersion: string;
  goVersion: string;
  os: string;
  arch: string;
  spritesDir: string;
  homeDir: string;
  versions: Record<string, string>;
  vcsRevision?: string;
  vcsModified?: boolean;
}

interface PreflightResponse {
  status: Severity;
  okCount: number;
  warnCount: number;
  errorCount: number;
  checks: Check[];
  diagnostics: Diagnostics;
  generatedAt: string;
}

const MODAL_ID = 'preflight-modal-overlay';
// Absolute URL so the pill works when the page is served from Vite's
// dev server (:5173) — matches the same hardcode used in
// connection.ts (ws://localhost:3333/ws) and profiles.ts.
const API_BASE = 'http://localhost:3333';
let lastReport: PreflightResponse | null = null;
let refreshing = false;

// Re-poll cadence. 30s is long enough not to spam (each call shells
// out to ~5 binaries) but short enough that a freshly-installed tmux
// flips the pill to green within reading time.
const POLL_INTERVAL_MS = 30_000;

// Listeners fire whenever the cached report changes, so the settings
// row can re-render its status text without polling itself.
type StatusListener = (r: PreflightResponse | null, errorMsg?: string) => void;
const listeners = new Set<StatusListener>();
let lastErrorMsg: string | undefined;

export function initPreflight(): void {
  void refresh();
  setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
}

// Returns the most recent successful preflight report, or null if none
// has been fetched yet (e.g. during boot or after an unreachable daemon).
// Settings.ts uses this to render the diagnostics row when the modal is
// opened cold.
export function getPreflightReport(): PreflightResponse | null {
  return lastReport;
}

// `unreachable: <msg>` when the last fetch failed, undefined otherwise.
// Lets the settings row distinguish "diagnostics not yet loaded" (no
// report, no error) from "daemon down" (no report + error).
export function getPreflightError(): string | undefined {
  return lastErrorMsg;
}

// Subscribe to status changes. Returns an unsubscribe fn. Fires once
// immediately with the current value so subscribers can render
// without an extra getPreflightReport() call.
export function onPreflightChange(fn: StatusListener): () => void {
  listeners.add(fn);
  fn(lastReport, lastErrorMsg);
  return () => { listeners.delete(fn); };
}

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const res = await fetch(`${API_BASE}/api/preflight`);
    if (!res.ok) {
      setError(`HTTP ${res.status}`);
      return;
    }
    lastReport = await res.json() as PreflightResponse;
    lastErrorMsg = undefined;
    // If the modal is open, keep it live.
    if (document.getElementById(MODAL_ID)) {
      renderModalBody(lastReport);
    }
    for (const l of listeners) l(lastReport, undefined);
  } catch (err) {
    setError(String((err as Error)?.message ?? err));
  } finally {
    refreshing = false;
  }
}

function setError(msg: string): void {
  lastErrorMsg = msg;
  for (const l of listeners) l(lastReport, msg);
}

// On-demand refresh trigger for the "refresh" button in the modal /
// settings row. Same as the polling-driven refresh.
export function refreshPreflight(): Promise<void> {
  return refresh();
}

export function openPreflightModal(): void {
  if (document.getElementById(MODAL_ID)) return;
  const overlay = document.createElement('div');
  overlay.id = MODAL_ID;
  overlay.className = 'preflight-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  const modal = document.createElement('div');
  modal.className = 'preflight-modal';
  modal.innerHTML = `
    <div class="preflight-header">
      <span class="preflight-title">DIAGNOSTICS</span>
      <span class="preflight-refresh" data-action="refresh">refresh ↻</span>
      <span class="preflight-close" data-action="close">×</span>
    </div>
    <div class="preflight-body"></div>
  `;
  overlay.appendChild(modal);

  modal.querySelector('[data-action="refresh"]')?.addEventListener('click', () => { void refresh(); });
  modal.querySelector('[data-action="close"]')?.addEventListener('click', closeModal);

  document.body.appendChild(overlay);
  document.addEventListener('keydown', escListener);

  if (lastReport) {
    renderModalBody(lastReport);
  } else {
    void refresh();
  }
}

function escListener(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeModal();
}

function closeModal(): void {
  document.getElementById(MODAL_ID)?.remove();
  document.removeEventListener('keydown', escListener);
}

function renderModalBody(r: PreflightResponse): void {
  const body = document.querySelector(`#${MODAL_ID} .preflight-body`) as HTMLElement | null;
  if (!body) return;

  const groups: Array<{ key: 'required' | 'dev' | 'optional'; label: string }> = [
    { key: 'required', label: 'REQUIRED' },
    { key: 'dev',      label: 'DEV / IN-APP REBUILD' },
    { key: 'optional', label: 'OPTIONAL' },
  ];

  const parts: string[] = [];
  for (const g of groups) {
    const items = r.checks.filter((c) => c.category === g.key);
    if (items.length === 0) continue;
    parts.push(`<div class="preflight-section">${g.label}</div>`);
    for (const c of items) parts.push(renderCheck(c));
  }

  parts.push(`<div class="preflight-section">SYSTEM</div>`);
  parts.push(renderDiagnostics(r.diagnostics, r.generatedAt));

  body.innerHTML = parts.join('');

  // Wire copy-to-clipboard for shell fixes.
  body.querySelectorAll<HTMLElement>('[data-copy]').forEach((el) => {
    el.addEventListener('click', () => {
      const cmd = el.dataset.copy ?? '';
      void navigator.clipboard.writeText(cmd).then(() => {
        const prev = el.textContent;
        el.textContent = 'copied!';
        setTimeout(() => { el.textContent = prev; }, 1200);
      });
    });
  });
  // Wire open-url buttons through the daemon — opens in default browser
  // and works inside the WebKit-wrapped .app where window.open is no-op.
  body.querySelectorAll<HTMLElement>('[data-open-url]').forEach((el) => {
    el.addEventListener('click', () => {
      const url = el.dataset.openUrl ?? '';
      void fetch(`${API_BASE}/api/open-url`, { method: 'POST', body: JSON.stringify({ url }) })
        .catch(() => { try { window.open(url, '_blank'); } catch {} });
    });
  });
}

function renderCheck(c: Check): string {
  const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';
  const fixHtml = c.fix ? renderFix(c.fix) : '';
  return `
    <div class="preflight-check" data-status="${c.status}">
      <div class="preflight-check-row">
        <span class="preflight-icon">${icon}</span>
        <span class="preflight-label">${escapeHtml(c.label)}</span>
        <span class="preflight-detail">${escapeHtml(c.detail ?? '')}</span>
      </div>
      ${fixHtml}
    </div>
  `;
}

function renderFix(f: Fix): string {
  let action = '';
  if (f.kind === 'shell' && f.command) {
    action = `<code class="preflight-fix-cmd" data-copy="${escapeAttr(f.command)}" title="click to copy">${escapeHtml(f.command)}</code>`;
  } else if (f.kind === 'link' && f.url) {
    action = `<button class="preflight-fix-link" data-open-url="${escapeAttr(f.url)}">open ${escapeHtml(prettyHost(f.url))} →</button>`;
  }
  return `
    <div class="preflight-fix">
      <span class="preflight-fix-text">${escapeHtml(f.text)}</span>
      ${action}
    </div>
  `;
}

function renderDiagnostics(d: Diagnostics, generatedAt: string): string {
  const rows: Array<[string, string]> = [
    ['bitwise version', d.bitwiseVersion || '(unknown)'],
    ['daemon pid',     String(d.daemonPid)],
    ['daemon uptime',  d.daemonUptime],
    ['build repo',     d.buildRepoPath || '(not embedded)'],
    ['vcs revision',   d.vcsRevision ? `${d.vcsRevision.slice(0, 12)}${d.vcsModified ? ' (modified)' : ''}` : '(unknown)'],
    ['platform',       `${d.os}/${d.arch} · go ${d.goVersion}`],
    ['sprites dir',    d.spritesDir || '(unset)'],
    ['home',           d.homeDir],
    ['generated at',   new Date(generatedAt).toLocaleString()],
  ];
  for (const [name, ver] of Object.entries(d.versions)) {
    rows.push([`${name} version`, ver]);
  }
  return rows.map(([k, v]) =>
    `<div class="preflight-diag-row"><span class="preflight-diag-key">${escapeHtml(k)}</span><span class="preflight-diag-val">${escapeHtml(v)}</span></div>`
  ).join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function prettyHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
