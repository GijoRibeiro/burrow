// Per-section content-scale controls. Independent of the layout tree:
// these buttons control how big the *content* of a section renders,
// not how much room the section gets on screen (that's the divider's
// job). Sections set a CSS custom property and their own stylesheet
// uses `calc(Npx * var(--scale))` to react.
//
// Restored from the old section-drag.ts after the layout rewrite.
// `active-agents-bar` lives inside #chat-lanes (not a top-level
// layout leaf) so its buttons attach directly here — the layout
// chrome wouldn't see it.

interface ScaleConfig {
  storageKey: string;
  apply: (el: HTMLElement, scale: number) => void;
  min?: number;
  max?: number;
}

const SCALE_CONFIG: Record<string, ScaleConfig> = {
  // Agent-grid uses --user-scale (the slider) and composes it with the
  // mode-specific scale factor in CSS to produce --ui-scale (the value
  // every descendant calc reads). Earlier we wrote --ui-scale directly,
  // but `.agent-frame` modes redefine --ui-scale to 0.7 / 0.85, which
  // SHADOWED the user's value — the buttons appeared to do nothing.
  'agent-grid':        { storageKey: 'agentsScale',       apply: (el, s) => el.style.setProperty('--user-scale', String(s)) },
  // Music bar allows a larger max — non-artwork elements have their
  // own px caps in CSS (min(calc, …)) so only the album cover keeps
  // growing past 2.0. Caps the overall at 4.
  'music-bar':         { storageKey: 'musicScale',        apply: (el, s) => el.style.setProperty('--music-scale', String(s)), max: 4 },
  'active-agents-bar': { storageKey: 'activeAgentsScale', apply: (el, s) => el.style.setProperty('--ui-scale', String(s)) },
  'linear-panel':      { storageKey: 'linearScale',       apply: (el, s) => el.style.setProperty('--linear-scale', String(s)) },
};

const MIN_DEFAULT = 0.5;
const MAX_DEFAULT = 2;
const STEP = 0.1;

function clampScale(v: number, cfg: ScaleConfig): number {
  const min = cfg.min ?? MIN_DEFAULT;
  const max = cfg.max ?? MAX_DEFAULT;
  return Math.min(max, Math.max(min, Math.round(v * 10) / 10));
}

function applySectionScale(section: HTMLElement): number {
  const cfg = SCALE_CONFIG[section.id];
  if (!cfg) return 1;
  const raw = parseFloat(localStorage.getItem(cfg.storageKey) || '1');
  const scale = clampScale(isFinite(raw) ? raw : 1, cfg);
  cfg.apply(section, scale);
  return scale;
}

function attachOne(section: HTMLElement): void {
  if (section.dataset.sizeControls === '1') return;
  const cfg = SCALE_CONFIG[section.id];
  if (!cfg) return;
  section.dataset.sizeControls = '1';
  let scale = applySectionScale(section);

  const make = (text: string, title: string, cls: string, onClick: () => void): HTMLElement => {
    const el = document.createElement('span');
    el.className = 'section-size-btn ' + cls;
    el.textContent = text;
    el.title = title;
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return el;
  };

  const update = (next: number): void => {
    scale = clampScale(next, cfg);
    cfg.apply(section, scale);
    localStorage.setItem(cfg.storageKey, String(scale));
  };

  section.appendChild(make('−', 'smaller', 'section-size-minus', () => update(scale - STEP)));
  section.appendChild(make('+', 'bigger',  'section-size-plus',  () => update(scale + STEP)));
}

// Attach size controls to every configured section currently in the
// document, then watch for new ones (music-bar / linear-panel are
// appended after their feature toggles fire). Idempotent — calling
// twice is fine.
export function initSectionScales(host: HTMLElement = document.body): void {
  for (const id of Object.keys(SCALE_CONFIG)) {
    const el = document.getElementById(id);
    if (el) attachOne(el);
  }
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        if (SCALE_CONFIG[n.id]) attachOne(n);
        // Configured section might be a descendant (e.g., music-bar
        // appended into #app, then later moved into a layout wrapper).
        for (const id of Object.keys(SCALE_CONFIG)) {
          const inside = n.querySelector?.<HTMLElement>('#' + CSS.escape(id));
          if (inside) attachOne(inside);
        }
      });
    }
  });
  obs.observe(host, { childList: true, subtree: true });
}
