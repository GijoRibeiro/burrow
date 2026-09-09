// Visually distinct colors spread across the hue wheel. Assignment is
// NOT by declaration order — `agentColor` uses farthest-point hue
// selection so the Nth agent's color is maximally far in hue from every
// previously-assigned one. That means two agents never collide on
// near-identical hues (e.g. the old "two greens" case).
//
// Originally had four green-ish entries (yellow-green, green, mint,
// spring). Two of them got picked for adjacent agents and read as
// "the same color" — farthest-point can still cluster when the
// palette itself has clusters. Dropped `#a0ffb8 spring` and
// `#5add9e mint` so the green region only has two well-separated
// entries (yellow-green ~75°, green ~120°), and replaced them with
// a teal and a brighter purple to fill the wheel more evenly.
export const AGENT_COLORS = [
  '#ff7b7b', // red
  '#5cd9cd', // cyan
  '#ff9e5a', // orange
  '#6d8aff', // blue
  '#ffc955', // amber
  '#9a7dff', // indigo
  '#e8e05a', // yellow
  '#c67dff', // violet
  '#b4e05a', // yellow-green
  '#e77afc', // magenta
  '#6edc6e', // green
  '#ff7ac6', // pink
  '#3aa0c4', // teal
  '#ff7a8a', // rose
  '#5cb6e6', // sky blue
  '#ffb066', // tangerine
  '#7ae0d0', // aqua
  '#d38aff', // lilac
  '#e0e0a0', // cream
  '#b07cff', // purple
];

// HSV/HSL hue per palette entry (0–360). Hue is the dominant perceptual
// cue for color distinctness — near-identical hues read as "same color"
// even with different lightness/saturation, which is exactly the
// "two greens" failure mode we're avoiding.
function hueOf(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r)      h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  return h * 60;
}

const PALETTE_HUES = AGENT_COLORS.map(hueOf);

// Shortest angular distance on the hue wheel (0–180).
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const STORAGE_KEY = 'agentColorAssignments';

// Bumped when the palette changes shape (entries added/removed/replaced).
// On load, if the stored migration version is older than this, the
// existing assignments are dropped so every agent re-picks using the
// current palette + farthest-point logic. Keeps the algorithm honest
// instead of carrying over indices into a different palette.
const MIGRATION_KEY = 'agentColorAssignmentsMigration';
const MIGRATION_VERSION = '2';

function loadAssignments(): Record<string, number> {
  try {
    if (localStorage.getItem(MIGRATION_KEY) !== MIGRATION_VERSION) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(MIGRATION_KEY, MIGRATION_VERSION);
      return {};
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const assignments: Record<string, number> = loadAssignments();

function saveAssignments() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(assignments));
  } catch {
    // Quota exceeded or private mode — color will just re-pick next load.
  }
}

export function agentColor(key: string): string {
  const existing = assignments[key];
  if (existing !== undefined) {
    return AGENT_COLORS[existing % AGENT_COLORS.length];
  }

  const used = new Set<number>(Object.values(assignments));
  const usedHues = [...used].map((i) => PALETTE_HUES[i]);

  // Farthest-point sampling: pick the unused palette entry whose hue is
  // maximally far from the nearest already-assigned hue. If nothing is
  // assigned yet, every candidate scores the sentinel max, and we fall
  // through to the first unused (red) for stable first assignment.
  let chosen = -1;
  let bestScore = -1;
  for (let i = 0; i < AGENT_COLORS.length; i++) {
    if (used.has(i)) continue;
    let minDist = 360;
    for (const h of usedHues) {
      const d = hueDist(PALETTE_HUES[i], h);
      if (d < minDist) minDist = d;
    }
    if (minDist > bestScore) {
      bestScore = minDist;
      chosen = i;
    }
  }

  // Palette exhausted (21+ agents). Fall back to a deterministic hash.
  if (chosen < 0) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    chosen = Math.abs(hash) % AGENT_COLORS.length;
  }

  assignments[key] = chosen;
  saveAssignments();
  return AGENT_COLORS[chosen];
}

// Reset all agent color assignments. Use when existing assignments are
// cramped (e.g. pre-algorithm saves landed on two greens) so agents
// re-pick using the current farthest-point logic.
export function resetAgentColors(): void {
  for (const k of Object.keys(assignments)) delete assignments[k];
  saveAssignments();
}
