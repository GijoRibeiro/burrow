// XP = totalCommits + bonusXP. Accumulates forever.
// Level thresholds — no cap. After the table, each level needs 50 more XP
// than the previous gap.
const LEVEL_TABLE = [0, 5, 15, 30, 50, 80, 120, 170, 230, 300, 380, 470, 570, 680, 800, 930, 1070, 1220, 1380, 1550];

export function getThreshold(level: number): number {
  if (level <= LEVEL_TABLE.length) return LEVEL_TABLE[level - 1];
  const lastGap = LEVEL_TABLE[LEVEL_TABLE.length - 1] - LEVEL_TABLE[LEVEL_TABLE.length - 2];
  let total = LEVEL_TABLE[LEVEL_TABLE.length - 1];
  const levelsAfter = level - LEVEL_TABLE.length;
  for (let i = 1; i <= levelsAfter; i++) {
    total += lastGap + (i * 50);
  }
  return total;
}

export interface LevelInfo {
  level: number;
  xp: number;
  nextXp: number;
  progress: number;
}

export function getLevel(xp: number): LevelInfo {
  let level = 1;
  while (getThreshold(level + 1) <= xp) level++;
  const currentThreshold = getThreshold(level);
  const nextThreshold = getThreshold(level + 1);
  const progress = (xp - currentThreshold) / (nextThreshold - currentThreshold);
  return { level, xp, nextXp: nextThreshold, progress: Math.min(1, progress) };
}

// Color tiers by level milestone
const LEVEL_COLORS: [number, string][] = [
  [90, '#ffcc22'],
  [80, '#ff8844'],
  [70, '#e06a5a'],
  [60, '#e0aa5a'],
  [50, '#e08aaa'],
  [40, '#b08ae0'],
  [30, '#7ab4e0'],
  [20, '#8ad4c8'],
  [10, '#c8d89a'],
  [0,  '#eae5ce'],
];

export function levelColor(level: number): string {
  for (const [threshold, color] of LEVEL_COLORS) {
    if (level >= threshold) return color;
  }
  return '#eae5ce';
}
