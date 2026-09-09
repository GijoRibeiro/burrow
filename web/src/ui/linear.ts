import { addLinearLane, removeLinearLane, isLinearLaneOpen, shouldRestoreLinearLane, isSectionLaneOpen } from './lanes';

// Route legacy `isPaired` / `onPairStateChanged` calls through the new
// modular layout system. The layout API is attached to `window.__layout`
// by main.ts after `initLayout()`. These shims keep this file's
// rendering logic unchanged: `isPaired('linear-panel')` is now "is the
// linear panel sharing a row with another section?".
function layoutAPI(): {
  isHorizontallyConstrained: (s: string) => boolean;
  onChanged: (fn: () => void) => () => void;
} | null {
  return ((window as unknown as { __layout?: any }).__layout) ?? null;
}
function isPaired(section: string): boolean {
  return !!layoutAPI()?.isHorizontallyConstrained(section);
}
function onPairStateChanged(_section: string, fn: () => void): () => void {
  const api = layoutAPI();
  if (!api) return () => {};
  return api.onChanged(fn);
}
// No-op: the new layout system handles re-renders on its own.
function reapplySavedOrder(): void {}

// Linear assigned-tickets panel. Mirrors the now-reverted worktrees panel
// shape: a section that renders as a kanban board grouped by status, can
// be docked to the right of the agent grid, shows a pixel-art empty state,
// and polls the backend on an interval.
//
// Data flow: this module fetches /api/linear/issues itself (not via
// WebSocket) — it's read-only, infrequent, and keeping it off the WS hot
// path avoids bloating the state broadcast.

interface Issue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  stateId: string;
  statusName: string;
  statusType: string; // backlog | unstarted | started | completed | canceled | triage
  statusColor: string;
  teamId: string;
  teamKey: string;
}

interface WorkflowState {
  id: string;
  name: string;
  type: string;
  color: string;
  position: number;
}

type TeamStates = Record<string, WorkflowState[]>;

const POLL_MS = 30_000;

// How many cards to show per column when docked. The user tunes this
// via the hover strip (↓ / ↑); cap applies uniformly to every column
// (todo, in progress, done) so a tightly-capped board stays compact
// across the board. Stored in localStorage; the older Done-only keys
// are read as fallbacks so a previously-set value isn't lost.
const CARD_CAP_KEY = 'linearColumnCardCap';
const LEGACY_CARD_CAP_KEYS = ['linearDoneCardCap', 'linearDockedCardsPerColumn'];
// Default cap = 50 (effectively unlimited — Linear caps at 50 results
// per query anyway). Cards-fewer/more buttons still let the user
// compress the view manually, but the default behavior is "show
// everything assigned to me" so the column actually fills the
// available space. The previous default of 5 stranded most of the
// kanban offscreen with a "+N more" tail and made the panel look
// half-empty whenever there was more vertical room than content.
const DEFAULT_CARD_CAP = 50;
// 0 hides a column entirely (in docked mode); per-column visibility
// based on cap is handled in renderBoard.
const MIN_CARD_CAP = 0;
const MAX_CARD_CAP = 50;

// Migration flag: existing users have `linearColumnCardCap = 5`
// stored from the old DEFAULT_CARD_CAP (which silently clipped most
// columns to 5 cards). They never explicitly chose 5 — it was the
// default. Bump those users to the new default of 50 once, then
// flag the migration as done so subsequent loads respect any cap
// the user actually sets via the −/+ buttons.
const CARD_CAP_MIGRATION_KEY = 'linearColumnCardCapMigrationV2';
function loadCardCap(): number {
  let raw = localStorage.getItem(CARD_CAP_KEY);
  if (raw == null) {
    for (const k of LEGACY_CARD_CAP_KEYS) {
      raw = localStorage.getItem(k);
      if (raw != null) break;
    }
  }
  const n = raw ? parseInt(raw, 10) : NaN;
  // One-shot migration of the old default (5 → 50). Only triggers
  // if the migration flag isn't set AND the stored value is exactly
  // the old silent default. Any other stored value is preserved.
  if (localStorage.getItem(CARD_CAP_MIGRATION_KEY) !== '1') {
    localStorage.setItem(CARD_CAP_MIGRATION_KEY, '1');
    if (n === 5) {
      localStorage.setItem(CARD_CAP_KEY, String(DEFAULT_CARD_CAP));
      return DEFAULT_CARD_CAP;
    }
  }
  if (!isFinite(n) || n < MIN_CARD_CAP) return DEFAULT_CARD_CAP;
  return Math.min(MAX_CARD_CAP, Math.max(MIN_CARD_CAP, n));
}

let cardCap = loadCardCap();

// Docked board layout — vertical (default; columns stacked) vs
// horizontal (columns side-by-side, scrolls if narrow). User-tunable
// from the hover strip; persisted.
type BoardLayout = 'vertical' | 'horizontal';
const BOARD_LAYOUT_KEY = 'linearDockedBoardLayout';
function loadBoardLayout(): BoardLayout {
  const v = localStorage.getItem(BOARD_LAYOUT_KEY);
  return v === 'horizontal' ? 'horizontal' : 'vertical';
}
let boardLayout: BoardLayout = loadBoardLayout();
function setBoardLayout(next: BoardLayout): void {
  if (next === boardLayout) return;
  boardLayout = next;
  localStorage.setItem(BOARD_LAYOUT_KEY, next);
  if (panelEl) panelEl.dataset.boardLayout = boardLayout;
  expandedColumns.clear();
  if (lastIssues) renderBoard(lastIssues);
}

function setCardCap(next: number): void {
  const clamped = Math.min(MAX_CARD_CAP, Math.max(MIN_CARD_CAP, next));
  if (clamped === cardCap) return;
  cardCap = clamped;
  localStorage.setItem(CARD_CAP_KEY, String(clamped));
  // Reset expansion state so the new cap applies cleanly.
  expandedColumns.clear();
  if (lastIssues) renderBoard(lastIssues);
}

// Visual column order. Any status type not listed ends up in "other".
const COLUMNS: { id: string; label: string; types: string[] }[] = [
  { id: 'todo',        label: 'todo',        types: ['unstarted', 'backlog', 'triage'] },
  { id: 'in-progress', label: 'in progress', types: ['started'] },
  { id: 'done',        label: 'done',        types: ['completed'] },
];

// Handler wiring from main.ts so the panel can hand a ticket off to an
// agent (existing or to-be-spawned) without knowing about the selection /
// spawn machinery.
export interface LinearContext {
  getSelectedAgent: () => { cwd: string | null; sessionId: string | null; pid: number | null; name?: string; color?: string } | null;
  // List all currently-running agents with their assigned palette color.
  // Used by the "attach to agent" chip row in the card menu so the user
  // can mark ownership without sending a message.
  getAllAgents: () => { cwd: string; name: string; color: string }[];
  sendChatToSelected: (text: string) => boolean; // returns false if no agent selected
  // Kick off a new-agent spawn (opens bitwise's native folder picker via
  // the server) and queue `text` to be sent to that agent as its first
  // message once it appears in the registry.
  spawnAgentWithMessage: (text: string) => void;
  // Send a message to the Boss agent (the orchestrator). Used by the
  // "+ new ticket" button — Boss gathers details from the user in chat
  // and calls Linear's API itself.
  sendToBoss: (text: string) => boolean;
}

let enabled = false;
let initialized = false;
// When true, the panel lives inside a chat lane (reparented out of
// #app / #agent-dock-row). The dock/undock state is preserved
// underneath so detaching restores the prior arrangement.
let laneMode = false;

let panelEl: HTMLElement | null = null;
let boardEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let errorEl: HTMLElement | null = null;
let pollTimer: number | null = null;
let lastIssues: Issue[] | null = null;
let teamStates: TeamStates = {};
// Tracks columns the user has expanded past the docked cap so re-renders
// (e.g. on poll) don't silently re-collapse them.
const expandedColumns = new Set<string>();

let ctx: LinearContext | null = null;

// Last-chosen branch mode, persisted so the user's preference sticks
// between menu opens. Defaults to "ask" — safest choice for a new user.
const BRANCH_MODE_KEY = 'linearBranchMode';
function loadBranchMode(): BranchMode {
  const v = localStorage.getItem(BRANCH_MODE_KEY);
  return v === 'new' || v === 'none' || v === 'ask' ? v : 'ask';
}
function saveBranchMode(m: BranchMode): void {
  localStorage.setItem(BRANCH_MODE_KEY, m);
}

// --- Pixel-art empty-state sprite ---------------------------------------
// 16×16 cream-tree against dark bg. `#` = foreground (light), `.` = empty.
// Rescued from yesterday's worktrees feature — same vibe asked for.
const TREE_SPRITE = [
  '................',
  '.......##.......',
  '......####......',
  '.....######.....',
  '....########....',
  '...##########...',
  '..############..',
  '.##############.',
  '....########....',
  '.....######.....',
  '......####......',
  '......####......',
  '......####......',
  '......####......',
  '.....######.....',
  '....########....',
];

// Tiny click feedback for hover-strip buttons: flash the button to full
// brightness for a beat so the user sees the action was registered even
// before Boss's reply streams in.
function flashHoverBtn(btn: HTMLElement): void {
  btn.classList.add('linear-hover-btn-fired');
  setTimeout(() => btn.classList.remove('linear-hover-btn-fired'), 700);
}

function formatNewTicketPrompt(): string {
  return [
    `I want to create a new Linear ticket. Please help by asking me a couple of short questions to gather:`,
    ``,
    `- a plain, non-technical title (no jargon, no code-y words)`,
    `- a one-sentence description written past-tense, in the tone of a teammate at standup`,
    ``,
    `Do not attach any PR or branch — keep it just title + description.`,
    ``,
    `Once I've answered, create the ticket in Linear via their GraphQL API using the \`issueCreate\` mutation. The team key is \`CLO\` (resolve to a teamId via the \`teams\` query if you don't already have it).`,
    ``,
    `API key: \`jq -r .linearApiKey ~/.cloovies/settings.json\``,
    ``,
    `After the ticket is created, confirm back to me with the new identifier (e.g. CLO-###) and URL.`,
  ].join('\n');
}

function drawTree(canvas: HTMLCanvasElement): void {
  const size = TREE_SPRITE.length;
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d')!;
  c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, size, size);
  c.fillStyle = '#eae5ce';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < TREE_SPRITE[y].length; x++) {
      if (TREE_SPRITE[y][x] === '#') c.fillRect(x, y, 1, 1);
    }
  }
}

// --- Panel construction -------------------------------------------------

function createPanel(): HTMLElement {
  const section = document.createElement('section');
  section.id = 'linear-panel';
  section.dataset.paired = 'false';
  section.dataset.layoutSection = 'linear-panel';

  // Hover-revealed action strip in the section's top-right. Order
  // (left → right): layout-toggle, cards-fewer, cards-more, new, reload.
  // Drag-to-reposition is handled by the layout chrome's drag handle
  // pinned at the wrapper's far right; the old "▣ host as lane" and
  // "⇄ dock" toggles were removed because the drag handle subsumes both.
  // Board-layout toggle (only meaningful when sharing a row). Switches
  // between vertical column-stack (default) and horizontal kanban.
  const layoutBtn = document.createElement('span');
  layoutBtn.className = 'linear-hover-btn linear-layout-btn';
  layoutBtn.title = 'toggle vertical / horizontal columns';
  layoutBtn.textContent = boardLayout === 'horizontal' ? '▥' : '▤';
  layoutBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next: BoardLayout = boardLayout === 'horizontal' ? 'vertical' : 'horizontal';
    setBoardLayout(next);
    layoutBtn.textContent = next === 'horizontal' ? '▥' : '▤';
    flashHoverBtn(layoutBtn);
  });
  section.appendChild(layoutBtn);

  // Cards-per-column tuners (docked only). ↓ shows fewer cards per
  // column, ↑ shows more. Cap applies uniformly to every column.
  // Hidden via CSS when undocked since the cap doesn't apply there.
  const fewerBtn = document.createElement('span');
  fewerBtn.className = 'linear-hover-btn linear-cards-fewer-btn';
  fewerBtn.title = 'show fewer cards per column';
  fewerBtn.textContent = '↓';
  fewerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setCardCap(cardCap - 1);
    flashHoverBtn(fewerBtn);
  });
  section.appendChild(fewerBtn);

  const moreBtn = document.createElement('span');
  moreBtn.className = 'linear-hover-btn linear-cards-more-btn';
  moreBtn.title = 'show more cards per column';
  moreBtn.textContent = '↑';
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setCardCap(cardCap + 1);
    flashHoverBtn(moreBtn);
  });
  section.appendChild(moreBtn);

  // "+" = new ticket. Fires a boss-directed message; Boss gathers the
  // title + description from the user in chat and then creates the
  // ticket via the Linear API itself.
  const newBtn = document.createElement('span');
  newBtn.className = 'linear-hover-btn linear-new-btn';
  newBtn.title = 'new ticket (asks Boss)';
  newBtn.textContent = '+';
  newBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ctx) return;
    const msg = formatNewTicketPrompt();
    const ok = ctx.sendToBoss(msg);
    if (ok) flashHoverBtn(newBtn);
  });
  section.appendChild(newBtn);

  const reloadBtn = document.createElement('span');
  reloadBtn.className = 'linear-hover-btn linear-reload-btn';
  reloadBtn.title = 'refresh';
  reloadBtn.textContent = '↻';
  reloadBtn.addEventListener('click', (e) => { e.stopPropagation(); void poll(true); });
  section.appendChild(reloadBtn);

  // (Removed: linear-lane-btn ▣ and linear-dock-btn ⇄ — the layout
  // chrome's drag handle replaces both. Drag the panel anywhere in
  // the split-tree to dock; drag onto a tab strip / center to attach
  // as a tab. No need for a second affordance.)

  const body = document.createElement('div');
  body.className = 'linear-body';

  const board = document.createElement('div');
  board.className = 'linear-board';
  boardEl = board;

  const empty = document.createElement('div');
  empty.className = 'linear-empty';
  const canvas = document.createElement('canvas');
  canvas.className = 'linear-empty-sprite';
  drawTree(canvas);
  const emptyText = document.createElement('div');
  emptyText.className = 'linear-empty-text';
  emptyText.textContent = 'nothing assigned — enjoy the quiet';
  empty.appendChild(canvas);
  empty.appendChild(emptyText);
  emptyEl = empty;

  const error = document.createElement('div');
  error.className = 'linear-error';
  errorEl = error;

  body.appendChild(board);
  body.appendChild(empty);
  body.appendChild(error);

  section.appendChild(body);
  return section;
}

// --- Resize drag -------------------------------------------------------

function columnFor(statusType: string): string {
  for (const c of COLUMNS) if (c.types.includes(statusType)) return c.id;
  return 'other';
}

function priorityLabel(p: number): string {
  // Linear scheme: 1 urgent, 2 high, 3 medium, 4 low, 0 none.
  return p === 1 ? 'urgent' : p === 2 ? 'high' : p === 3 ? 'med' : p === 4 ? 'low' : '';
}

// Pick a concrete state ID for a move-to-column target. Prefers a state of
// the requested type on the issue's team; among ties chooses the one with
// the lowest `position` (= leftmost on Linear's own board).
function resolveTargetStateID(issue: Issue, columnID: string): string | null {
  const column = COLUMNS.find((c) => c.id === columnID);
  if (!column) return null;
  const states = teamStates[issue.teamId] || [];
  let best: WorkflowState | null = null;
  for (const s of states) {
    if (!column.types.includes(s.type)) continue;
    if (!best || s.position < best.position) best = s;
  }
  return best ? best.id : null;
}

function renderBoard(issues: Issue[]): void {
  if (!boardEl || !emptyEl || !errorEl) return;
  errorEl.textContent = '';
  errorEl.style.display = 'none';

  if (issues.length === 0) {
    boardEl.style.display = 'none';
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';
  boardEl.style.display = '';
  boardEl.innerHTML = '';

  // Group.
  const groups: Record<string, Issue[]> = {};
  for (const c of COLUMNS) groups[c.id] = [];
  groups['other'] = [];
  for (const iss of issues) groups[columnFor(iss.statusType)].push(iss);

  for (const c of COLUMNS) {
    const items = groups[c.id];
    if (items.length === 0 && c.id === 'done') continue; // hide empty "done" to reduce noise
    // Cap === 0 (paired only) means "hide this column entirely" — a
    // clean way to strip a column from the panel without disabling
    // polling. Applies to every column uniformly.
    if (isPaired('linear-panel') && cardCap === 0) continue;
    boardEl.appendChild(buildColumn(c.id, c.label, items));
  }
}

function buildColumn(columnID: string, label: string, items: Issue[]): HTMLElement {
  const col = document.createElement('div');
  col.className = 'linear-column';
  col.dataset.column = columnID;

  const colHead = document.createElement('div');
  colHead.className = 'linear-column-head';
  const colLabel = document.createElement('span');
  colLabel.className = 'linear-column-label';
  colLabel.textContent = label;
  const colCount = document.createElement('span');
  colCount.className = 'linear-column-count';
  colCount.textContent = String(items.length);
  colHead.appendChild(colLabel);
  colHead.appendChild(colCount);
  col.appendChild(colHead);

  // --- Drop target wiring -------------------------------------------------
  col.addEventListener('dragover', (e) => {
    if (draggingIssueID) { e.preventDefault(); col.classList.add('drop-target'); }
  });
  col.addEventListener('dragleave', () => { col.classList.remove('drop-target'); });
  col.addEventListener('drop', (e) => {
    e.preventDefault();
    col.classList.remove('drop-target');
    if (!draggingIssueID) return;
    const id = draggingIssueID;
    draggingIssueID = null;
    void moveIssueToColumn(id, columnID);
  });

  // --- Render cards. Cap applies uniformly to every column when
  // paired; user can hit "show more" per column to expand past the
  // cap, and the per-column expansion state is tracked in
  // expandedColumns so re-renders don't silently re-collapse it.
  const expandable = isPaired('linear-panel') && items.length > cardCap;
  const expanded = expandable && expandedColumns.has(columnID);
  const visible = expandable && !expanded ? items.slice(0, cardCap) : items;
  for (const iss of visible) col.appendChild(buildCard(iss));

  if (expandable) {
    const toggle = document.createElement('div');
    toggle.className = 'linear-column-more';
    toggle.textContent = expanded
      ? 'show less'
      : `+${items.length - cardCap} more`;
    toggle.addEventListener('click', () => {
      if (expandedColumns.has(columnID)) expandedColumns.delete(columnID);
      else expandedColumns.add(columnID);
      if (lastIssues) renderBoard(lastIssues);
    });
    col.appendChild(toggle);
  }
  return col;
}

let draggingIssueID: string | null = null;

// --- Visual feedback state ---------------------------------------------
// Three overlapping signals, each handled differently:
//   sendingSet:       flash right after the user taps "send to agent"
//   workingMap:       slow shimmer while an agent is working on it
//   recentlyChanged:  flash when the poll cycle picks up a status change
//
// workingMap is the only one persisted — so the shimmer survives reloads
// within its 30-minute window. The other two are transient on purpose
// (they're about *this* moment's action, not state).
const WORKING_KEY = 'linearWorking';
const WORKING_WINDOW_MS = 30 * 60 * 1000;
const SENDING_FLASH_MS = 2200;
const CHANGED_FLASH_MS = 2500;

const sendingSet = new Set<string>();
const workingMap = new Map<string, number>(); // id → timestamp when marked
const recentlyChanged = new Map<string, number>();
// Tracks which agent cwd each "working" issue was handed to. Keyed by
// cwd (not sessionId) because cwd is stable across reloads — sessionIds
// rotate when claude restarts, which used to orphan entries and leave
// the highlight stuck forever. Persisted alongside workingMap so the
// link survives a bitwise reload too.
const workingByCwd = new Map<string, Set<string>>(); // cwd → issue ids
// Per-issue agent color — the persistent "this ticket is owned by that
// agent" marker. Tints the card title in the agent's avatar color so
// the user can see at a glance who is responsible. Unlike the shimmer
// (which ends with the agent's turn), this stays put until a different
// agent is sent the ticket.
const assignedColor = new Map<string, string>(); // issue id → hex color
const WORKING_BY_CWD_KEY = 'linearWorkingByCwd';
const ASSIGNED_COLOR_KEY = 'linearAssignedColor';
// Old key kept for one-time migration so users don't lose existing tints.
const LEGACY_WORKING_COLOR_KEY = 'linearWorkingColor';

function loadWorking(): void {
  try {
    const raw = localStorage.getItem(WORKING_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, number>;
      const now = Date.now();
      for (const [id, ts] of Object.entries(obj)) {
        if (now - ts <= WORKING_WINDOW_MS) workingMap.set(id, ts);
      }
    }
  } catch { /* ignore */ }
  try {
    const rawCwd = localStorage.getItem(WORKING_BY_CWD_KEY);
    if (rawCwd) {
      const obj = JSON.parse(rawCwd) as Record<string, string[]>;
      for (const [cwd, ids] of Object.entries(obj)) {
        const filtered = ids.filter((id) => workingMap.has(id));
        if (filtered.length > 0) workingByCwd.set(cwd, new Set(filtered));
      }
    }
  } catch { /* ignore */ }
  // Assigned-color is the persistent "ticket owner" marker — load it
  // independently of workingMap so the tint survives even after the
  // shimmer/working state has expired.
  try {
    const rawColor = localStorage.getItem(ASSIGNED_COLOR_KEY) ?? localStorage.getItem(LEGACY_WORKING_COLOR_KEY);
    if (rawColor) {
      const obj = JSON.parse(rawColor) as Record<string, string>;
      for (const [id, hex] of Object.entries(obj)) {
        assignedColor.set(id, hex);
      }
    }
  } catch { /* ignore */ }
}

function saveWorking(): void {
  const obj: Record<string, number> = {};
  for (const [id, ts] of workingMap) obj[id] = ts;
  localStorage.setItem(WORKING_KEY, JSON.stringify(obj));

  const byCwd: Record<string, string[]> = {};
  for (const [cwd, ids] of workingByCwd) byCwd[cwd] = [...ids];
  localStorage.setItem(WORKING_BY_CWD_KEY, JSON.stringify(byCwd));

  const colors: Record<string, string> = {};
  for (const [id, hex] of assignedColor) colors[id] = hex;
  localStorage.setItem(ASSIGNED_COLOR_KEY, JSON.stringify(colors));
}

function markWorking(id: string, cwd?: string | null, color?: string | null): void {
  workingMap.set(id, Date.now());
  if (cwd) {
    if (!workingByCwd.has(cwd)) workingByCwd.set(cwd, new Set());
    workingByCwd.get(cwd)!.add(id);
  }
  // Color is a *persistent* assignment, not part of the transient
  // working state. Sending the same ticket to a different agent later
  // overwrites it; otherwise it sticks across reloads as the
  // "responsible agent" marker.
  if (color) assignedColor.set(id, color);
  saveWorking();
}

// Manually attach (or detach) an agent color from a ticket. No message
// is sent and Linear isn't touched — this is a local UI marker so the
// user can pin "this ticket belongs to that agent" without committing
// the agent to start working.
function setAssignedColor(issueId: string, color: string | null): void {
  if (color) assignedColor.set(issueId, color);
  else assignedColor.delete(issueId);
  saveWorking();
  if (lastIssues) renderBoard(lastIssues);
}

// Clear the "working" shimmer for every issue we handed to a given
// agent cwd. Triggered externally from main.ts on agent_finished. Cwd
// is stable across reloads so this works even if bitwise restarted
// between the send and the finish event. The assigned-color tint is
// intentionally NOT cleared here — that's the persistent ownership
// marker the user relies on to see who's responsible for a ticket.
export function clearLinearWorkingForCwd(cwd: string): void {
  const ids = workingByCwd.get(cwd);
  if (!ids || ids.size === 0) return;
  for (const id of ids) {
    workingMap.delete(id);
  }
  workingByCwd.delete(cwd);
  saveWorking();
  if (lastIssues) renderBoard(lastIssues);
}


function isWorking(id: string): boolean {
  const ts = workingMap.get(id);
  if (!ts) return false;
  if (Date.now() - ts > WORKING_WINDOW_MS) {
    workingMap.delete(id);
    saveWorking();
    return false;
  }
  return true;
}

// Compare newly-fetched issues against the previous snapshot. Any issue
// whose status column changed gets a flash flag. Also doubles as a
// safety net for the "working" highlight: if Linear now shows the
// ticket in any column other than In Progress, the agent clearly
// finished its active work on it (or we moved it ourselves), so drop
// the shimmer and color tint.
function markChangedVsLast(next: Issue[]): void {
  if (!lastIssues) return;
  const prev = new Map(lastIssues.map((i) => [i.id, columnFor(i.statusType)]));
  for (const iss of next) {
    const prevCol = prev.get(iss.id);
    const nowCol = columnFor(iss.statusType);
    if (prevCol && prevCol !== nowCol) {
      recentlyChanged.set(iss.id, Date.now());
    }
    // Working shimmer ends when Linear shows the ticket left the
    // started/in-progress family. Assigned color stays — that's the
    // permanent ownership marker; only an explicit re-send overwrites it.
    if (workingMap.has(iss.id) && iss.statusType !== 'started') {
      workingMap.delete(iss.id);
      for (const [cwd, ids] of workingByCwd) {
        if (ids.delete(iss.id) && ids.size === 0) workingByCwd.delete(cwd);
      }
    }
  }
  saveWorking();
}

function isRecentlyChanged(id: string): boolean {
  const ts = recentlyChanged.get(id);
  if (!ts) return false;
  if (Date.now() - ts > CHANGED_FLASH_MS) {
    recentlyChanged.delete(id);
    return false;
  }
  return true;
}

function buildCard(iss: Issue): HTMLElement {
  const card = document.createElement('div');
  card.className = 'linear-card';
  card.dataset.priority = String(iss.priority);
  card.dataset.issueId = iss.id;
  card.draggable = true;
  card.title = `${iss.identifier} — ${iss.statusName}`;
  // Layer any active feedback states. Ordering matters only visually —
  // sending is most specific (border flash), working is continuous
  // (background shimmer), changed is a brief background flash.
  if (sendingSet.has(iss.id)) card.classList.add('linear-card-sending');
  if (isWorking(iss.id)) card.classList.add('linear-card-working');
  if (isRecentlyChanged(iss.id)) card.classList.add('linear-card-changed');

  const idEl = document.createElement('span');
  idEl.className = 'linear-card-id';
  idEl.textContent = iss.identifier;

  const titleEl = document.createElement('span');
  titleEl.className = 'linear-card-title';
  titleEl.textContent = iss.title;
  // Tint the title with the responsible agent's color. This stays put
  // forever (until the ticket is re-sent to a different agent), so the
  // board doubles as a "who owns what" map at a glance.
  const agentHue = assignedColor.get(iss.id);
  if (agentHue) titleEl.style.color = agentHue;

  card.appendChild(idEl);
  card.appendChild(titleEl);

  const pri = priorityLabel(iss.priority);
  if (pri) {
    const priEl = document.createElement('span');
    priEl.className = 'linear-card-priority';
    priEl.dataset.priority = pri;
    priEl.textContent = pri;
    card.appendChild(priEl);
  }

  card.addEventListener('dragstart', (e) => {
    draggingIssueID = iss.id;
    card.classList.add('dragging');
    // Required for drag to actually fire in some browsers.
    e.dataTransfer?.setData('text/plain', iss.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    draggingIssueID = null;
    // Clean any lingering drop-target highlight in case dragleave missed.
    document.querySelectorAll('.linear-column.drop-target').forEach((el) => el.classList.remove('drop-target'));
  });

  card.addEventListener('click', (e) => {
    // Skip if the click is part of a drag's mouseup — browsers still fire
    // click after a drag completes in some cases. dataset.dragged is set in
    // dragstart just before the browser would fire.
    if (card.classList.contains('dragging')) return;
    e.stopPropagation();
    openCardMenu(card, iss);
  });

  return card;
}

// --- Card action menu ---------------------------------------------------

function openCardMenu(anchor: HTMLElement, iss: Issue): void {
  closeCardMenu();
  const menu = document.createElement('div');
  menu.className = 'linear-menu';
  menu.dataset.forIssue = iss.id;

  const rect = anchor.getBoundingClientRect();
  // Tentatively place below the card; we'll measure after appending and
  // flip above / clamp into the viewport if it would overflow. Set
  // visibility hidden during the first paint so the user doesn't see
  // the jump from the tentative position to the corrected one.
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.visibility = 'hidden';

  const addItem = (label: string, onClick: () => void, hint?: string, disabled?: boolean) => {
    const item = document.createElement('div');
    item.className = 'linear-menu-item';
    if (disabled) item.classList.add('disabled');
    const l = document.createElement('span');
    l.className = 'linear-menu-label';
    l.textContent = label;
    item.appendChild(l);
    if (hint) {
      const h = document.createElement('span');
      h.className = 'linear-menu-hint';
      h.textContent = hint;
      item.appendChild(h);
    }
    if (!disabled) {
      item.addEventListener('click', () => { onClick(); closeCardMenu(); });
    }
    menu.appendChild(item);
  };

  addItem('open in linear', () => {
    if (!iss.url) return;
    // Route through the daemon so links open in the default browser even
    // inside the native macOS wrapper (where window.open is a no-op).
    void fetch('/api/open-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: iss.url }),
    }).catch(() => {
      // Last-resort fallback for non-wrapper contexts (plain browser).
      window.open(iss.url, '_blank', 'noopener');
    });
  });

  addItem('copy id', () => {
    if (navigator.clipboard) void navigator.clipboard.writeText(iss.identifier);
  });

  // Branch chips removed — the new send-to-agent flow is just "move
  // to in progress, ask me what to do," so git strategy comes out of
  // the conversation rather than a pre-selected mode. Keep a default
  // value so the unused parameter on formatHandOffMessage typechecks.
  const branchMode: BranchMode = 'ask';

  const dividerMid = document.createElement('div');
  dividerMid.className = 'linear-menu-divider';
  menu.appendChild(dividerMid);

  // --- Spawn new agent ---------------------------------------------------
  addItem('spawn new agent', () => {
    if (!ctx) return;
    const msg = formatHandOffMessage(iss, branchMode, true);
    ctx.spawnAgentWithMessage(msg);
    markWorking(iss.id);
    if (lastIssues) renderBoard(lastIssues);
  }, 'picks folder, then sends');

  // --- Send to currently-selected agent ----------------------------------
  const sel = ctx?.getSelectedAgent();
  const canHandOff = !!(sel && sel.pid && sel.sessionId);
  const handOffHint = canHandOff
    ? (sel?.name || 'agent')
    : 'select an agent';
  addItem('send to agent', () => {
    if (!ctx || !canHandOff) return;
    void sendToAgent(iss, branchMode);
  }, handOffHint, !canHandOff);

  // --- Lighter hand-off: move to In Progress + make agent aware ---------
  // Ignores branch mode (no branching implied). Agent just acknowledges
  // the ticket and stands by for follow-up discussion.
  addItem('discuss with agent', () => {
    if (!ctx || !canHandOff) return;
    void discussWithAgent(iss);
  }, handOffHint, !canHandOff);

  // --- Attach to agent (no message, no status change) -------------------
  // Pure UI marker — paints the title in the agent's color so the board
  // doubles as a "who owns what" map. "none" detaches.
  const agents = ctx?.getAllAgents() ?? [];
  if (agents.length > 0) {
    const dividerAttach = document.createElement('div');
    dividerAttach.className = 'linear-menu-divider';
    menu.appendChild(dividerAttach);

    const attachRow = document.createElement('div');
    attachRow.className = 'linear-menu-attach';
    const attachLabel = document.createElement('span');
    attachLabel.className = 'linear-menu-attach-label';
    attachLabel.textContent = 'attach';
    attachRow.appendChild(attachLabel);

    const attachOpts = document.createElement('div');
    attachOpts.className = 'linear-menu-attach-opts';

    const currentColor = assignedColor.get(iss.id) ?? null;
    for (const a of agents) {
      const chip = document.createElement('span');
      chip.className = 'linear-menu-attach-chip';
      chip.textContent = a.name;
      chip.title = a.cwd;
      chip.style.color = a.color;
      chip.style.borderColor = a.color;
      if (currentColor && currentColor.toLowerCase() === a.color.toLowerCase()) {
        chip.classList.add('active');
        chip.style.background = a.color;
        chip.style.color = '#2e2f38';
      }
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        setAssignedColor(iss.id, a.color);
        closeCardMenu();
      });
      attachOpts.appendChild(chip);
    }

    const noneChip = document.createElement('span');
    noneChip.className = 'linear-menu-attach-chip linear-menu-attach-none';
    noneChip.textContent = 'none';
    if (!currentColor) noneChip.classList.add('active');
    noneChip.addEventListener('click', (e) => {
      e.stopPropagation();
      setAssignedColor(iss.id, null);
      closeCardMenu();
    });
    attachOpts.appendChild(noneChip);

    attachRow.appendChild(attachOpts);
    menu.appendChild(attachRow);
  }

  // --- Priority selector row ---------------------------------------------
  const divider = document.createElement('div');
  divider.className = 'linear-menu-divider';
  menu.appendChild(divider);

  const priRow = document.createElement('div');
  priRow.className = 'linear-menu-priority';
  const priLabel = document.createElement('span');
  priLabel.className = 'linear-menu-priority-label';
  priLabel.textContent = 'priority';
  priRow.appendChild(priLabel);

  const priOpts = document.createElement('div');
  priOpts.className = 'linear-menu-priority-opts';
  // Display order: urgent (1), high (2), med (3), low (4), none (0).
  // Matches Linear's own ordering.
  const OPTIONS: { value: number; label: string; short: string }[] = [
    { value: 1, label: 'urgent', short: 'urg' },
    { value: 2, label: 'high',   short: 'high' },
    { value: 3, label: 'medium', short: 'med' },
    { value: 4, label: 'low',    short: 'low' },
    { value: 0, label: 'none',   short: '—' },
  ];
  for (const opt of OPTIONS) {
    const btn = document.createElement('span');
    btn.className = 'linear-menu-priority-btn';
    btn.dataset.priority = String(opt.value);
    btn.dataset.label = opt.label;
    btn.textContent = opt.short;
    if (iss.priority === opt.value) btn.classList.add('active');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void setPriority(iss, opt.value);
      closeCardMenu();
    });
    priOpts.appendChild(btn);
  }
  priRow.appendChild(priOpts);
  menu.appendChild(priRow);

  document.body.appendChild(menu);

  // Now that the menu has rendered, measure it and adjust position so it
  // stays within the viewport. Flip above the card if there isn't room
  // below; clamp horizontally if it overflows the right edge.
  const margin = 8;
  const menuRect = menu.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;

  let top = rect.bottom + 4;
  if (top + menuRect.height > vh - margin) {
    const above = rect.top - menuRect.height - 4;
    top = above >= margin ? above : Math.max(margin, vh - menuRect.height - margin);
  }
  let left = rect.left;
  if (left + menuRect.width > vw - margin) {
    left = Math.max(margin, vw - menuRect.width - margin);
  }
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.visibility = '';

  // Dismiss on outside click / Escape. Captured at document level to beat
  // other listeners; added on a microtask so the click that opened the
  // menu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('click', closeCardMenu, { once: true });
    document.addEventListener('keydown', escCloseCardMenu);
  }, 0);
}

function escCloseCardMenu(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeCardMenu();
}

function closeCardMenu(): void {
  document.querySelector('.linear-menu')?.remove();
  document.removeEventListener('keydown', escCloseCardMenu);
}

// Send-to-agent: bitwise doesn't touch Linear itself. It hands the agent
// the ticket reference plus instructions to do the Linear work (move to
// In Progress, inspect prior activity) using the API key on disk.
// Lighter path: move to In Progress, make the agent aware, no branch,
// no kickoff. For "I want to talk about this before committing to work."
async function discussWithAgent(iss: Issue): Promise<void> {
  if (!ctx) return;
  const msg = formatDiscussMessage(iss);
  const ok = ctx.sendChatToSelected(msg);
  if (!ok) return;
  sendingSet.add(iss.id);
  const sel = ctx.getSelectedAgent();
  markWorking(iss.id, sel?.cwd ?? null, sel?.color ?? null);
  if (lastIssues) renderBoard(lastIssues);
  setTimeout(() => {
    sendingSet.delete(iss.id);
    if (lastIssues) renderBoard(lastIssues);
  }, SENDING_FLASH_MS);
}

function formatDiscussMessage(iss: Issue): string {
  const lines: string[] = [];
  lines.push(`Heads up — take a look at Linear ticket **${iss.identifier}** — ${iss.title}.`);
  lines.push('');
  lines.push(`Link: ${iss.url}`);
  lines.push(`Current status: ${iss.statusName}`);
  lines.push('');
  lines.push('Please do this:');
  lines.push('1. Move the ticket to **In Progress** via Linear\'s API.');
  lines.push('2. Read the ticket description and recent comments so you have context.');
  lines.push('3. **Do not create a branch or start coding.** Just acknowledge and stand by — I may want to discuss this before you do anything.');
  lines.push('');
  lines.push(`Issue id: \`${iss.id}\``);
  lines.push('API key: `jq -r .linearApiKey ~/.cloovies/settings.json`');
  return lines.join('\n');
}

async function sendToAgent(iss: Issue, branchMode: BranchMode): Promise<void> {
  if (!ctx) return;
  const msg = formatHandOffMessage(iss, branchMode, false);
  const ok = ctx.sendChatToSelected(msg);
  if (!ok) return;
  // Visual feedback: flash the card, then mark as "working" for the
  // longer shimmer. Re-render so the classes take effect immediately.
  sendingSet.add(iss.id);
  const sel2 = ctx.getSelectedAgent();
  markWorking(iss.id, sel2?.cwd ?? null, sel2?.color ?? null);
  if (lastIssues) renderBoard(lastIssues);
  setTimeout(() => {
    sendingSet.delete(iss.id);
    if (lastIssues) renderBoard(lastIssues);
  }, SENDING_FLASH_MS);
}

// Minimal hand-off prompt. The agent sees the ticket, moves it to
// In Progress, and asks the user what to do — no branch instructions,
// no preselected git strategy. Anything beyond that comes out of the
// follow-up conversation.
function formatHandOffMessage(iss: Issue, _branchMode: BranchMode, isSpawn: boolean): string {
  const lines: string[] = [];

  if (isSpawn) {
    lines.push(`You've been spawned for Linear ticket **${iss.identifier}** — ${iss.title}.`);
  } else {
    lines.push(`Heads up — Linear ticket **${iss.identifier}** — ${iss.title}.`);
  }
  lines.push('');
  lines.push(`Link: ${iss.url}`);
  lines.push('');
  lines.push(`Please move it to **In Progress** in Linear, then ask me what I want to do with it. Don't write any code yet.`);
  lines.push('');
  lines.push(`Issue id: \`${iss.id}\``);
  lines.push('API key: `jq -r .linearApiKey ~/.cloovies/settings.json`');
  return lines.join('\n');
}

// Kept for type compatibility while branch mode is dormant — the
// chips were removed from the menu, but BranchMode is referenced
// elsewhere (saved localStorage, function signatures) and switching
// to a smaller surface is a follow-up cleanup.
type BranchMode = 'ask' | 'new' | 'none';

// --- Priority change (optimistic) --------------------------------------

async function setPriority(iss: Issue, priority: number): Promise<void> {
  if (!lastIssues) return;
  if (iss.priority === priority) return;
  const prev = iss.priority;
  // Optimistic patch + re-render so the user sees the change instantly.
  iss.priority = priority;
  renderBoard(lastIssues);
  try {
    const r = await fetch('/api/linear/issues/priority', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: iss.id, priority }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `http ${r.status}`);
    }
  } catch (e: any) {
    iss.priority = prev;
    renderBoard(lastIssues);
    renderError(`priority change failed: ${e?.message || 'unknown'}`);
  }
}

// --- Move issue (optimistic) --------------------------------------------

async function moveIssueToColumn(issueID: string, columnID: string): Promise<void> {
  if (!lastIssues) return;
  const issue = lastIssues.find((i) => i.id === issueID);
  if (!issue) return;
  const targetStateID = resolveTargetStateID(issue, columnID);
  if (!targetStateID) {
    renderError(`no "${columnID}" workflow state on team ${issue.teamKey}`);
    return;
  }
  // If the issue is already in the target column, no-op.
  if (columnFor(issue.statusType) === columnID) return;

  // Optimistic: patch local state, re-render, roll back on failure.
  const prevType = issue.statusType;
  const prevStateID = issue.stateId;
  // We don't know the exact name/type/color of the chosen state without
  // looking it up; we know the *type* the column represents, which is what
  // columnFor() consults. Patch just the type+stateId; the next poll will
  // refresh the name/color.
  const columnTypes: Record<string, string> = {
    'todo': 'unstarted',
    'in-progress': 'started',
    'done': 'completed',
  };
  issue.statusType = columnTypes[columnID] || prevType;
  issue.stateId = targetStateID;
  renderBoard(lastIssues);

  try {
    const r = await fetch('/api/linear/issues/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: issueID, stateId: targetStateID }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `http ${r.status}`);
    }
  } catch (e: any) {
    // Roll back.
    issue.statusType = prevType;
    issue.stateId = prevStateID;
    renderBoard(lastIssues);
    renderError(`move failed: ${e?.message || 'unknown'}`);
  }
}

function renderNeedsKey(): void {
  if (!boardEl || !emptyEl || !errorEl) return;
  boardEl.style.display = 'none';
  emptyEl.style.display = 'none';
  errorEl.style.display = '';
  errorEl.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'linear-error-msg';
  msg.textContent = 'add your Linear API key in settings to see tickets';
  errorEl.appendChild(msg);
}

function renderError(text: string): void {
  if (!boardEl || !emptyEl || !errorEl) return;
  // For transient errors (e.g. move failure) we want to keep the board
  // visible underneath. Show the error as a slim strip rather than
  // covering the whole panel.
  errorEl.style.display = '';
  errorEl.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'linear-error-msg';
  msg.textContent = text;
  errorEl.appendChild(msg);
  // Auto-clear after 4s so stale errors don't stick.
  window.setTimeout(() => {
    if (errorEl && errorEl.firstChild === msg) {
      errorEl.innerHTML = '';
      errorEl.style.display = 'none';
    }
  }, 4000);
}

// --- Fetch loop ---------------------------------------------------------

async function poll(force = false): Promise<void> {
  if (!enabled || !panelEl) return;
  try {
    const r = await fetch('/api/linear/issues');
    if (r.status === 409) {
      renderNeedsKey();
      return;
    }
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      renderError(`linear: ${data.error || 'request failed'}`);
      return;
    }
    const data = (await r.json()) as { issues: Issue[]; teamStates: TeamStates; needsKey?: boolean };
    if (data.needsKey) {
      renderNeedsKey();
      return;
    }
    const incoming = data.issues || [];
    markChangedVsLast(incoming);
    lastIssues = incoming;
    teamStates = data.teamStates || {};
    renderBoard(lastIssues);
    // Clear flash flags after the animation window so they fire once.
    setTimeout(() => {
      if (lastIssues) renderBoard(lastIssues);
    }, CHANGED_FLASH_MS + 100);
  } catch (e: any) {
    if (force) renderError(`linear: ${e?.message || 'fetch failed'}`);
  }
}

function startPolling(): void {
  if (pollTimer !== null) return;
  void poll();
  pollTimer = window.setInterval(() => void poll(), POLL_MS);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// --- Public API ---------------------------------------------------------

export function initLinear(
  initiallyEnabled: boolean,
  context: LinearContext,
): void {
  if (initialized) return;
  initialized = true;
  ctx = context;
  loadWorking();
  panelEl = createPanel();
  panelEl.dataset.boardLayout = boardLayout;
  document.getElementById('app')?.appendChild(panelEl);
  setLinearEnabled(initiallyEnabled);

  // Responsive fit observer — same pattern as agent-grid /
  // music-bar. Sets `data-fit` on the panel so CSS can swap
  // layouts based on the actual rendered shape rather than
  // hoping width-only @container queries are enough:
  //
  //   compact → very short slot (h ≤ 110): hide cards entirely,
  //             show only column headers + count chips so the
  //             panel stays useful as a "5 / 12 / 0" status
  //             strip even when squashed.
  //   mini    → short-ish (h ≤ 220): cards visible but their
  //             titles clamp to 1 line (instead of unlimited
  //             wrapping) so 2-3 cards fit per column.
  //   ''      → default kanban.
  const computeFit = (w: number, h: number): 'mini' | '' => {
    if (w <= 0 || h <= 0) return '';
    // Earlier this had a "compact" branch that collapsed the board to
    // just count chips when h ≤ 110px. Users prefer to keep the kanban
    // visible at every size — short slots now scroll internally
    // instead. Only the "mini" downsize remains.
    return h <= 220 ? 'mini' : '';
  };
  const ro = new ResizeObserver((entries) => {
    if (!panelEl) return;
    // Skip writes while the user is actively dragging a lane divider.
    // The drag fires a flood of ResizeObserver entries; flipping
    // `data-fit` mid-drag swaps in different CSS rules that change
    // card padding, which retriggers the observer and produces the
    // visible "jump" near a breakpoint. Re-evaluate once on drag end.
    if (document.body.classList.contains('lane-resizing')) return;
    const r = entries[0].contentRect;
    const fit = computeFit(r.width, r.height);
    if (panelEl.dataset.fit !== fit) panelEl.dataset.fit = fit;
  });
  ro.observe(panelEl);
  window.addEventListener('lane-resize-end', () => {
    if (!panelEl) return;
    const r = panelEl.getBoundingClientRect();
    const fit = computeFit(r.width, r.height);
    if (panelEl.dataset.fit !== fit) panelEl.dataset.fit = fit;
  });
  // Lane-mode wiring: detach event from the lane's × close, plus the
  // first-paint restore of "was the panel a lane last session?".
  // initLanes hasn't run yet at this point in main.ts, so defer the
  // restore until after it does.
  window.addEventListener('lanes:linear-detach', () => {
    if (laneMode) setLinearLaneMode(false);
  });
  // Wait one microtask so initLanes has populated #chat-lanes; then
  // attach if persisted.
  queueMicrotask(() => {
    if (panelEl && shouldRestoreLinearLane() && !isLinearLaneOpen()) {
      setLinearLaneMode(true);
    }
  });

  // When Linear's pair state flips (paired ↔ unpaired), re-render
  // the kanban so column caps (compact view when paired) and
  // expansion state reset cleanly. ALSO sync the dataset.paired
  // attribute to match — without that sync the CSS rules that
  // gate visibility on [data-paired="true"] (most importantly
  // .linear-cards-fewer-btn / .linear-cards-more-btn — the
  // size-cap buttons the user reaches for) stay false forever
  // regardless of the actual layout state, hiding the buttons.
  const syncPairedAttr = () => {
    if (!panelEl) return;
    const paired = isPaired('linear-panel');
    panelEl.dataset.paired = paired ? 'true' : 'false';
  };
  syncPairedAttr();
  onPairStateChanged('linear-panel', () => {
    syncPairedAttr();
    expandedColumns.clear();
    if (lastIssues) renderBoard(lastIssues);
  });
}

export function setLinearEnabled(on: boolean): void {
  enabled = on;
  if (!panelEl) return;
  panelEl.style.display = on ? '' : 'none';
  if (on) {
    startPolling();
  } else {
    stopPolling();
  }
}

// Toggle whether the Linear panel lives inside #chat-lanes (as a
// peer lane) or back in #app as a plain (or paired-via-section-pair)
// section. Lane mode is orthogonal to pairing — leaving lane mode
// drops the panel back into #app as a plain section; the user re-pairs
// via drag-to-dock if desired. The legacy "agent-dock-row" wrapper is
// gone, so no cleanup is needed here.
export function setLinearLaneMode(on: boolean): void {
  if (!panelEl) return;
  if (on === laneMode) return;
  if (on) {
    if (!addLinearLane(panelEl)) return; // already a lane (defensive)
    laneMode = true;
  } else {
    removeLinearLane();
    laneMode = false;
    if (enabled) {
      const app = document.getElementById('app');
      if (app && panelEl.parentElement !== app) app.appendChild(panelEl);
      // Re-apply the user's saved section order so the panel lands at
      // the position it occupied before lane mode (and any pair entry
      // referencing linear-panel reconstructs once both members are back).
      reapplySavedOrder();
    }
  }
}

// Called after the user enters/updates their API key so we re-fetch
// immediately instead of waiting for the next poll tick.
export function refreshLinear(): void {
  if (enabled) void poll(true);
}
