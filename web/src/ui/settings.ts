// Settings modal — opened from the wrench icon in the top-right.
// Holds the server-managed terminal-app setting plus the local UI preferences
// that aren't frequent enough to deserve their own slot in the top bar
// (grid position, hide avatars). Each row calls onSave with a string
// key/value pair; the caller decides whether to persist it server-side or
// in localStorage.

import { CHAT_FONTS } from './chat-fonts';
import {
  getPreflightReport,
  getPreflightError,
  onPreflightChange,
  openPreflightModal,
  refreshPreflight,
} from './preflight';

export interface SettingsModalState {
  terminalApp: string;
  avatarsHidden: boolean;
  bgColor: string;
  musicEnabled: boolean;
  musicStyle: string;
  musicDither: string;
  musicLyrics: boolean;
  musicSource: string;
  linearEnabled: boolean;
  linearApiKey: string;
  lanesVertical: boolean;
  chatBubbles: boolean;
  bubbleUserColor: string;
  bubbleAgentColor: string;
  bubbleBossColor: string;
  agentsMinimal: boolean;
  notifyOnFinish: boolean;
  chatFont: string;
  isConnected: boolean;
  // Optional live preview: if the player has artwork loaded, settings can
  // render it at the slider's current strength so the user can see the
  // change instantly instead of waiting for the next track.
  musicPreview?: {
    img: HTMLImageElement | null;
    render: (canvas: HTMLCanvasElement, img: HTMLImageElement, strength: number) => void;
  };
}

export const DEFAULT_BG_COLOR = '#2e2f38';
// Defaults for the bubble colours — picked from the existing palette
// so out-of-the-box bubbles match the rest of the UI before the user
// customises.
export const DEFAULT_BUBBLE_USER  = '#3a3b45';
export const DEFAULT_BUBBLE_AGENT = '#2a3a36';
export const DEFAULT_BUBBLE_BOSS  = '#3a2f1a';

type SaveCallback = (key: string, value: string) => void;

export function openSettingsModal(current: SettingsModalState, onSave: SaveCallback) {
  document.querySelector('.settings-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';

  const modal = document.createElement('div');
  modal.className = 'settings-modal';

  const title = document.createElement('div');
  title.className = 'settings-title';
  title.textContent = 'settings';
  modal.appendChild(title);

  // --- Tab bar -----------------------------------------------------------
  const tabBar = document.createElement('div');
  tabBar.className = 'settings-tabs';
  const body = document.createElement('div');
  body.className = 'settings-tab-body';

  type Tab = { id: string; label: string; build: () => HTMLElement[] };
  const tabs: Tab[] = [
    { id: 'appearance', label: 'appearance', build: () => buildAppearanceTab(current, onSave) },
    { id: 'player',     label: 'player',     build: () => buildPlayerTab(current, onSave) },
    { id: 'linear',     label: 'linear',     build: () => buildLinearTab(current, onSave) },
    { id: 'general',    label: 'general',    build: () => buildGeneralTab(current, onSave) },
  ];

  let activeTab = tabs[0].id;
  const tabBtns = new Map<string, HTMLElement>();
  const renderTab = () => {
    body.innerHTML = '';
    const tab = tabs.find((t) => t.id === activeTab) ?? tabs[0];
    for (const row of tab.build()) body.appendChild(row);
    for (const [id, btn] of tabBtns) btn.classList.toggle('active', id === activeTab);
  };

  for (const t of tabs) {
    const btn = document.createElement('div');
    btn.className = 'settings-tab';
    btn.textContent = t.label;
    btn.addEventListener('click', () => { activeTab = t.id; renderTab(); });
    tabBar.appendChild(btn);
    tabBtns.set(t.id, btn);
  }
  modal.appendChild(tabBar);
  modal.appendChild(body);
  renderTab();

  // --- Close ---
  const closeBtn = document.createElement('div');
  closeBtn.className = 'settings-close';
  closeBtn.textContent = 'close';
  closeBtn.addEventListener('click', () => overlay.remove());
  modal.appendChild(closeBtn);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}

// --- Tab builders ------------------------------------------------------

function buildAppearanceTab(current: SettingsModalState, onSave: SaveCallback): HTMLElement[] {
  return [
    colorRow(
      'background',
      current.bgColor || DEFAULT_BG_COLOR,
      DEFAULT_BG_COLOR,
      (v) => onSave('bgColor', v),
    ),
    toggleRow('hide avatars', current.avatarsHidden, '●', '○', (on) => {
      onSave('avatarsHidden', on ? '1' : '0');
    }),
    toggleRow('minimalist frames', current.agentsMinimal, '●', '○', (on) => {
      onSave('agentsMinimal', on ? '1' : '0');
    }),
    selectRow('chat lanes', current.lanesVertical ? 'vertical' : 'horizontal', [
      { value: 'horizontal', label: 'horizontal (wide monitor)' },
      { value: 'vertical',   label: 'vertical (tall monitor)' },
    ], (v) => onSave('lanesVertical', v === 'vertical' ? '1' : '0')),
    toggleRow('chat bubbles', current.chatBubbles, '●', '○', (on) => {
      onSave('chatBubbles', on ? '1' : '0');
    }),
    // Curated Google-Fonts dropdown — applies to #chat-input,
    // #chat-response, and every .lane-input. The picked font is
    // lazy-loaded via a <link> insert on first use; subsequent picks
    // skip the network. See ui/chat-fonts.ts for the curated list.
    selectRow(
      'chat font',
      current.chatFont,
      CHAT_FONTS.map((f) => ({ value: f.id, label: f.label })),
      (v) => onSave('chatFont', v),
    ),
    // Per-bubble colour pickers, only rendered when bubbles are on.
    // Filtered out of the row list when chatBubbles is false so they
    // don't clutter the panel. (The native color picker on macOS
    // exposes the full color wheel including alpha, so opacity is
    // already accessible without a dedicated slider.)
    ...(current.chatBubbles ? [
      colorRow(
        'bubble · you',
        current.bubbleUserColor || DEFAULT_BUBBLE_USER,
        DEFAULT_BUBBLE_USER,
        (v) => onSave('bubbleUserColor', v),
      ),
      colorRow(
        'bubble · agent',
        current.bubbleAgentColor || DEFAULT_BUBBLE_AGENT,
        DEFAULT_BUBBLE_AGENT,
        (v) => onSave('bubbleAgentColor', v),
      ),
      colorRow(
        'bubble · boss',
        current.bubbleBossColor || DEFAULT_BUBBLE_BOSS,
        DEFAULT_BUBBLE_BOSS,
        (v) => onSave('bubbleBossColor', v),
      ),
    ] : []),
    actionRow('agent colors', 'reset', (btn) => {
      onSave('resetAgentColors', '1');
      btn.textContent = 'done';
      setTimeout(() => (btn.textContent = 'reset'), 1200);
    }),
    toggleRow('notify on agent finish', current.notifyOnFinish, '●', '○', (on) => {
      onSave('notifyOnFinish', on ? '1' : '0');
    }),
  ];
}

function buildPlayerTab(current: SettingsModalState, onSave: SaveCallback): HTMLElement[] {
  return [
    toggleRow('music player', current.musicEnabled, '●', '○', (on) => {
      onSave('musicEnabled', on ? '1' : '0');
    }),
    selectRow('source', current.musicSource, [
      { value: 'auto', label: 'auto (whichever is playing)' },
      { value: 'spotify', label: 'spotify' },
      { value: 'apple-music', label: 'apple music' },
    ], (v) => onSave('musicSource', v)),
    selectRow('style', current.musicStyle, [
      { value: 'framed', label: 'framed cover' },
      { value: 'banner', label: 'stretched banner' },
      { value: 'frame', label: 'agent frame' },
      { value: 'cover', label: 'agent frame (cover)' },
    ], (v) => onSave('musicStyle', v)),
    ditherRow(current.musicDither, current.musicPreview, (v) => onSave('musicDither', v)),
    toggleRow('lyrics', current.musicLyrics, '●', '○', (on) => {
      onSave('musicLyrics', on ? '1' : '0');
    }),
    actionRow('access', 'grant', async (btn) => {
      btn.textContent = 'requesting…';
      try {
        const src = current.musicSource && current.musicSource !== 'auto' ? '?source=' + encodeURIComponent(current.musicSource) : '';
        const r = await fetch('/api/spotify/request-access' + src, { method: 'POST' });
        btn.textContent = r.ok ? 'granted' : 'failed';
      } catch {
        btn.textContent = 'failed';
      }
      setTimeout(() => (btn.textContent = 'grant'), 1500);
    }),
  ];
}

function buildLinearTab(current: SettingsModalState, onSave: SaveCallback): HTMLElement[] {
  return [
    toggleRow('tickets panel', current.linearEnabled, '●', '○', (on) => {
      onSave('linearEnabled', on ? '1' : '0');
    }),
    secretInputRow(
      'api key',
      current.linearApiKey,
      'lin_api_...',
      'https://linear.app/settings/account/security',
      (v) => onSave('linearApiKey', v),
    ),
    linearTestRow(),
  ];
}

// Test-connection row for the Linear API key. Hits /api/linear/test
// (which calls Linear's `viewer` query with the saved key) so the user
// can confirm the key works and surface the authenticated account.
// The row itself displays inline status — no toast, no modal.
function linearTestRow(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-row';

  const label = document.createElement('label');
  label.textContent = 'connection';
  label.className = 'settings-label';

  const right = document.createElement('span');
  right.className = 'settings-conn-value';

  const status = document.createElement('span');
  status.className = 'settings-conn-state';
  status.textContent = 'untested';

  const btn = document.createElement('span');
  btn.className = 'settings-action-btn';
  btn.textContent = 'test';
  btn.addEventListener('click', async () => {
    if (btn.textContent === 'testing…') return;
    btn.textContent = 'testing…';
    status.textContent = '';
    try {
      const r = await fetch('/api/linear/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await r.json().catch(() => ({} as Record<string, unknown>));
      if (r.ok && data && (data as { ok?: boolean }).ok) {
        const name = (data as { name?: string }).name || '';
        const email = (data as { email?: string }).email || '';
        status.textContent = '✓ ' + (name ? name + (email ? ' (' + email + ')' : '') : 'connected');
        row.classList.add('connected');
        row.classList.remove('disconnected');
      } else {
        const err = (data as { error?: string }).error || ('http ' + r.status);
        status.textContent = '✗ ' + err;
        row.classList.add('disconnected');
        row.classList.remove('connected');
      }
    } catch (e) {
      status.textContent = '✗ ' + ((e as Error).message || 'request failed');
      row.classList.add('disconnected');
      row.classList.remove('connected');
    } finally {
      btn.textContent = 'test';
    }
  });

  right.appendChild(status);
  right.appendChild(btn);

  row.appendChild(label);
  row.appendChild(right);
  return row;
}

function buildGeneralTab(current: SettingsModalState, onSave: SaveCallback): HTMLElement[] {
  // WebSocket status row. The dot + label live-update via the
  // conn.onStateChange handler in main.ts as long as this row is in the DOM.
  const connRow = document.createElement('div');
  connRow.className = 'settings-row';
  connRow.id = 'settings-conn-row';
  connRow.classList.toggle('connected', current.isConnected);
  connRow.classList.toggle('disconnected', !current.isConnected);

  const connLabel = document.createElement('label');
  connLabel.textContent = 'websocket';
  connLabel.className = 'settings-label';

  const connValue = document.createElement('span');
  connValue.className = 'settings-conn-value';
  const connDot = document.createElement('span');
  connDot.className = 'settings-conn-dot';
  const connState = document.createElement('span');
  connState.className = 'settings-conn-state';
  connState.textContent = current.isConnected ? 'connected' : 'reconnecting…';
  connValue.appendChild(connDot);
  connValue.appendChild(connState);

  connRow.appendChild(connLabel);
  connRow.appendChild(connValue);

  return [
    connRow,
    selectRow('terminal app', current.terminalApp, [
      { value: 'terminal', label: 'Terminal.app' },
      { value: 'iterm2',   label: 'iTerm2' },
    ], (v) => onSave('terminalApp', v)),
    diagnosticsRow(),
  ];
}

// Renders the preflight (dependency health) status as a settings row.
// Live-subscribes to preflight updates so the dot/text stay current
// while the panel is open. Clicking "view details" opens the same
// diagnostics modal the floating pill used to. Auto-refreshes once
// when the row is built so a cold-opened panel doesn't show "..."
// for the 30 s until the next poll.
function diagnosticsRow(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-row settings-diagnostics-row';

  const label = document.createElement('label');
  label.textContent = 'diagnostics';
  label.className = 'settings-label';

  const value = document.createElement('span');
  value.className = 'settings-diagnostics-value';

  const dot = document.createElement('span');
  dot.className = 'settings-diagnostics-dot';
  const text = document.createElement('span');
  text.className = 'settings-diagnostics-text';
  text.textContent = '…';

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'settings-diagnostics-view';
  viewBtn.textContent = 'view details';
  viewBtn.addEventListener('click', () => openPreflightModal());

  value.appendChild(dot);
  value.appendChild(text);
  value.appendChild(viewBtn);

  const apply = (r: ReturnType<typeof getPreflightReport>, err: string | undefined) => {
    if (err && !r) {
      row.dataset.status = 'error';
      text.textContent = 'unreachable';
      viewBtn.disabled = true;
      return;
    }
    if (!r) {
      row.dataset.status = 'pending';
      text.textContent = '…';
      viewBtn.disabled = true;
      return;
    }
    row.dataset.status = r.status;
    if (r.errorCount > 0) {
      text.textContent = `${r.errorCount} error${r.errorCount === 1 ? '' : 's'}`;
    } else if (r.warnCount > 0) {
      text.textContent = `${r.warnCount} warning${r.warnCount === 1 ? '' : 's'}`;
    } else {
      text.textContent = 'ok';
    }
    viewBtn.disabled = false;
  };

  // Subscribe to live updates. The returned unsub is invoked when the
  // row is detached from the DOM so we don't leak a callback after the
  // settings modal closes.
  const unsubscribe = onPreflightChange((r, err) => apply(r, err));
  const obs = new MutationObserver(() => {
    if (!document.contains(row)) {
      unsubscribe();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Kick a fresh refresh so the panel feels current even if the poll
  // tick is far off.
  void refreshPreflight();

  row.appendChild(label);
  row.appendChild(value);
  return row;
}

function sectionHeader(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-section';
  el.textContent = text;
  return el;
}

function toggleRow(
  labelText: string,
  initial: boolean,
  onGlyph: string,
  offGlyph: string,
  onChange: (on: boolean) => void,
): HTMLElement {
  let on = initial;
  const row = document.createElement('div');
  row.className = 'settings-row';

  const label = document.createElement('label');
  label.textContent = labelText;
  label.className = 'settings-label';

  const btn = document.createElement('span');
  btn.className = 'settings-toggle';
  btn.textContent = on ? onGlyph : offGlyph;
  btn.classList.toggle('active', on);

  const flip = () => {
    on = !on;
    btn.textContent = on ? onGlyph : offGlyph;
    btn.classList.toggle('active', on);
    onChange(on);
  };

  btn.addEventListener('click', flip);
  // Clicking the label also flips so the whole row feels clickable.
  label.style.cursor = 'pointer';
  label.addEventListener('click', flip);

  row.appendChild(label);
  row.appendChild(btn);
  return row;
}

function selectRow(
  labelText: string,
  initial: string,
  options: { value: string; label: string }[],
  onChange: (v: string) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-row';

  const label = document.createElement('label');
  label.textContent = labelText;
  label.className = 'settings-label';

  const select = document.createElement('select');
  select.className = 'settings-select';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    o.selected = initial === opt.value;
    select.appendChild(o);
  }
  select.addEventListener('change', () => onChange(select.value));

  row.appendChild(label);
  row.appendChild(select);
  return row;
}

// Dither row with a live preview canvas: drags the slider and re-renders
// the current artwork at the requested strength, so the user sees exactly
// what they're picking.
function ditherRow(
  initial: string,
  preview: SettingsModalState['musicPreview'],
  onChange: (v: string) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-row';

  const label = document.createElement('label');
  label.textContent = 'dither';
  label.className = 'settings-label';

  const wrap = document.createElement('div');
  wrap.className = 'settings-slider-wrap';

  const previewCanvas = document.createElement('canvas');
  previewCanvas.className = 'settings-dither-preview';

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'settings-slider';
  input.min = '0';
  input.max = '10';
  input.step = '0.5';
  const parsed = parseFloat(initial);
  input.value = isFinite(parsed) ? String(parsed)
    : initial === 'subtle' ? '1'
    : initial === 'brutal' ? '10'
    : '6';

  const value = document.createElement('span');
  value.className = 'settings-slider-value';
  value.textContent = input.value;

  const renderPreview = () => {
    if (!preview || !preview.img) return;
    try { preview.render(previewCanvas, preview.img, parseFloat(input.value)); } catch {}
  };

  input.addEventListener('input', () => {
    value.textContent = input.value;
    onChange(input.value);
    renderPreview();
  });

  // Hide the preview canvas if there's no artwork to show yet.
  if (!preview || !preview.img) {
    previewCanvas.style.display = 'none';
  } else {
    // Initial paint after the modal is inserted into the DOM.
    setTimeout(renderPreview, 0);
  }

  wrap.appendChild(previewCanvas);
  wrap.appendChild(input);
  wrap.appendChild(value);
  row.appendChild(label);
  row.appendChild(wrap);
  return row;
}

function sliderRow(
  labelText: string,
  initial: string,
  min: number,
  max: number,
  step: number,
  onChange: (v: string) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-row';

  const label = document.createElement('label');
  label.textContent = labelText;
  label.className = 'settings-label';

  const wrap = document.createElement('div');
  wrap.className = 'settings-slider-wrap';

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'settings-slider';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  // Legacy preset names fall back to sane midpoints.
  const parsed = parseFloat(initial);
  input.value = isFinite(parsed) ? String(parsed)
    : initial === 'subtle' ? '1'
    : initial === 'brutal' ? '10'
    : '6';

  const value = document.createElement('span');
  value.className = 'settings-slider-value';
  value.textContent = input.value;

  input.addEventListener('input', () => {
    value.textContent = input.value;
    onChange(input.value);
  });

  wrap.appendChild(input);
  wrap.appendChild(value);
  row.appendChild(label);
  row.appendChild(wrap);
  return row;
}

// Password-style input with a "get key" link next to the label, used for
// third-party tokens like the Linear personal API key. Saves on blur so the
// user doesn't fire a settings write on every keystroke.
function secretInputRow(
  labelText: string,
  initial: string,
  placeholder: string,
  getUrl: string,
  onChange: (v: string) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-row';

  const label = document.createElement('label');
  label.className = 'settings-label';

  const labelText1 = document.createElement('span');
  labelText1.textContent = labelText;
  label.appendChild(labelText1);

  if (getUrl) {
    const link = document.createElement('a');
    link.href = getUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'get';
    link.className = 'settings-label-link';
    label.appendChild(link);
  }

  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'settings-input';
  input.placeholder = placeholder;
  input.value = initial || '';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.addEventListener('blur', () => {
    if (input.value !== (initial || '')) onChange(input.value.trim());
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });

  row.appendChild(label);
  row.appendChild(input);
  return row;
}

function actionRow(
  labelText: string,
  buttonText: string,
  onClick: (btn: HTMLElement) => void | Promise<void>,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-row';

  const label = document.createElement('label');
  label.textContent = labelText;
  label.className = 'settings-label';

  const btn = document.createElement('span');
  btn.className = 'settings-action-btn';
  btn.textContent = buttonText;
  btn.addEventListener('click', () => { onClick(btn); });

  row.appendChild(label);
  row.appendChild(btn);
  return row;
}

// Color-picker row: native <input type=color> + a hex text-input that
// stays in sync, plus a "reset" link that returns to the supplied
// default. onChange fires on color-input change AND on hex blur, so
// the user can pick visually or type a precise hex.
function colorRow(
  labelText: string,
  initial: string,
  defaultValue: string,
  onChange: (v: string) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-row';

  const label = document.createElement('label');
  label.textContent = labelText;
  label.className = 'settings-label';

  const wrap = document.createElement('div');
  wrap.className = 'settings-color-wrap';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'settings-color-input';
  colorInput.value = normalizeHex(initial) || defaultValue;

  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.className = 'settings-color-hex';
  hexInput.value = colorInput.value;
  hexInput.spellcheck = false;
  hexInput.autocomplete = 'off';

  const reset = document.createElement('span');
  reset.className = 'settings-color-reset';
  reset.textContent = 'reset';

  const apply = (v: string, propagate: boolean) => {
    const hex = normalizeHex(v);
    if (!hex) return;
    colorInput.value = hex;
    hexInput.value = hex;
    if (propagate) onChange(hex);
  };

  colorInput.addEventListener('input', () => apply(colorInput.value, true));
  hexInput.addEventListener('blur', () => apply(hexInput.value, true));
  hexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') hexInput.blur();
  });
  reset.addEventListener('click', () => apply(defaultValue, true));

  wrap.appendChild(colorInput);
  wrap.appendChild(hexInput);
  wrap.appendChild(reset);
  row.appendChild(label);
  row.appendChild(wrap);
  return row;
}

// Coerce a user-entered string into a valid 7-char #RRGGBB hex, or
// return null if it's unusable. Accepts forms with or without `#`.
function normalizeHex(v: string): string | null {
  const s = v.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(s)) return '#' + s;
  if (/^[0-9a-f]{3}$/.test(s)) return '#' + s.split('').map((c) => c + c).join('');
  return null;
}

// Backwards-compat re-export for any callsite still importing Settings.
export type Settings = { terminalApp: string; linearApiKey?: string };
