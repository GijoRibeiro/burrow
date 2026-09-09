export class Camera {
  x = 0;
  y = 0;

  constructor(
    public viewWidth: number,
    public viewHeight: number,
    public worldWidth: number,
    public worldHeight: number
  ) {}

  centerOn(x: number, y: number): void {
    this.x = Math.max(0, Math.min(x - this.viewWidth / 2, this.worldWidth - this.viewWidth));
    this.y = Math.max(0, Math.min(y - this.viewHeight / 2, this.worldHeight - this.viewHeight));
  }

  resize(viewWidth: number, viewHeight: number): void {
    this.viewWidth = viewWidth;
    this.viewHeight = viewHeight;
  }
}
