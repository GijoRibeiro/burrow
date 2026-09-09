export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
  tilesets: TiledTileset[];
}

export interface TiledLayer {
  name: string;
  type: string;
  data: number[];
  width: number;
  height: number;
  visible: boolean;
}

export interface TiledTileset {
  firstgid: number;
  image: string;
  tilewidth: number;
  tileheight: number;
  imagewidth: number;
  imageheight: number;
  columns: number;
}

export class TileMap {
  private tilesetImage: HTMLImageElement | null = null;

  constructor(
    private map: TiledMap,
    private basePath: string
  ) {}

  get pixelWidth(): number {
    return this.map.width * this.map.tilewidth;
  }

  get pixelHeight(): number {
    return this.map.height * this.map.tileheight;
  }

  async loadTilesets(): Promise<void> {
    if (this.map.tilesets.length === 0) return;

    const ts = this.map.tilesets[0];
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.tilesetImage = img;
        resolve();
      };
      img.onerror = reject;
      img.src = this.basePath + '/' + ts.image;
    });
  }

  draw(ctx: CanvasRenderingContext2D, cameraX: number, cameraY: number): void {
    if (!this.tilesetImage || this.map.tilesets.length === 0) return;

    const ts = this.map.tilesets[0];
    const tw = this.map.tilewidth;
    const th = this.map.tileheight;

    for (const layer of this.map.layers) {
      if (!layer.visible || layer.type !== 'tilelayer') continue;
      if (layer.name === 'collision' || layer.name === 'interactions') continue;

      for (let y = 0; y < layer.height; y++) {
        for (let x = 0; x < layer.width; x++) {
          const tileId = layer.data[y * layer.width + x];
          if (tileId === 0) continue;

          const localId = tileId - ts.firstgid;
          const srcX = (localId % ts.columns) * ts.tilewidth;
          const srcY = Math.floor(localId / ts.columns) * ts.tileheight;

          ctx.drawImage(
            this.tilesetImage,
            srcX,
            srcY,
            ts.tilewidth,
            ts.tileheight,
            x * tw - cameraX,
            y * th - cameraY,
            tw,
            th
          );
        }
      }
    }
  }
}

export async function loadMap(url: string, basePath: string): Promise<TileMap> {
  const resp = await fetch(url);
  const data: TiledMap = await resp.json();
  const tm = new TileMap(data, basePath);
  await tm.loadTilesets();
  return tm;
}
