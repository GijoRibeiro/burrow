// Single registry of legitimate section ids. Anything not in this set
// must NOT appear as a leaf in the layout tree — including legacy ids
// like `chat-lanes`, `top-controls`, and `debug-panel` that the old
// section-drag system accidentally serialized into localStorage.
//
// The display title is what appears on the close-shelf button when a
// section is hidden, so it can be re-added later.

import type { SectionId } from './tree';

export interface SectionMeta {
  // The id used everywhere in the tree + DOM data attribute.
  id: SectionId;
  // Human-readable label used by the "hidden sections" shelf.
  title: string;
  // True for sections that must always be present in the tree (their
  // close button is suppressed). Today: chat only — agent-grid used to
  // be alwaysOn but the user wanted to be able to hide it the same way
  // music + linear can be hidden, and the hidden-sections shelf already
  // exists to re-add it.
  alwaysOn?: boolean;
}

export const SECTION_REGISTRY: ReadonlyArray<SectionMeta> = [
  { id: 'chat',         title: 'chat',   alwaysOn: true },
  { id: 'agent-grid',   title: 'agents' },
  { id: 'music-bar',    title: 'music' },
  { id: 'linear-panel', title: 'linear' },
  // active-agents-bar is intentionally NOT a top-level section — it's
  // a sub-region of #chat-lanes (the avatar strip inside lane-zero),
  // not something a user drags around independently.
];

export function isKnownSection(id: SectionId): boolean {
  for (const s of SECTION_REGISTRY) if (s.id === id) return true;
  return false;
}

export function isAlwaysOn(id: SectionId): boolean {
  for (const s of SECTION_REGISTRY) if (s.id === id) return !!s.alwaysOn;
  return false;
}

export function sectionTitle(id: SectionId): string {
  for (const s of SECTION_REGISTRY) if (s.id === id) return s.title;
  return id;
}
