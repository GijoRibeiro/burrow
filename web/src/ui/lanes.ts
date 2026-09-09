// Chat branching: split the chat region into side-by-side lanes.
// Lane 0 ('general') reuses the existing #chat-response + #chat-bar so
// behavior is unchanged when no split is active. Each agent lane is a
// self-contained flex column with its own filtered history view, tab
// title, dedicated input, and (between adjacent lanes) a resize divider.
//
// chatHistory stays a single flat array on the main.ts side; this
// module only manages DOM containers and routing state. The renderer
// asks `hasLane(cwd)` per entry to decide whether to render into the
// agent's lane or fall back to lane 0.

const LANES_OPEN_KEY = 'lanesOpen';
const LANES_WIDTHS_KEY = 'lanesWidths';
const LANES_COLLAPSED_KEY = 'lanesCollapsed';
const LANES_ORDER_KEY = 'lanesFullOrder'; // full id order across reload
const LINEAR_LANE_OPEN_KEY = 'linearLaneOpen';
const MAX_AGENT_LANES = 6; // plus lane 0 = 7 lanes total
const MIN_LANE_PX = 240;
// Section-host lanes can shrink narrower than chat lanes — they
// only need to fit a single column of their hosted content (one
// agent frame, one music tile, one active-agents chip), not a
// full chat bar + readable history. Tighter minimums let the user
// drag the divider down to "exactly fits the content" without a
// dead gap on the right.
const SECTION_LANE_MIN_PX: Record<string, number> = {
  'agent-grid':        120,
  'music-bar':         160,
  'active-agents-bar': 120,
  'linear-panel':      240,
};
function laneMinSize(lane: Lane): number {
  if (lane.kind === 'linear') return SECTION_LANE_MIN_PX[lane.id] ?? MIN_LANE_PX;
  return MIN_LANE_PX;
}
const PERSIST_DEBOUNCE_MS = 200;

export interface LanesContext {
  resolveAgent: (cwd: string) => { sessionId: string; pid: number; name: string; color: string } | null;
  sendChat: (cwd: string, sessionId: string, pid: number, text: string) => boolean;
  // Send chat with attached images. Used so a lane input can flush
  // the global image queue alongside the typed text. Returns false
  // if the connection isn't ready.
  sendChatWithImages?: (cwd: string, sessionId: string, pid: number, text: string, imagesBase64: string[]) => boolean;
  // Optional access to the global image queue so the lane Enter
  // handler can pick up paste-staged images and flush them on send.
  // getImagesBase64 → bytes for the agent. getImagesDataUrls → dataURLs
  // for the local echo thumbnail. Same images, two views.
  hasImages?: () => boolean;
  getImagesBase64?: () => string[];
  getImagesDataUrls?: () => string[];
  clearImages?: () => void;
  // Optional callback so main.ts can repaint the agent grid when an
  // agent's lane state flips (used to apply the .in-lane dim + badge).
  onLanesChanged?: () => void;
  // Lookup the agent's hex color so the tab avatar/border matches the
  // grid frame and the existing send-tint convention.
  agentColor: (cwd: string) => string;
  // Attach the host terminal to the lane's agent — same action as the
  // agent frame's `>` button (select the agent + attachAgent its pid).
  // main.ts owns the selection globals and the connection, so the lane
  // tab delegates here rather than reaching into either.
  attachTerminal?: (cwd: string) => void;
}

type LaneKind = 'general' | 'agent' | 'linear';

interface Lane {
  id: string;            // 'general' for lane 0; cwd for agent lanes; 'linear' for the Linear-section lane.
  kind: LaneKind;
  cwd: string | null;    // agent cwd; null for lane 0 and the Linear lane.
  el: HTMLElement;       // container
  historyEl: HTMLElement;
  inputEl: HTMLTextAreaElement | null; // null for lane 0 (uses #chat-input directly)
  tabEl: HTMLElement | null;
  width: number | null;  // px, persisted; null = flex auto-share
}

let initialized = false;
let containerEl: HTMLElement | null = null;
let ctx: LanesContext | null = null;
const lanes: Lane[] = []; // index 0 = lane 0 ('general')

// --- Persistence ---------------------------------------------------------

let persistTimer: number | null = null;
function persist(): void {
  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    try {
      const open = lanes.filter((l) => l.cwd !== null).map((l) => l.cwd!);
      localStorage.setItem(LANES_OPEN_KEY, JSON.stringify(open));
      const widths: Record<string, number> = {};
      for (const l of lanes) if (l.width !== null) widths[l.id] = l.width;
      localStorage.setItem(LANES_WIDTHS_KEY, JSON.stringify(widths));
      // Save the full id order — including 'general' and any
      // section-host lanes — so user-driven reorder survives reload.
      // Without this, lane-zero always restored at index 0 even when
      // the user had dragged it elsewhere in the strip.
      const order = lanes.map((l) => l.id);
      localStorage.setItem(LANES_ORDER_KEY, JSON.stringify(order));
    } catch { /* ignore quota */ }
  }, PERSIST_DEBOUNCE_MS);
}

function loadFullOrder(): string[] {
  try {
    const raw = localStorage.getItem(LANES_ORDER_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

function loadOpen(): string[] {
  try {
    const raw = localStorage.getItem(LANES_OPEN_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

function loadWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LANES_WIDTHS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

// --- Lane construction ---------------------------------------------------

// Shared tab builder used by every lane kind (agent, general, linear).
// One implementation of collapse / drag-to-swap / drop-target so lane
// 0 ("boss") and Linear get the exact same behaviour as agent lanes
// for free. Handlers close over the lane id (cwd for agents, 'general'
// for lane 0, 'linear' for the Linear lane).
interface LaneTabOptions {
  id: string;
  title: string;
  color: string;
  closable: boolean;
  onClose?: () => void;
  // When set, a `>` terminal button is rendered just left of the
  // collapse `–`, mirroring the agent frame's open-terminal affordance.
  // Only agent lanes pass this; section / boss lanes leave it undefined.
  onTerminal?: () => void;
  extraClass?: string;
}

// Wire a lane CONTAINER (not just its tab) as a swap drop target.
// Same MIME as the tab so any drop on the lane — body, history,
// input bar, anywhere — counts as a swap with the lane that owns
// the drop target. Forgiving UX: users don't have to aim at the
// thin tab strip.
function wireLaneSwapTarget(laneEl: HTMLElement, _laneId: string): void {
  // Per-lane handlers manage the cream dashed highlight only — the
  // canonical drop handler that runs the reorder lives on the
  // chat-lanes CONTAINER (see initLanes). One drop path means no
  // directional asymmetry from event-path quirks.
  laneEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes("application/x-bitwise-lane")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    laneEl.classList.add("lane-swap-drop");
  });
  laneEl.addEventListener("dragleave", (e) => {
    const next = e.relatedTarget as Node | null;
    if (!next || !laneEl.contains(next)) {
      laneEl.classList.remove("lane-swap-drop");
    }
  });
}

function buildLaneTab(opts: LaneTabOptions): HTMLElement {
  const tabEl = document.createElement('div');
  tabEl.className = 'lane-tab' + (opts.extraClass ? ' ' + opts.extraClass : '');
  tabEl.style.borderBottomColor = opts.color;

  const avatar = document.createElement('span');
  avatar.className = 'lane-tab-avatar';
  avatar.style.background = opts.color;
  tabEl.appendChild(avatar);

  const title = document.createElement('span');
  title.className = 'lane-tab-title';
  title.textContent = opts.title;
  title.style.color = opts.color;
  tabEl.appendChild(title);

  // Open-terminal `>` — same glyph + action as the agent frame's
  // term button. Sits left of the collapse `–` so the control cluster
  // reads [> term] [– collapse] [× close], matching the frame's
  // [> term] [x close] order.
  if (opts.onTerminal) {
    const term = document.createElement('span');
    term.className = 'lane-tab-terminal';
    term.textContent = '>';
    term.title = 'open terminal';
    term.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onTerminal?.();
    });
    tabEl.appendChild(term);
  }

  const collapse = document.createElement('span');
  collapse.className = 'lane-tab-collapse';
  collapse.textContent = '–';
  collapse.title = 'collapse to strip';
  collapse.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLaneCollapsed(opts.id);
  });
  tabEl.appendChild(collapse);

  if (opts.closable) {
    const close = document.createElement('span');
    close.className = 'lane-tab-close';
    close.textContent = '×';
    close.title = 'close lane';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onClose?.();
    });
    tabEl.appendChild(close);
  }

  // Drag the tab onto another tab to swap positions. Dedicated MIME
  // so it can coexist with agent-frame and Linear-card drags.
  tabEl.draggable = true;
  tabEl.title = 'drag to swap with another lane';
  tabEl.addEventListener('dragstart', (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData('application/x-bitwise-lane', opts.id);
    e.dataTransfer.effectAllowed = 'move';
    tabEl.classList.add('lane-tab-dragging');
  });
  tabEl.addEventListener('dragend', () => {
    tabEl.classList.remove('lane-tab-dragging');
    document.querySelectorAll('.lane-tab.lane-tab-drop').forEach((el) => el.classList.remove('lane-tab-drop'));
    // Also clear any lingering lane-body swap-drop highlights —
    // when the drop hits a tab, its drop handler stops propagation
    // (so the lane container's listener can't run a second swap),
    // which means the lane container never clears its own outline.
    // dragend always fires once per drag, regardless of where the
    // drop landed, so this is the safe global cleanup.
    document.querySelectorAll('.lane.lane-swap-drop').forEach((el) => el.classList.remove('lane-swap-drop'));
  });
  // Tab keeps dragover for the visual highlight only — the actual
  // drop is handled by the lane container (wireLaneSwapTarget). One
  // canonical drop site avoids the directional bug we hit when both
  // tab AND container had drop handlers and stopPropagation: in some
  // event paths (especially Linear's panel sitting alongside the
  // tab) the tab drop wouldn't fire at all but the lane drop
  // wouldn't either because of capture/order quirks.
  tabEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('application/x-bitwise-lane')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tabEl.classList.add('lane-tab-drop');
  });
  tabEl.addEventListener('dragleave', () => {
    tabEl.classList.remove('lane-tab-drop');
  });
  tabEl.addEventListener('drop', () => {
    // Visual cleanup only — let the drop bubble up to the lane
    // container's handler so reorder runs there.
    tabEl.classList.remove('lane-tab-drop');
  });

  return tabEl;
}

function buildAgentLane(cwd: string): Lane {
  if (!ctx) throw new Error('lanes: not initialized');
  const agent = ctx.resolveAgent(cwd);
  const color = ctx.agentColor(cwd);
  const fallbackName = cwd.split('/').filter(Boolean).pop() ?? cwd;
  const name = agent?.name || fallbackName;

  const el = document.createElement('div');
  el.className = 'lane';
  el.dataset.laneId = cwd;

  const tabEl = buildLaneTab({
    id: cwd,
    title: name,
    color,
    closable: true,
    onClose: () => removeLane(cwd),
    onTerminal: () => ctx?.attachTerminal?.(cwd),
  });

  // Pinned local-link bar — sits directly below the tab. Populated by
  // main.ts's renderChatLinkBar with a chip per local server this agent
  // started (agent.devUrls) plus any manual per-agent pins. Hidden until
  // there's at least one link.
  const linkBar = document.createElement('div');
  linkBar.className = 'lane-link-bar';
  linkBar.dataset.laneLink = cwd;
  linkBar.style.display = 'none';

  const historyEl = document.createElement('div');
  historyEl.className = 'lane-history';

  const bar = document.createElement('div');
  bar.className = 'lane-bar';
  const prompt = document.createElement('span');
  prompt.className = 'prompt';
  prompt.textContent = '>';
  const input = document.createElement('textarea') as HTMLTextAreaElement;
  input.className = 'lane-input';
  input.rows = 1;
  input.placeholder = `message ${name}…`;
  input.spellcheck = false;
  input.autocomplete = 'off';
  bar.appendChild(prompt);
  bar.appendChild(input);

  // Mini active-agent bar for this lane — populated by main.ts's
  // updateActiveAgentsBar when the lane's agent is mid-turn. Sits
  // right above the input so the user always sees activity at the
  // place they're looking. Empty + display: none when the agent
  // is idle.
  const activeBar = document.createElement('div');
  activeBar.className = 'lane-active-bar';
  activeBar.dataset.laneActive = cwd;
  activeBar.style.display = 'none';

  // Per-lane task/roadmap panel — populated by main.ts's
  // updateTaskPanel for the lane's agent. Same task-section markup
  // as the global #task-panel, just rendered inside the lane so a
  // captured agent's roadmap sits next to its chat instead of
  // disappearing when the lane is opened.
  const taskPanel = document.createElement('div');
  taskPanel.className = 'lane-task-panel';
  taskPanel.dataset.laneTasks = cwd;
  taskPanel.style.display = 'none';

  // Picker panel — shows the agent's active Claude Code picker
  // (question + numbered options) so the user can answer it from
  // inside the lane. Hidden by default; populated by setLanePicker
  // when the daemon's terminal scanner detects a picker on the
  // agent's tmux pane. Sits right above the input bar so the
  // chosen option lands at the same spot as a typed message.
  const pickerEl = document.createElement('div');
  pickerEl.className = 'lane-picker';
  pickerEl.dataset.lanePicker = cwd;
  pickerEl.style.display = 'none';

  el.appendChild(tabEl);
  el.appendChild(linkBar);
  el.appendChild(historyEl);
  el.appendChild(taskPanel);
  el.appendChild(activeBar);
  el.appendChild(pickerEl);
  el.appendChild(bar);

  wireLaneInput(input, cwd, () => name);
  wireLaneFocus(el, cwd);
  wireLaneSwapTarget(el, cwd);

  // Click anywhere on the collapsed strip to expand it back. Only
  // fires when the lane is actually collapsed (the click handler in
  // main.ts that sets selectedCwd still runs on expansion clicks
  // because we don't stopPropagation).
  el.addEventListener('click', (e) => {
    if (el.classList.contains('lane-collapsed')) {
      const target = e.target as HTMLElement;
      // Don't expand if user clicked the close × on the strip.
      if (target.closest('.lane-tab-close')) return;
      e.preventDefault();
      toggleLaneCollapsed(cwd);
    }
  });

  // Note: the agent-lane's id is its cwd, so `cwd` and `id` are the
  // same key for this lane in collapsedSet / drag MIME / swapLanes.
  return {
    id: cwd,
    kind: 'agent',
    cwd,
    el,
    historyEl,
    inputEl: input,
    tabEl,
    width: null,
  };
}

// Build a lane that hosts the existing #linear-panel element. The
// panel is reparented into the lane's container — its internal state
// (poll timer, expanded columns, sending shimmer, etc.) survives
// because we don't recreate the DOM, just move it.
// Generic builder for "host an existing section as a lane" — used by
// the Linear panel, music bar, agent grid, and any future top-level
// `#app` section the user wants to drag into the chat strip. The
// section element is reparented (not cloned) so its internal state
// survives the move. Tab uses the shared buildLaneTab helper so the
// section gets drag-to-swap, collapse, and drop-target behaviour
// matching agent / general lanes.
interface SectionLaneOptions {
  id: string;            // unique lane id (e.g. 'linear', 'music-bar', 'agent-grid')
  panel: HTMLElement;    // the section element to host
  title: string;         // tab label
  color: string;         // tab avatar / title tint
  detachEvent: string;   // window event the × close dispatches so the
                         // owning module can put the panel back
}

function buildSectionLane(opts: SectionLaneOptions): Lane {
  const el = document.createElement('div');
  el.className = 'lane lane-section lane-section-' + opts.id;
  el.dataset.laneId = opts.id;

  const tabEl = buildLaneTab({
    id: opts.id,
    title: opts.title,
    color: opts.color,
    closable: true,
    onClose: () => {
      window.dispatchEvent(new CustomEvent(opts.detachEvent));
    },
    extraClass: 'lane-tab-section lane-tab-section-' + opts.id,
  });

  el.appendChild(tabEl);
  el.appendChild(opts.panel);

  wireLaneSwapTarget(el, opts.id);

  return {
    id: opts.id,
    kind: 'linear', // reuse the 'linear' kind for "section-hosting" lanes
    cwd: null,
    el,
    historyEl: opts.panel, // not used for chat history; field is required by the type
    inputEl: null,
    tabEl,
    width: null,
  };
}

function wireLaneInput(
  input: HTMLTextAreaElement,
  cwd: string,
  getName: () => string,
): void {
  input.addEventListener('keydown', (e) => {
    // Tab + autocomplete navigation are delegated to main.ts so the
    // existing slash-command autocomplete machinery is shared with
    // lane inputs. We only handle Enter (send) and slash dispatch
    // here so this module stays free of main.ts coupling.
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Skip while an IME composition is active so dead keys / accents
    // don't try to send the in-progress glyph.
    if (e.isComposing || (e as KeyboardEvent).keyCode === 229) return;
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    // Slash commands always run as global actions, regardless of
    // which lane was typed in. Hand them off via custom event so
    // main.ts dispatches through the existing COMMANDS table.
    if (text.startsWith('/')) {
      window.dispatchEvent(new CustomEvent('lanes:slash', { detail: { text, cwd } }));
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (!ctx) return;
    const agent = ctx.resolveAgent(cwd);
    if (!agent) {
      // Dead agent — disable and bail.
      input.disabled = true;
      input.placeholder = 'agent ended — close lane to remove';
      return;
    }
    // If the user pasted images into this lane, flush them with the
    // text via sendChatWithImages so the agent receives them
    // attached. Capture the dataURLs first so they can ride along on
    // the user-sent event for the local echo (otherwise the lane's
    // chat history loses the image thumbnail and only lane 0's
    // image-queue UI showed it).
    const hasImages = !!(ctx.hasImages && ctx.hasImages());
    let ok = false;
    let imageDataUrls: string[] | undefined;
    if (hasImages && ctx.sendChatWithImages && ctx.getImagesBase64) {
      imageDataUrls = ctx.getImagesDataUrls ? ctx.getImagesDataUrls() : undefined;
      ok = ctx.sendChatWithImages(cwd, agent.sessionId, agent.pid, text, ctx.getImagesBase64());
      if (ok && ctx.clearImages) ctx.clearImages();
    } else {
      ok = ctx.sendChat(cwd, agent.sessionId, agent.pid, text);
    }
    if (ok) {
      input.value = '';
      input.style.height = 'auto';
      window.dispatchEvent(new CustomEvent('lanes:user-sent', {
        detail: { cwd, target: getName(), text, images: imageDataUrls },
      }));
    } else {
      // Send failed (WebSocket closed, server returned false, etc.).
      // Flash the input so the user knows the message didn't go,
      // and surface the reason as a one-shot tooltip on the placeholder
      // so they're not stuck with "why is my text frozen here?".
      input.classList.remove('lane-input-send-failed');
      void input.offsetWidth; // force reflow to restart animation
      input.classList.add('lane-input-send-failed');
      console.warn('[lane send] message did not send', { cwd, len: text.length });
    }
  });

  // Auto-grow textarea up to max-height. Bumped from 120 → 200 so
  // multi-line input via Shift+Enter actually feels usable.
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });
}

function wireLaneFocus(laneEl: HTMLElement, _cwd: string): void {
  laneEl.addEventListener('focusin', () => {
    for (const l of lanes) l.el.classList.toggle('lane-focused', l.el === laneEl);
  });
}

// --- Public API ----------------------------------------------------------

export function initLanes(context: LanesContext): void {
  if (initialized) return;
  initialized = true;
  ctx = context;

  containerEl = document.getElementById('chat-lanes');
  if (!containerEl) return;

  loadCollapsed();

  // Global fallback drop target on the lanes container — catches the
  // swap regardless of which specific lane element ended up under
  // the cursor on release. Resolves directional asymmetries we hit
  // when individual lane drop handlers were the sole source: certain
  // event paths (Linear's panel sitting next to a tab, lane-zero's
  // textarea underneath a tab, etc.) stopped the drop from reaching
  // the per-lane handler. The container handler ALWAYS sees the
  // bubbled drop. Per-lane handlers still run for visual highlight;
  // moveLaneTo is idempotent if both fire (reorderById no-ops when
  // already at the target slot).
  containerEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('application/x-bitwise-lane')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  containerEl.addEventListener('drop', (e) => {
    if (!e.dataTransfer) return;
    const fromId = e.dataTransfer.getData('application/x-bitwise-lane');
    // Always clear any lingering swap-drop highlights — even on a
    // failed drop (no fromId, same id, etc.) so the cream dashed
    // outline doesn't get stuck.
    document.querySelectorAll('.lane.lane-swap-drop').forEach((el) => el.classList.remove('lane-swap-drop'));
    if (!fromId) return;
    e.preventDefault();
    // Find the drop target lane: walk up from the actual event
    // target until we hit a `.lane` element. If none (drop landed
    // on a divider / container padding), no-op — the user didn't
    // aim at a specific lane.
    let el = e.target as HTMLElement | null;
    while (el && el !== containerEl && !el.classList.contains('lane')) {
      el = el.parentElement;
    }
    if (!el || el === containerEl) return;
    const toId = el.dataset.laneId || (el.classList.contains('lane-zero') ? 'general' : '');
    if (!toId || toId === fromId) return;
    moveLaneTo(fromId, toId);
  });

  // Lane 0 — adopt the existing in-DOM lane-zero element.
  const laneZeroEl = containerEl.querySelector('.lane.lane-zero') as HTMLElement | null;
  const chatResponse = document.getElementById('chat-response');
  if (!laneZeroEl || !chatResponse) return;
  lanes.push({
    id: 'general',
    kind: 'general',
    cwd: null,
    el: laneZeroEl,
    historyEl: chatResponse,
    inputEl: null, // existing #chat-input is wired separately by main.ts
    tabEl: null,
    width: null,
  });

  // Lane 0 gets the same tab as agent lanes — collapse, drag-to-swap,
  // and drop-target behaviour all share buildLaneTab. After mount,
  // apply the persisted collapsed state from collapsedSet (loaded
  // above) and mirror it on <body> for any CSS that keys off lane 0
  // being out of the way (e.g. fading the Boss grid frame).
  attachLaneZeroTab(laneZeroEl);
  if (collapsedSet.has('general')) {
    laneZeroEl.classList.add('lane-collapsed');
    document.body.classList.add('lane-zero-is-collapsed');
  }

  // Restore persisted lanes.
  const open = loadOpen();
  const widths = loadWidths();
  for (const cwd of open) {
    if (cwd && !lanes.some((l) => l.cwd === cwd)) {
      const lane = buildAgentLane(cwd);
      lanes.push(lane);
      // Apply persisted collapsed state.
      if (collapsedSet.has(cwd)) lane.el.classList.add('lane-collapsed');
    }
  }
  // Re-evaluate lane-zero tab visibility now that the persisted agent
  // lanes are in place. Without this, the tab stays hidden on a fresh
  // load whenever the user had agent lanes saved from last session —
  // attachLaneZeroTab ran when only lane-zero existed and locked
  // `lane-tab-hidden` on, and the addLane() callers below never fire
  // for restored lanes.
  updateLaneZeroTabVisibility();

  // Apply persisted widths after all lanes exist.
  for (const l of lanes) {
    const w = widths[l.id];
    if (typeof w === 'number' && w >= MIN_LANE_PX) {
      l.width = w;
      setLaneFlex(l, 'pin');
    }
  }

  // Apply the user's saved full-id order (from the previous
  // session's reorders). Default-built lanes are in [general, agents
  // …, sections …] order; reorder them to match localStorage so a
  // user who dragged Linear before Boss, etc., keeps that layout
  // across reload. Section lanes that section-drag.ts attaches in a
  // microtask aren't in `lanes` yet, but their order will be
  // applied when they get added (addSectionLane → persist → next
  // loadFullOrder restores correctly on the FOLLOWING reload). To
  // honour their order on THIS load too, we re-run the order
  // application after the microtask via queueMicrotask.
  applySavedOrder();
  queueMicrotask(applySavedOrder);

  // Render dividers + place every lane in the container in order.
  syncDOM();

  // Resize observer — when the container shrinks below the sum of all
  // pinned widths, lanes overflow horizontally (handled by container's
  // overflow-x: auto).
}

function syncDOM(): void {
  if (!containerEl) return;
  // Detach all children, re-append in lane order with dividers between.
  // A divider is only placed between TWO non-collapsed lanes — see
  // shouldPlaceDividerBetween() for the rationale. Without this guard,
  // grabbing a divider next to a 32px collapsed strip min-clamps the
  // collapsed neighbour up to its normal min width (~200px), and the
  // other lane absorbs the difference in a single frame — visible as
  // a wild jump on what looked like a small drag input.
  while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);
  for (let i = 0; i < lanes.length; i++) {
    if (i > 0) containerEl.appendChild(buildDivider());
    containerEl.appendChild(lanes[i].el);
  }
  applyLastLaneFlex();
  updateDividerVisibility();
}

// A divider is useful only when BOTH adjacent lanes are full-width
// (i.e. neither is collapsed to its 32px strip). A divider next to a
// collapsed lane drags into the collapsed lane's min-size clamp on
// the first pixel of movement, which manifests as the "jumps to a
// crazy number" bug. The 32px strip already serves as its own
// click-to-expand affordance, so no draggable handle is needed
// alongside it.
function shouldPlaceDividerBetween(a: Lane, b: Lane): boolean {
  return !collapsedSet.has(a.id) && !collapsedSet.has(b.id);
}

// Show a divider only between two full-width lanes; HIDE (not remove)
// the ones flanking a collapsed strip. Toggling `display` instead of
// adding/removing the element is critical: a collapse/expand must never
// detach a lane element from the DOM, because re-inserting it resets
// the CSS flex transition's baseline and the panel snaps open instead
// of animating. Dividers don't animate, so flipping their display is
// free.
function updateDividerVisibility(): void {
  if (!containerEl) return;
  containerEl.querySelectorAll<HTMLElement>('.lane-divider').forEach((div) => {
    const left = lanes.find((l) => l.el === div.previousElementSibling);
    const right = lanes.find((l) => l.el === div.nextElementSibling);
    const show = !!left && !!right && shouldPlaceDividerBetween(left, right);
    div.style.display = show ? '' : 'none';
  });
}

// Reorder the in-memory `lanes` array to match the saved id order
// from the previous session. Lanes whose ids aren't in the saved
// list keep their default position relative to each other (appended
// after the saved-order block). Idempotent — safe to call multiple
// times (e.g. on init AND after section-drag's microtask attaches
// section lanes).
// Pure sort helper: returns a copy of `arr` reordered to match
// `savedOrder` (by id). Items present in savedOrder come first in
// that order; items not present keep their original relative order
// and are appended after. Exported for vitest coverage — see
// reorderToMatchSavedOrder cases in lanes.test.ts.
export function reorderToMatchSavedOrder<T extends { id: string }>(
  arr: readonly T[],
  savedOrder: readonly string[],
): T[] {
  if (savedOrder.length === 0) return arr.slice();
  const indexInSaved = new Map<string, number>();
  savedOrder.forEach((id, i) => indexInSaved.set(id, i));
  const ranked = arr.map((item, i) => ({
    item,
    rank: indexInSaved.has(item.id) ? indexInSaved.get(item.id)! : Number.POSITIVE_INFINITY,
    fallback: i,
  }));
  ranked.sort((a, b) => (a.rank - b.rank) || (a.fallback - b.fallback));
  return ranked.map((r) => r.item);
}

// Reorder the in-memory `lanes` array to match the saved id order
// from the previous session. Lanes whose ids aren't in the saved
// list keep their default position relative to each other (appended
// after the saved-order block). Idempotent — safe to call multiple
// times (e.g. on init AND after section-drag's microtask attaches
// section lanes).
function applySavedOrder(): void {
  const savedOrder = loadFullOrder();
  if (savedOrder.length === 0) return;
  const newOrder = reorderToMatchSavedOrder(lanes, savedOrder);
  let changed = false;
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i] !== newOrder[i]) { changed = true; break; }
  }
  if (!changed) return;
  lanes.length = 0;
  for (const l of newOrder) lanes.push(l);
  syncDOM();
}

// The one place that writes a lane's flex sizing. Always the three
// longhands (never the `flex` shorthand) so the CSS width transition
// animates and no later write has to undo a stale shorthand.
//   collapsed — clear inline so the .lane-collapsed !important rule wins
//   pin       — fixed at l.width px; doesn't fight neighbours for space
//   fill      — grows to absorb slack; basis = saved width, else 0. Basis 0
//               (not auto) keeps it interpolable so expanding from a 32px
//               collapsed strip animates instead of snapping.
//   share     — grows from natural content width (unpinned, not last)
type LaneFlex = 'collapsed' | 'pin' | 'fill' | 'share';
function setLaneFlex(l: Lane, mode: LaneFlex): void {
  const s = l.el.style;
  if (mode === 'collapsed') {
    s.flexGrow = s.flexShrink = s.flexBasis = '';
    return;
  }
  const pin = mode === 'pin';
  s.flexGrow = pin ? '0' : '1';
  s.flexShrink = pin ? '0' : '1';
  s.flexBasis = mode === 'share' ? 'auto' : l.width !== null ? `${l.width}px` : '0';
}

// Size every lane so the row stays edge-to-edge: the last visible lane
// fills slack, sized neighbours keep their pinned width, and an unsized
// non-last lane shares from its content width. Collapsed lanes defer to
// the .lane-collapsed CSS rule.
function applyLastLaneFlex(): void {
  let lastVisible = -1;
  for (let i = lanes.length - 1; i >= 0; i--) {
    if (!collapsedSet.has(lanes[i].id)) { lastVisible = i; break; }
  }
  if (lastVisible === -1) lastVisible = lanes.length - 1;

  lanes.forEach((l, i) => {
    if (collapsedSet.has(l.id)) setLaneFlex(l, 'collapsed');
    else if (i === lastVisible) setLaneFlex(l, 'fill');
    else if (l.width !== null) setLaneFlex(l, 'pin');
    else setLaneFlex(l, 'share');
  });
}

function buildDivider(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'lane-divider';
  el.title = 'drag to resize · double-click to split evenly';
  // Resolve which lanes this divider sits between *at mousedown
  // time*, via DOM siblings, instead of capturing array indexes in
  // the closure. The closure-index version drifted out of sync with
  // the live `lanes[]` after async reorders (e.g. section-lane
  // restore) — which is what made the AGENTS-side divider behave
  // like the BOSS-Cloovies divider until something else triggered
  // a re-sync.
  el.addEventListener('mousedown', (e) => startResize(e, el));
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    splitLanesEvenly();
  });
  return el;
}

// Distribute the row equally among every non-collapsed lane. Clearing
// each width to null and using 'fill' (grow:1, basis:0) splits the row
// mathematically equally — unlike basis:auto, which would reserve each
// lane's content width first and split unevenly. Collapsed lanes keep
// their 32px strip.
function splitLanesEvenly(): void {
  for (const l of lanes) {
    if (collapsedSet.has(l.id)) continue;
    l.width = null;
    setLaneFlex(l, 'fill');
  }
  persist();
}

// --- Lane 0 ("boss") tab -----------------------------------------------

// Legacy localStorage key used before lane 0 shared the standard
// collapse mechanism. Migrated into `collapsedSet` (under id 'general')
// the first time we boot with the new code; see loadCollapsed.
const LANE_ZERO_COLLAPSED_KEY = 'laneZeroCollapsed';

let laneZeroTabEl: HTMLElement | null = null;

// Attach a real `lane-tab` to lane 0 using the same builder agent
// lanes use. Collapse, drag-to-swap, and drop-target behaviour all
// come from buildLaneTab — lane 0 is just an agent-shaped lane with
// id 'general' and no close button.
function attachLaneZeroTab(laneZeroEl: HTMLElement): void {
  const tab = buildLaneTab({
    id: 'general',
    title: 'boss',
    color: '#eae5ce',
    closable: false,
    extraClass: 'lane-tab-zero',
  });

  // Insert at the top so it sits above #chat-response, matching the
  // agent-lane tab placement.
  laneZeroEl.insertBefore(tab, laneZeroEl.firstChild);
  laneZeroTabEl = tab;

  // Click on the collapsed strip to expand back. Mirrors the
  // identical handler buildAgentLane wires for agent lanes.
  laneZeroEl.addEventListener('click', (e) => {
    if (laneZeroEl.classList.contains('lane-collapsed')) {
      const target = e.target as HTMLElement;
      if (target.closest('.lane-tab-close')) return;
      e.preventDefault();
      toggleLaneCollapsed('general');
    }
  });

  // Lane 0 also accepts swap drops anywhere in its body, same as
  // agent / section lanes — the UX is "drag a tab onto any other
  // lane and they swap places".
  wireLaneSwapTarget(laneZeroEl, 'general');
}

function updateLaneZeroTabVisibility(): void {
  // Kept as a no-op shim so existing call-sites compile; the tab is
  // always visible now.
  if (!laneZeroTabEl) return;
  laneZeroTabEl.classList.remove('lane-tab-hidden');
}

// --- Resize --------------------------------------------------------------

function startResize(e: MouseEvent, divEl: HTMLElement): void {
  e.preventDefault();
  if (!containerEl) return;
  // Look up neighbours by DOM siblings, then map back to the lane
  // entry for each. This stays correct across any reorder because
  // it reads the live DOM at click time instead of trusting a
  // captured index from when the divider was built.
  const leftEl = divEl.previousElementSibling as HTMLElement | null;
  const rightEl = divEl.nextElementSibling as HTMLElement | null;
  if (!leftEl || !rightEl) return;
  const left = lanes.find((l) => l.el === leftEl);
  const right = lanes.find((l) => l.el === rightEl);
  if (!left || !right) return;
  // Defense-in-depth: syncDOM already refuses to place a divider next
  // to a collapsed lane, but a stale divider can survive briefly if a
  // collapse toggle races with a mousedown. Bail rather than run the
  // resize math against a 32px collapsed neighbour — that path
  // immediately trips the min-size clamp and dumps ~170px onto the
  // expanded neighbour in a single frame.
  if (collapsedSet.has(left.id) || collapsedSet.has(right.id)) return;
  const rightIsLast = lanes[lanes.length - 1] === right;

  // The lanes container can be flipped to a vertical stack via the
  // `lanes-vertical` body class (settings → appearance → chat lanes).
  // Resize the cross axis that actually corresponds to the layout
  // direction so dragging feels natural in either orientation.
  const vertical = document.body.classList.contains('lanes-vertical');
  const startCoord = vertical ? e.clientY : e.clientX;
  const leftRect = left.el.getBoundingClientRect();
  const rightRect = right.el.getBoundingClientRect();
  const startLeftW = vertical ? leftRect.height : leftRect.width;
  const startRightW = vertical ? rightRect.height : rightRect.width;
  const totalW = startLeftW + startRightW;
  // Per-lane min sizes so section-host lanes (agent grid, etc.) can
  // shrink to fit their content without a dead right-edge gap, while
  // chat lanes keep the wider readable minimum. Vertical mode keeps
  // its single shorter min — section heights aren't constrained
  // the same way.
  const minLeft = vertical ? 120 : laneMinSize(left);
  const minRight = vertical ? 120 : laneMinSize(right);

  document.body.classList.add('lane-resizing');

  // Coalesce mousemove style writes into a single rAF tick. Without
  // this, fast drags fire multiple mousemove events between frames
  // and each one synchronously mutates flex-basis, which can cause
  // a partial paint between writes — visible as the divider
  // "flickering" or the column "jumping" mid-drag. rAF batches the
  // writes so the layout updates once per frame.
  let pendingCoord = startCoord;
  let rafID: number | null = null;
  // A pure click (mousedown→mouseup with no real drag) must NOT rewrite
  // flex. flush() pins both neighbours from flexible (grow:1/basis:0 or
  // auto) to hard `0 0 Npx`, re-runs the min clamp, and rounds the
  // sub-pixel rects — so a no-op click visibly reflows the row and, if a
  // neighbour is already under its min, dumps the slack onto the other
  // lane in one frame. Only commit once movement crosses a small dead
  // zone, so clicking the divider (incl. the two down/up pairs of a
  // double-click-to-even) leaves the layout untouched.
  const DRAG_THRESHOLD_PX = 3;
  let moved = false;
  const flush = () => {
    rafID = null;
    let newLeft = startLeftW + (pendingCoord - startCoord);
    let newRight = totalW - newLeft;
    if (newLeft < minLeft) { newLeft = minLeft; newRight = totalW - newLeft; }
    if (newRight < minRight) { newRight = minRight; newLeft = totalW - newRight; }
    left.width = Math.round(newLeft);
    setLaneFlex(left, 'pin');
    if (rightIsLast) {
      // Last lane stays on fill so it keeps absorbing slack — future
      // window resizes, lane 0 collapsing — instead of freezing at a px.
      right.width = null;
      setLaneFlex(right, 'fill');
    } else {
      right.width = Math.round(newRight);
      setLaneFlex(right, 'pin');
    }
  };
  const onMove = (ev: MouseEvent) => {
    pendingCoord = vertical ? ev.clientY : ev.clientX;
    if (!moved && Math.abs(pendingCoord - startCoord) >= DRAG_THRESHOLD_PX) moved = true;
    if (moved && rafID === null) rafID = requestAnimationFrame(flush);
  };
  const onUp = () => {
    if (rafID !== null) { cancelAnimationFrame(rafID); rafID = null; }
    document.body.classList.remove('lane-resizing');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    // A click that never crossed the drag dead zone is a no-op — don't
    // pin widths, fire observers, or persist. Bailing here is what stops
    // a single click on the divider from reflowing the row.
    if (!moved) return;
    // Run one final flush so the last mousemove always lands, even
    // if mouseup arrived between rAF ticks.
    flush();
    // Trigger the resize-gated observers (linear `data-fit`,
    // agent-grid `data-grid-mode`) to reconcile their attributes
    // once now that the drag has settled. Without this nudge, any
    // breakpoint crossings made during the drag stay pending until
    // the next window-resize.
    window.dispatchEvent(new Event('lane-resize-end'));
    persist();
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// --- Add / remove --------------------------------------------------------

export function addLane(cwd: string): boolean {
  if (!initialized || !ctx || !containerEl) return false;
  const existing = lanes.find((l) => l.cwd === cwd);
  if (existing) {
    // Already open — flash the tab title to confirm.
    if (existing.tabEl) {
      existing.tabEl.classList.remove('lane-tab-flash');
      // Reflow trick to restart the animation.
      void existing.tabEl.offsetWidth;
      existing.tabEl.classList.add('lane-tab-flash');
    }
    return false;
  }
  const agentLanesCount = lanes.filter((l) => l.cwd !== null).length;
  if (agentLanesCount >= MAX_AGENT_LANES) {
    // Reject visually — flash the container's outline.
    if (containerEl) {
      containerEl.classList.add('lane-drop-target');
      setTimeout(() => containerEl?.classList.remove('lane-drop-target'), 400);
    }
    return false;
  }
  const lane = buildAgentLane(cwd);
  lanes.push(lane);
  syncDOM();
  persist();
  updateLaneZeroTabVisibility();
  ctx.onLanesChanged?.();
  // Focus the new lane's input so the user can immediately type.
  setTimeout(() => lane.inputEl?.focus(), 0);
  return true;
}

// Per-cwd collapsed state. Persisted in localStorage. Collapsed
// lanes shrink to a thin vertical strip showing the agent name
// rotated 90° — click the strip to expand back.
const collapsedSet = new Set<string>();

function loadCollapsed(): void {
  try {
    const raw = localStorage.getItem(LANES_COLLAPSED_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) for (const c of arr) if (typeof c === 'string') collapsedSet.add(c);
    }
  } catch { /* ignore */ }
  // Migrate the old per-key flag for lane 0 into the unified set so
  // the user's existing collapsed-boss preference carries over from
  // the slim-sidebar implementation.
  try {
    if (localStorage.getItem(LANE_ZERO_COLLAPSED_KEY) === '1') {
      collapsedSet.add('general');
    }
    localStorage.removeItem(LANE_ZERO_COLLAPSED_KEY);
  } catch { /* ignore */ }
}
function saveCollapsed(): void {
  localStorage.setItem(LANES_COLLAPSED_KEY, JSON.stringify([...collapsedSet]));
}

function toggleLaneCollapsed(id: string): void {
  const lane = lanes.find((l) => l.id === id);
  if (!lane) return;
  const willCollapse = !collapsedSet.has(id);
  if (willCollapse) {
    collapsedSet.add(id);
    lane.el.classList.add('lane-collapsed');
  } else {
    collapsedSet.delete(id);
    lane.el.classList.remove('lane-collapsed');
  }
  // Mirror lane 0's collapsed state on <body> so other CSS (e.g.
  // fading the Boss grid frame) can react without DOM-querying lanes.
  if (id === 'general') {
    document.body.classList.toggle('lane-zero-is-collapsed', willCollapse);
  }
  saveCollapsed();
  persist();
  // In-place update only — do NOT call syncDOM here. syncDOM detaches
  // and re-appends every lane element, which kills the .lane flex
  // transition and makes expand snap open. Instead flip divider
  // visibility (which dividers are valid depends on collapsed state)
  // and re-apply flex on the same, in-place lane elements so the
  // 220ms transition actually animates.
  updateDividerVisibility();
  applyLastLaneFlex();
  ctx?.onLanesChanged?.();
}

export function isLaneCollapsed(idOrCwd: string): boolean {
  return collapsedSet.has(idOrCwd);
}

// Pure reorder helper: returns a new array with `fromId` moved to
// the slot currently held by `toId`, browser-tab-style. Drag A onto
// C in [A, B, C, D] → [B, A, C, D] (not the position-swap
// [C, B, A, D]). Exported for testability — moveLaneTo wraps it
// with the DOM / persistence side-effects.
export function reorderById<T extends { id: string }>(
  arr: readonly T[],
  fromId: string,
  toId: string,
): T[] {
  const fromIdx = arr.findIndex((l) => l.id === fromId);
  const toIdx = arr.findIndex((l) => l.id === toId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return arr.slice();
  const next = arr.slice();
  const [moved] = next.splice(fromIdx, 1);
  const newToIdx = next.findIndex((l) => l.id === toId);
  next.splice(newToIdx, 0, moved);
  return next;
}

// Position-swap variant. Kept as a tested alternative in case we
// ever want to expose both behaviours behind a setting.
export function swapById<T extends { id: string }>(
  arr: readonly T[],
  aId: string,
  bId: string,
): T[] {
  const out = arr.slice();
  const aIdx = out.findIndex((l) => l.id === aId);
  const bIdx = out.findIndex((l) => l.id === bId);
  if (aIdx < 0 || bIdx < 0 || aIdx === bIdx) return out;
  [out[aIdx], out[bIdx]] = [out[bIdx], out[aIdx]];
  return out;
}

// Move a lane to another lane's slot. id is the agent's cwd for
// agent lanes, 'general' for lane 0, or the section id ('linear',
// 'music-bar', 'agent-grid', ...) for section-host lanes.
function moveLaneTo(fromId: string, toId: string): void {
  const next = reorderById(lanes, fromId, toId);
  // Same array reference — keep callers that captured `lanes`
  // pointing at fresh data.
  lanes.length = 0;
  for (const l of next) lanes.push(l);
  syncDOM();
  persist();
}

// --- Section-as-lane API --------------------------------------------
// Generic "host any #app section as a lane" — the Linear panel, the
// music bar, the agents grid, and any future top-level draggable
// section can all become a lane via this single API. Each section
// has a stable id; lanes are tracked by id; persisted via a Set
// stored in localStorage so the user's set of section-lanes survives
// reload.

const SECTION_LANES_KEY = 'sectionLanesOpen';

function loadSectionLanes(): Set<string> {
  try {
    const raw = localStorage.getItem(SECTION_LANES_KEY);
    if (!raw) {
      // Migration: read the older single-key linear flag if present.
      const legacy = localStorage.getItem(LINEAR_LANE_OPEN_KEY);
      return new Set(legacy === '1' ? ['linear'] : []);
    }
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch { return new Set(); }
}

function persistSectionLanes(): void {
  const ids = lanes.filter((l) => l.kind === 'linear').map((l) => l.id);
  try { localStorage.setItem(SECTION_LANES_KEY, JSON.stringify(ids)); } catch { /* quota */ }
}

export interface AddSectionLaneOptions {
  id: string;
  panel: HTMLElement;
  title: string;
  color: string;
  detachEvent: string;
}

// Attach the supplied section element as a peer lane. Reparents the
// element into a fresh lane container so internal state (poll
// timers, animations, listeners) survives. Idempotent: returns
// false if a lane with this id is already open.
export function addSectionLane(opts: AddSectionLaneOptions): boolean {
  if (!initialized || !ctx || !containerEl) return false;
  if (lanes.some((l) => l.id === opts.id)) return false;
  const lane = buildSectionLane(opts);
  lanes.push(lane);
  // Restore this lane to its saved position if the user reordered
  // it before. Section lanes attach asynchronously (section-drag's
  // queueMicrotask runs after initLanes' applySavedOrder), so
  // without this call they'd always land at the end of the strip.
  applySavedOrder();
  syncDOM();
  persist();
  persistSectionLanes();
  ctx.onLanesChanged?.();
  return true;
}

// Detach a section lane by id. Returns the panel element so the
// caller can reparent it back to wherever it lived before.
export function removeSectionLane(id: string): HTMLElement | null {
  const idx = lanes.findIndex((l) => l.id === id && l.kind === 'linear');
  if (idx < 0) return null;
  const [removed] = lanes.splice(idx, 1);
  // The panel is whatever element we appended after the tab — pull
  // it out of the lane before the lane element itself is removed
  // so the panel survives.
  const panel = removed.historyEl;
  if (panel && panel.parentElement === removed.el) panel.remove();
  removed.el.remove();
  syncDOM();
  persist();
  persistSectionLanes();
  ctx?.onLanesChanged?.();
  return panel;
}

export function isSectionLaneOpen(id: string): boolean {
  return lanes.some((l) => l.id === id && l.kind === 'linear');
}

// Persisted set of section-lane ids that should be restored on init.
// Owners (linear.ts, etc.) call this in their init to decide whether
// to addSectionLane after their panel element exists.
export function persistedSectionLanes(): Set<string> {
  return loadSectionLanes();
}

// --- Backward-compat shims for the linear-specific call-sites ---

export function addLinearLane(panel: HTMLElement): boolean {
  return addSectionLane({
    id: 'linear',
    panel,
    title: 'linear',
    color: '#e0aa5a',
    detachEvent: 'lanes:linear-detach',
  });
}

export function removeLinearLane(): HTMLElement | null {
  return removeSectionLane('linear');
}

export function isLinearLaneOpen(): boolean {
  return isSectionLaneOpen('linear');
}

export function shouldRestoreLinearLane(): boolean {
  return loadSectionLanes().has('linear');
}

export function removeLane(cwd: string): void {
  if (!ctx) return;
  const idx = lanes.findIndex((l) => l.cwd === cwd);
  if (idx < 0) return;
  // Never remove the general lane regardless of where it sits in
  // the strip — kind-based guard, not index-based, since the user
  // can reorder lane-zero out of position 0 now.
  if (lanes[idx].kind === 'general') return;
  const [removed] = lanes.splice(idx, 1);
  evacuateSingletons(removed.el);
  removed.el.remove();
  syncDOM();
  persist();
  updateLaneZeroTabVisibility();
  ctx.onLanesChanged?.();
  window.dispatchEvent(new CustomEvent('lanes:removed', { detail: { cwd } }));
}

// Some "global singleton" DOM elements (the image queue, the
// slash-command autocomplete dropdown) get re-parented INTO a lane
// when the user focuses that lane's input — so pasted thumbnails
// and the autocomplete popup appear right above the active input.
// If we then \`el.remove()\` the lane, those singletons go with it
// and end up detached from the document. Module code that stashed
// a reference at init (e.g. image-queue.ts's \`containerEl\`) keeps
// writing into the detached node, which is exactly why pasted
// image previews stop showing up after a session of opening and
// closing lanes. Move them back to lane 0 before remove() so they
// stay live.
function evacuateSingletons(laneEl: HTMLElement): void {
  const laneZero = lanes.find((l) => l.kind === 'general');
  if (!laneZero) return;
  for (const id of ['image-queue', 'autocomplete']) {
    const el = laneEl.querySelector('#' + id) as HTMLElement | null;
    if (el) laneZero.el.appendChild(el);
  }
}

export function hasLane(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  return lanes.some((l) => l.cwd === cwd);
}

// Returns the per-lane task panel element for an agent's cwd, or
// null if no dedicated lane exists. Used by updateTaskPanel so a
// captured agent's roadmap renders inside its lane instead of in
// lane 0's #task-panel.
export function laneTaskPanelEl(cwd: string): HTMLElement | null {
  const l = lanes.find((x) => x.cwd === cwd);
  if (!l) return null;
  return l.el.querySelector('.lane-task-panel') as HTMLElement | null;
}

// Returns the history element a chat entry should render into, given
// the entry's agentCwd. Falls back to the 'general' lane's element
// when no dedicated lane exists. Looks up by `kind === 'general'`
// rather than `lanes[0]` because the user can now reorder lane-zero
// to any position in the strip — chat content must follow the
// general lane, not whichever lane currently holds index 0 (which
// might be a section-host lane whose `historyEl` IS the section
// panel itself, causing chat to render into the agent grid / music
// bar / linear panel).
export function laneHistoryEl(agentCwd: string | null | undefined): HTMLElement {
  if (agentCwd) {
    const l = lanes.find((x) => x.cwd === agentCwd);
    if (l) return l.historyEl;
  }
  const general = lanes.find((x) => x.kind === 'general');
  return general?.historyEl ?? document.getElementById('chat-response')!;
}

// Are any agent lanes currently open? Used by main.ts's Tab handler
// to switch between "cycle every agent in the grid" mode and "cycle
// only between open panels" mode.
export function hasAnyAgentLane(): boolean {
  return lanes.some((l) => l.cwd !== null);
}

// Lane cwds in DOM order, with `null` for lane 0. Lets the Tab
// handler walk panels left-to-right without knowing about the
// internal Lane shape.
export function laneOrder(): (string | null)[] {
  return lanes.map((l) => l.cwd);
}

// Iterate lanes (read-only, for renderers that walk all history
// targets — e.g. grouping, dedup). Order matches DOM order.
export function eachLane(fn: (lane: { cwd: string | null; historyEl: HTMLElement }) => void): void {
  for (const l of lanes) fn({ cwd: l.cwd, historyEl: l.historyEl });
}

// Mark a lane as "dead" (its agent disappeared from state). Disables
// the input and dims the title. Idempotent.
export function markLaneDead(cwd: string, dead: boolean): void {
  const l = lanes.find((x) => x.cwd === cwd);
  if (!l) return;
  l.el.classList.toggle('lane-dead', dead);
  if (l.inputEl) {
    l.inputEl.disabled = dead;
    if (dead) l.inputEl.placeholder = 'agent ended — close lane to remove';
  }
}

// Mark a lane's agent as "working" so the tab title shows a small
// pulsing indicator. Mirrors the working state on the agent grid
// frame so the user can see activity from inside the lane too.
export function markLaneWorking(cwd: string, working: boolean): void {
  const l = lanes.find((x) => x.cwd === cwd);
  if (!l || !l.tabEl) return;
  l.tabEl.classList.toggle('lane-tab-working', working);
}

// Focus the input of a lane by cwd. Used by main.ts after Tab
// cycles selection — when the new selectedCwd has a dedicated
// lane, jump focus into that lane's input.
export function focusLaneInput(cwd: string): boolean {
  const l = lanes.find((x) => x.cwd === cwd);
  if (!l || !l.inputEl) return false;
  l.inputEl.focus();
  return true;
}

// Render or clear the picker panel for the agent's lane. Called
// from main.ts whenever state.update fires with a changed picker
// shape. `picker` null/undefined hides the panel; a populated
// picker rebuilds the buttons. Click handlers fire onChoose with
// the selected number — the caller (main.ts) decides what to do
// with it (typically: `conn.sendChat(cwd, sid, pid, "<num>")`,
// which sends the digit + Enter through tmux send-keys).
interface LanePickerOption {
  number: number;
  label: string;
  description?: string;
  isCheckbox?: boolean;
  checked?: boolean;
}

// Build the monospace preview block (the agent's right-column content/diff
// preview), optionally labelled with the option it belongs to so it's clear
// which choice you're looking at.
function buildPickerPreview(preview: string, forLabel?: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'lane-picker-preview-wrap';
  const cap = document.createElement('div');
  cap.className = 'lane-picker-preview-cap';
  cap.textContent = forLabel ? `↳ preview: ${forLabel}` : 'preview';
  const pre = document.createElement('pre');
  pre.className = 'lane-picker-preview';
  pre.textContent = preview;
  wrap.appendChild(cap);
  wrap.appendChild(pre);
  return wrap;
}

type LanePicker = {
  question: string;
  options: LanePickerOption[];
  multiSelect?: boolean;
  preview?: string;
  cursor?: number;
};

// Signature of every part of a picker that affects the rendered DOM.
// setLanePicker runs on every state.onUpdate, and onUpdate fires whenever
// ANY agent's hashed fields change (tokens, status, currentTask…), not just
// when this picker changes. Without this guard the panel was torn down and
// rebuilt on those unrelated ticks — which is why a freshly-detected prompt
// flickered a few times (the asking agent's own status/tokens settle over
// the first ticks after it goes idle) before stabilising. Rebuild only when
// the signature actually changes.
function pickerSig(picker: LanePicker | null): string {
  if (!picker) return '';
  let s = (picker.multiSelect ? 'M' : 'S') + '' + (picker.question || '') +
    'cur:' + (picker.cursor ?? 0) + 'prev:' + (picker.preview || '');
  for (const o of picker.options) {
    s += '' + o.number + ':' + o.label + ':' + (o.description || '') +
      ':' + (o.isCheckbox ? 'c' : '') + (o.checked ? '1' : '0');
  }
  return s;
}

export function setLanePicker(
  cwd: string,
  picker: LanePicker | null,
  onChoose: (num: number) => void,
  onSubmit?: () => void,
): void {
  const lane = lanes.find((x) => x.cwd === cwd);
  if (!lane) return;
  const panel = lane.el.querySelector<HTMLElement>('.lane-picker');
  if (!panel) return;

  // Already showing this exact picker (or already hidden) — leave the DOM
  // untouched so unrelated state ticks don't flicker the prompt or drop the
  // user's hover/optimistic-toggle state.
  const sig = pickerSig(picker);
  if (panel.dataset.sig === sig) return;
  panel.dataset.sig = sig;

  if (!picker) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  // Rebuild from scratch — picker shapes are small (a handful of
  // options) and, with the signature guard above, rebuilds only happen
  // when the picker's content actually changes. Diffing isn't worth the
  // complexity here.
  panel.innerHTML = '';
  const q = document.createElement('div');
  q.className = 'lane-picker-q';
  q.textContent = picker.question || 'Choose an option';
  panel.appendChild(q);

  const list = document.createElement('div');
  list.className = 'lane-picker-opts';
  let previewPlaced = false;
  for (const opt of picker.options) {
    // In a multi-select, options with a checkbox TOGGLE (digit, no Enter);
    // plain action options ("Chat about this") still commit immediately.
    const isToggle = !!picker.multiSelect && !!opt.isCheckbox;

    const btn = document.createElement('button');
    btn.className = 'lane-picker-opt';
    if (isToggle) btn.classList.add('lane-picker-checkbox');
    if (isToggle && opt.checked) btn.classList.add('is-checked');
    btn.dataset.num = String(opt.number);
    btn.type = 'button';

    const num = document.createElement('span');
    num.className = 'lane-picker-num';
    // Checkbox options show a box glyph reflecting state; action options
    // show their number (the key they map to).
    num.textContent = isToggle ? (opt.checked ? '☑' : '☐') : String(opt.number);

    const labelWrap = document.createElement('span');
    labelWrap.className = 'lane-picker-labelwrap';
    const label = document.createElement('span');
    label.className = 'lane-picker-label';
    label.textContent = opt.label;
    labelWrap.appendChild(label);
    if (opt.description) {
      const desc = document.createElement('span');
      desc.className = 'lane-picker-desc';
      desc.textContent = opt.description;
      labelWrap.appendChild(desc);
    }

    btn.appendChild(num);
    btn.appendChild(labelWrap);
    // The preview is the agent's content/diff for the HIGHLIGHTED option only
    // (the terminal redraws it as the cursor moves). Mark that option and nest
    // its preview right under it, so it's clear which choice you're seeing —
    // rather than a floating block detached from the options.
    const isCursor = !!picker.preview && picker.cursor === opt.number;
    if (isCursor) btn.classList.add('is-cursor');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isToggle) {
        // Optimistic flip so the toggle feels instant; the next ~3s scan
        // reconciles against the real pane state.
        const checkedNow = !btn.classList.contains('is-checked');
        btn.classList.toggle('is-checked', checkedNow);
        num.textContent = checkedNow ? '☑' : '☐';
      }
      onChoose(opt.number);
    });
    list.appendChild(btn);
    if (isCursor && picker.preview) {
      list.appendChild(buildPickerPreview(picker.preview, opt.label));
      previewPlaced = true;
    }
  }
  panel.appendChild(list);

  // Fallback: a preview exists but we couldn't tell which option it belongs to
  // (cursor unknown). Show it once, unlabelled, rather than dropping it.
  if (picker.preview && !previewPlaced) {
    panel.appendChild(buildPickerPreview(picker.preview));
  }

  // Multi-select needs an explicit Submit (sends Enter) — toggling options
  // alone never commits the answer.
  if (picker.multiSelect && onSubmit) {
    const submit = document.createElement('button');
    submit.className = 'lane-picker-submit';
    submit.type = 'button';
    submit.textContent = 'Submit';
    submit.addEventListener('click', (e) => {
      e.stopPropagation();
      onSubmit();
    });
    panel.appendChild(submit);
  }

  panel.style.display = '';
}
