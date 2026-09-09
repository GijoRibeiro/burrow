import { SpriteSheet, drawFrame } from '../canvas/sprite';

export type AnimationState = 'idle' | 'active' | 'sleeping' | 'celebrating';

interface AnimationDef {
  startFrame: number;
  frameCount: number;
  frameDuration: number;
}

const ANIMATION_DEFS: Record<AnimationState, AnimationDef> = {
  idle: { startFrame: 0, frameCount: 2, frameDuration: 0.6 },
  active: { startFrame: 4, frameCount: 4, frameDuration: 0.2 },
  sleeping: { startFrame: 8, frameCount: 2, frameDuration: 0.8 },
  celebrating: { startFrame: 10, frameCount: 4, frameDuration: 0.15 },
};

export class CreatureEntity {
  x: number;
  y: number;
  animation: AnimationState = 'idle';
  private frameTimer = 0;
  private currentFrame = 0;
  private bubbleText = '';
  private bubbleTimer = 0;

  constructor(
    private spriteSheet: SpriteSheet,
    x: number,
    y: number,
    private accentColor: string
  ) {
    this.x = x;
    this.y = y;
  }

  setAnimation(anim: AnimationState): void {
    if (this.animation !== anim) {
      this.animation = anim;
      this.currentFrame = 0;
      this.frameTimer = 0;
    }
  }

  setBubble(text: string, duration: number = 3): void {
    this.bubbleText = text;
    this.bubbleTimer = duration;
  }

  update(dt: number): void {
    const def = ANIMATION_DEFS[this.animation];
    this.frameTimer += dt;
    if (this.frameTimer >= def.frameDuration) {
      this.frameTimer -= def.frameDuration;
      this.currentFrame = (this.currentFrame + 1) % def.frameCount;
    }

    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dt;
      if (this.bubbleTimer <= 0) {
        this.bubbleText = '';
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, cameraX: number, cameraY: number): void {
    const def = ANIMATION_DEFS[this.animation];
    const frameIndex = def.startFrame + this.currentFrame;
    const drawX = this.x - cameraX - this.spriteSheet.frameWidth / 2;
    const drawY = this.y - cameraY - this.spriteSheet.frameHeight;

    drawFrame(ctx, this.spriteSheet, frameIndex, drawX, drawY);

    if (this.bubbleText) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#333';
      const textWidth = ctx.measureText(this.bubbleText).width;
      const bx = drawX + this.spriteSheet.frameWidth / 2 - textWidth / 2 - 4;
      const by = drawY - 14;

      ctx.fillRect(bx, by, textWidth + 8, 12);
      ctx.strokeRect(bx, by, textWidth + 8, 12);
      ctx.fillStyle = '#333';
      ctx.font = '8px monospace';
      ctx.fillText(this.bubbleText, bx + 4, by + 9);
    }
  }
}
