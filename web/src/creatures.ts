export interface Creature {
  id: string;
  name: string;
  frames: string[];
}

export let CREATURES: Creature[] = [];
export const imageCache = new Map<string, HTMLImageElement>();

export async function loadCreatures(): Promise<void> {
  try {
    const resp = await fetch('http://localhost:3333/api/creatures');
    const names: string[] = await resp.json();
    CREATURES = names.map((name) => ({
      id: name,
      name: name,
      frames: [`/assets/sprites/${name}-1.png`, `/assets/sprites/${name}-2.png`],
    }));
  } catch {
    CREATURES = ['beholder', 'ghost', 'cat', 'skull', 'blob'].map((name) => ({
      id: name,
      name: name,
      frames: [`/assets/sprites/${name}-1.png`, `/assets/sprites/${name}-2.png`],
    }));
  }

  // Preload all images
  const promises: Promise<void>[] = [];
  const t = Date.now();
  for (const c of CREATURES) {
    for (const src of c.frames) {
      promises.push(new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { imageCache.set(src, img); resolve(); };
        img.onerror = () => resolve();
        img.src = src + '?t=' + t;
      }));
    }
  }
  await Promise.all(promises);
}
