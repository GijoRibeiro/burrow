const API_BASE = 'http://localhost:3333';

export interface Profile {
  name: string;
  creatureIndex: number;
  creatureAssigned?: boolean;
  bonusXP: number;
}

const cache: Record<string, Profile> = {};

export async function loadAllProfiles() {
  try {
    const resp = await fetch(`${API_BASE}/api/profiles`);
    const data = await resp.json();
    Object.assign(cache, data);
  } catch { /* ignore — profiles will load lazily */ }
}

export function getProfile(cwd: string): Profile {
  return cache[cwd] || { name: '', creatureIndex: 0, bonusXP: 0 };
}

export function displayName(cwd: string): string {
  if (!cwd) return '';
  const parts = cwd.split('/');
  return cache[cwd]?.name || parts[parts.length - 1];
}

function postProfile(cwd: string, action: string, payload: Record<string, unknown>) {
  fetch(`${API_BASE}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, action, ...payload }),
  }).then(r => r.json()).then(p => { cache[cwd] = p; });
}

export function saveCreatureAssignment(cwd: string, creatureIndex: number) {
  cache[cwd] = { ...getProfile(cwd), creatureIndex, creatureAssigned: true };
  postProfile(cwd, 'setCreature', { creatureIndex });
}

export function loadCreatureAssignment(cwd: string): number | null {
  const p = getProfile(cwd);
  return p.creatureIndex || null;
}

// resolveCreatureIndex is the single source of truth for which creature an
// agent shows — used by BOTH the agent frame and the chat badge so they can't
// diverge. If the agent already has a creature assigned, returns it. Otherwise
// (a brand-new agent) it assigns a RANDOM creature once, persists it, and
// returns it — so the first render is consistent everywhere instead of the
// frame showing a rotating counter while chat showed creature 0.
export function resolveCreatureIndex(cwd: string, count: number): number {
  if (count <= 0) return 0;
  const p = getProfile(cwd);
  if (p.creatureAssigned) {
    return ((p.creatureIndex % count) + count) % count;
  }
  const idx = Math.floor(Math.random() * count);
  saveCreatureAssignment(cwd, idx); // persists + flips creatureAssigned in the cache
  return idx;
}

export function saveAgentName(cwd: string, name: string) {
  cache[cwd] = { ...getProfile(cwd), name };
  postProfile(cwd, 'setName', { name });
}

export function loadAgentName(cwd: string): string | null {
  return getProfile(cwd).name || null;
}

export function addBonusXP(cwd: string, amount: number) {
  const p = getProfile(cwd);
  cache[cwd] = { ...p, bonusXP: p.bonusXP + amount };
  postProfile(cwd, 'addXP', { xp: amount });
}

export function getBonusXP(cwd: string): number {
  return getProfile(cwd).bonusXP || 0;
}
