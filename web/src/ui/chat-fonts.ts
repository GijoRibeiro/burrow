// Curated list of Google Fonts available for the chat surfaces
// (settings → appearance → chat font). The full Google catalogue has
// ~1700 families; this is a deliberately short, opinionated subset
// chosen for readability in mixed-content chat (prose + code blocks
// + agent output).
//
// Categories the picker mixes:
//   monospace  — the canonical "coding" stack. Best for agents whose
//                output is code-heavy. Defaults sit here.
//   sans       — modern UI sans for users who'd rather read prose at
//                a smaller size than monospace allows.
//   pixel      — fits the retro pixel-art frame around the rest of
//                the UI. Smaller character set, decorative.
//   terminal   — chunky CRT/terminal styles. Decorative but legible.
//
// `family` is what shows up in `font-family`. `id` is the stable
// localStorage key + Google CSS URL slug (so "JetBrains Mono" →
// `JetBrains+Mono`). `stack` is the full fallback chain we write
// into the --chat-font CSS variable. `system: true` skips the
// network fetch — these fonts ship with the project locally.

export interface ChatFont {
  id: string;
  family: string;
  label: string;
  category: 'monospace' | 'sans' | 'pixel' | 'terminal';
  stack: string;
  // system fonts (already loaded via @font-face or built into the OS)
  // skip the Google Fonts <link> insert.
  system?: boolean;
}

export const DEFAULT_CHAT_FONT_ID = 'jetbrains-mono';

export const CHAT_FONTS: ChatFont[] = [
  // --- monospace (coding) — sensible defaults for engineer eyes ---
  {
    id: 'jetbrains-mono',
    family: 'JetBrains Mono',
    label: 'JetBrains Mono · code',
    category: 'monospace',
    stack: `'JetBrains Mono', 'Menlo', monospace`,
  },
  {
    id: 'fira-code',
    family: 'Fira Code',
    label: 'Fira Code · ligatures',
    category: 'monospace',
    stack: `'Fira Code', 'Menlo', monospace`,
  },
  {
    id: 'ibm-plex-mono',
    family: 'IBM Plex Mono',
    label: 'IBM Plex Mono · code',
    category: 'monospace',
    stack: `'IBM Plex Mono', 'Menlo', monospace`,
  },
  {
    id: 'source-code-pro',
    family: 'Source Code Pro',
    label: 'Source Code Pro · code',
    category: 'monospace',
    stack: `'Source Code Pro', 'Menlo', monospace`,
  },
  {
    id: 'space-mono',
    family: 'Space Mono',
    label: 'Space Mono · retro code',
    category: 'monospace',
    stack: `'Space Mono', 'Menlo', monospace`,
  },
  {
    id: 'roboto-mono',
    family: 'Roboto Mono',
    label: 'Roboto Mono · code',
    category: 'monospace',
    stack: `'Roboto Mono', 'Menlo', monospace`,
  },

  // --- sans (chat / prose) — for users who want a softer read ---
  {
    id: 'inter',
    family: 'Inter',
    label: 'Inter · chat',
    category: 'sans',
    stack: `'Inter', system-ui, sans-serif`,
  },
  {
    id: 'ibm-plex-sans',
    family: 'IBM Plex Sans',
    label: 'IBM Plex Sans · chat',
    category: 'sans',
    stack: `'IBM Plex Sans', system-ui, sans-serif`,
  },
  {
    id: 'dm-sans',
    family: 'DM Sans',
    label: 'DM Sans · chat',
    category: 'sans',
    stack: `'DM Sans', system-ui, sans-serif`,
  },
  {
    id: 'space-grotesk',
    family: 'Space Grotesk',
    label: 'Space Grotesk · chat',
    category: 'sans',
    stack: `'Space Grotesk', system-ui, sans-serif`,
  },

  // --- terminal / retro — fits the pixel UI aesthetic ---
  {
    id: 'vt323',
    family: 'VT323',
    label: 'VT323 · terminal',
    category: 'terminal',
    stack: `'VT323', 'Courier New', monospace`,
  },
  {
    id: 'share-tech-mono',
    family: 'Share Tech Mono',
    label: 'Share Tech Mono · CRT',
    category: 'terminal',
    stack: `'Share Tech Mono', 'Courier New', monospace`,
  },
  {
    id: 'major-mono',
    family: 'Major Mono Display',
    label: 'Major Mono · display',
    category: 'terminal',
    stack: `'Major Mono Display', 'Courier New', monospace`,
  },

  // --- pixel — matches the rest of the retro UI ---
  {
    id: 'pixelify-sans',
    family: 'Pixelify Sans',
    label: 'Pixelify Sans · pixel',
    category: 'pixel',
    stack: `'Pixelify Sans', 'Gridbit', monospace`,
  },
  {
    id: 'silkscreen',
    family: 'Silkscreen',
    label: 'Silkscreen · pixel',
    category: 'pixel',
    stack: `'Silkscreen', 'Gridbit', monospace`,
  },
  {
    id: 'press-start',
    family: 'Press Start 2P',
    label: 'Press Start 2P · 8-bit',
    category: 'pixel',
    stack: `'Press Start 2P', 'Gridbit', monospace`,
  },

  // --- system (already bundled with the project, no network fetch) ---
  {
    id: 'gridbit',
    family: 'Gridbit',
    label: 'Gridbit · system',
    category: 'pixel',
    stack: `'Gridbit', 'PixelPurl', 'Courier New', monospace`,
    system: true,
  },
];

export function findChatFont(id: string): ChatFont | undefined {
  return CHAT_FONTS.find((f) => f.id === id);
}

// Track which Google Font families have already been fetched in this
// session so we don't append duplicate <link> tags on repeated picks.
const loadedFamilies = new Set<string>();

// Inject a `<link rel="stylesheet">` to Google Fonts for the given
// family, then resolve the `--chat-font` CSS variable on :root to the
// font's full fallback stack. The font swap is immediate (the stack
// degrades to the fallback while the .woff2 is in flight, then
// upgrades on load — fonts.googleapis.com sends `font-display: swap`
// by default). System fonts skip the network call.
export function applyChatFont(id: string): void {
  const font = findChatFont(id) ?? findChatFont(DEFAULT_CHAT_FONT_ID)!;
  if (!font.system && !loadedFamilies.has(font.family)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    // `display=swap` ensures we see the fallback stack immediately
    // and the picked font fades in once the .woff2 arrives, instead
    // of leaving the user staring at invisible text (FOIT).
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font.family).replace(/%20/g, '+')}&display=swap`;
    document.head.appendChild(link);
    loadedFamilies.add(font.family);
  }
  document.documentElement.style.setProperty('--chat-font', font.stack);
}
