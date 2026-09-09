import { TiledMap } from './tilemap';

export interface InteractionPoint {
  x: number;
  y: number;
  type: 'desk' | 'sleep' | 'celebrate' | 'wander';
}

export function parseInteractionPoints(map: TiledMap): InteractionPoint[] {
  const layer = map.layers.find((l) => l.name === 'interactions');
  if (!layer) return [];

  const points: InteractionPoint[] = [];
  const tw = map.tilewidth;
  const th = map.tileheight;

  for (let y = 0; y < layer.height; y++) {
    for (let x = 0; x < layer.width; x++) {
      const tileId = layer.data[y * layer.width + x];
      if (tileId === 0) continue;

      const typeMap: Record<number, InteractionPoint['type']> = {
        1: 'desk',
        2: 'sleep',
        3: 'celebrate',
      };

      points.push({
        x: x * tw + tw / 2,
        y: y * th + th / 2,
        type: typeMap[tileId] || 'wander',
      });
    }
  }

  return points;
}
