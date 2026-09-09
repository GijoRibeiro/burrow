export interface SpriteSheet {
  image: HTMLImageElement;
  frameWidth: number;
  frameHeight: number;
  cols: number;
}

export async function loadSpriteSheet(
  src: string,
  frameWidth: number,
  frameHeight: number
): Promise<SpriteSheet> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve({
        image,
        frameWidth,
        frameHeight,
        cols: Math.floor(image.width / frameWidth),
      });
    };
    image.onerror = reject;
    image.src = src;
  });
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  sheet: SpriteSheet,
  frameIndex: number,
  x: number,
  y: number,
  scale: number = 1
): void {
  const col = frameIndex % sheet.cols;
  const row = Math.floor(frameIndex / sheet.cols);
  const sx = col * sheet.frameWidth;
  const sy = row * sheet.frameHeight;

  ctx.drawImage(
    sheet.image,
    sx,
    sy,
    sheet.frameWidth,
    sheet.frameHeight,
    x,
    y,
    sheet.frameWidth * scale,
    sheet.frameHeight * scale
  );
}
