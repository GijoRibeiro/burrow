import { Camera } from './camera';
import { TileMap } from '../world/tilemap';
import { CreatureEntity } from '../world/entities';

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private camera: Camera;
  private tileMap: TileMap | null = null;
  private creatures: CreatureEntity[] = [];
  private lastTime = 0;
  private running = false;
  private scale = 2;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
    this.camera = new Camera(0, 0, 0, 0);
    this.handleResize();
    window.addEventListener('resize', () => this.handleResize());
  }

  setTileMap(map: TileMap): void {
    this.tileMap = map;
    this.camera.worldWidth = map.pixelWidth;
    this.camera.worldHeight = map.pixelHeight;
    this.camera.centerOn(map.pixelWidth / 2, map.pixelHeight / 2);
  }

  setCreatures(creatures: CreatureEntity[]): void {
    this.creatures = creatures;
  }

  start(): void {
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  stop(): void {
    this.running = false;
  }

  private loop(time: number): void {
    if (!this.running) return;

    const dt = (time - this.lastTime) / 1000;
    this.lastTime = time;

    this.update(dt);
    this.draw();

    requestAnimationFrame((t) => this.loop(t));
  }

  private update(dt: number): void {
    for (const creature of this.creatures) {
      creature.update(dt);
    }
  }

  private draw(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;

    this.ctx.clearRect(0, 0, w, h);

    this.ctx.save();
    this.ctx.scale(this.scale, this.scale);

    if (this.tileMap) {
      this.tileMap.draw(this.ctx, this.camera.x, this.camera.y);
    }

    const sorted = [...this.creatures].sort((a, b) => a.y - b.y);
    for (const creature of sorted) {
      creature.draw(this.ctx, this.camera.x, this.camera.y);
    }

    this.ctx.restore();
  }

  private handleResize(): void {
    const container = this.canvas.parentElement!;
    const rect = container.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this.camera.resize(rect.width / this.scale, rect.height / this.scale);
  }
}
