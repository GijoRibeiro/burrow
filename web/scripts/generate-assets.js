/**
 * Generates placeholder pixel-art assets for Cloovies.
 * Run: node scripts/generate-assets.js
 *
 * Creates:
 * - assets/tiles/cozy-study.png (tileset: 4 tiles at 16x16)
 * - assets/sprites/creature-01.png (Sprout - green creature)
 * - assets/sprites/creature-02.png (Ember - red/pink creature)
 * - assets/sprites/creature-03.png (Dewdrop - blue creature)
 */

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// ============================================================
// TILESET: Cozy Study (4 tiles, 16x16 each = 64x16 image)
// ============================================================
function generateTileset() {
  const canvas = createCanvas(64, 16);
  const ctx = canvas.getContext('2d');

  // Tile 1: Wall (dark brown with brick pattern)
  ctx.fillStyle = '#5a3a1a';
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = '#4a2a10';
  // Brick lines
  ctx.fillRect(0, 4, 16, 1);
  ctx.fillRect(0, 9, 16, 1);
  ctx.fillRect(0, 14, 16, 1);
  ctx.fillRect(8, 0, 1, 4);
  ctx.fillRect(4, 5, 1, 4);
  ctx.fillRect(12, 5, 1, 4);
  ctx.fillRect(8, 10, 1, 4);

  // Tile 2: Floor (warm wood - light)
  ctx.fillStyle = '#e8d4b4';
  ctx.fillRect(16, 0, 16, 16);
  // Wood grain
  ctx.fillStyle = '#d8c4a4';
  ctx.fillRect(16, 3, 16, 1);
  ctx.fillRect(16, 7, 16, 1);
  ctx.fillRect(16, 11, 16, 1);
  ctx.fillRect(16, 15, 16, 1);
  // Slight variation
  ctx.fillStyle = '#dcc8a8';
  ctx.fillRect(20, 0, 4, 3);
  ctx.fillRect(26, 4, 4, 3);
  ctx.fillRect(18, 8, 4, 3);
  ctx.fillRect(28, 12, 4, 3);

  // Tile 3: Floor (warm wood - dark, alternating)
  ctx.fillStyle = '#dcc8a8';
  ctx.fillRect(32, 0, 16, 16);
  ctx.fillStyle = '#ccb898';
  ctx.fillRect(32, 3, 16, 1);
  ctx.fillRect(32, 7, 16, 1);
  ctx.fillRect(32, 11, 16, 1);
  ctx.fillRect(32, 15, 16, 1);
  ctx.fillStyle = '#d0bc9c';
  ctx.fillRect(36, 0, 4, 3);
  ctx.fillRect(42, 4, 4, 3);
  ctx.fillRect(34, 8, 4, 3);
  ctx.fillRect(44, 12, 4, 3);

  // Tile 4: Furniture (desk - brown with highlights)
  ctx.fillStyle = '#8b6b4a';
  ctx.fillRect(48, 0, 16, 16);
  ctx.fillStyle = '#a07850';
  ctx.fillRect(49, 1, 14, 2);
  ctx.fillStyle = '#6b4b2a';
  ctx.fillRect(48, 14, 16, 2);
  // Desk surface highlight
  ctx.fillStyle = '#9b7b5a';
  ctx.fillRect(50, 4, 12, 8);
  // Monitor on desk
  ctx.fillStyle = '#2a2a4e';
  ctx.fillRect(53, 5, 6, 5);
  ctx.fillStyle = '#4a8aff';
  ctx.fillRect(54, 6, 4, 3);

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(ASSETS_DIR, 'tiles', 'cozy-study.png'), buf);
  console.log('Created tiles/cozy-study.png');
}

// ============================================================
// CREATURE SPRITES
// Each sprite sheet: 64x96 (4 cols x 4 rows, 16x24 each frame)
// Row 0: idle (2 frames + 2 empty)
// Row 1: active (4 frames)
// Row 2: sleeping (2 frames + 2 empty)
// Row 3: celebrating (4 frames)
// ============================================================

function drawCreatureBase(ctx, x, y, palette) {
  const { outline, body, face, accent } = palette;

  // Head (8x8, centered)
  ctx.fillStyle = outline;
  ctx.fillRect(x + 4, y + 0, 8, 1);   // top
  ctx.fillRect(x + 3, y + 1, 1, 6);   // left
  ctx.fillRect(x + 12, y + 1, 1, 6);  // right
  ctx.fillRect(x + 4, y + 7, 8, 1);   // bottom

  ctx.fillStyle = body;
  ctx.fillRect(x + 4, y + 1, 8, 6);   // head fill

  // Eyes
  ctx.fillStyle = face;
  ctx.fillRect(x + 5, y + 3, 2, 2);   // left eye
  ctx.fillRect(x + 9, y + 3, 2, 2);   // right eye
  // Pupils
  ctx.fillStyle = outline;
  ctx.fillRect(x + 6, y + 4, 1, 1);
  ctx.fillRect(x + 10, y + 4, 1, 1);

  // Body (10x8)
  ctx.fillStyle = outline;
  ctx.fillRect(x + 3, y + 8, 1, 8);   // left
  ctx.fillRect(x + 12, y + 8, 1, 8);  // right
  ctx.fillRect(x + 3, y + 16, 10, 1); // bottom

  ctx.fillStyle = accent;
  ctx.fillRect(x + 4, y + 8, 8, 8);   // body fill

  // Feet
  ctx.fillStyle = outline;
  ctx.fillRect(x + 4, y + 17, 3, 2);  // left foot
  ctx.fillRect(x + 9, y + 17, 3, 2);  // right foot
  ctx.fillStyle = body;
  ctx.fillRect(x + 4, y + 17, 2, 1);
  ctx.fillRect(x + 9, y + 17, 2, 1);
}

function drawCreatureIdle2(ctx, x, y, palette) {
  // Slightly raised (bounce frame 2)
  drawCreatureBase(ctx, x, y - 1, palette);
}

function drawCreatureActive(ctx, x, y, palette, frame) {
  const { outline, body, accent } = palette;
  // Walking animation - shift feet
  drawCreatureBase(ctx, x, y, palette);

  // Override feet for walk cycle
  ctx.fillStyle = accent; // clear default feet area
  ctx.fillRect(x + 4, y + 17, 8, 2);

  ctx.fillStyle = outline;
  if (frame === 0) {
    ctx.fillRect(x + 3, y + 17, 3, 2);
    ctx.fillRect(x + 10, y + 17, 3, 2);
  } else if (frame === 1) {
    ctx.fillRect(x + 4, y + 17, 3, 2);
    ctx.fillRect(x + 9, y + 17, 3, 2);
  } else if (frame === 2) {
    ctx.fillRect(x + 5, y + 17, 3, 2);
    ctx.fillRect(x + 8, y + 17, 3, 2);
  } else {
    ctx.fillRect(x + 4, y + 17, 3, 2);
    ctx.fillRect(x + 9, y + 17, 3, 2);
  }

  // Typing particles for frames 1,3
  if (frame === 1 || frame === 3) {
    ctx.fillStyle = '#ffdd44';
    ctx.fillRect(x + 14, y + 6, 2, 2);
  }
}

function drawCreatureSleeping(ctx, x, y, palette, frame) {
  const { outline, body, accent, face } = palette;
  drawCreatureBase(ctx, x, y, palette);

  // Closed eyes (override)
  ctx.fillStyle = body;
  ctx.fillRect(x + 5, y + 3, 2, 2);
  ctx.fillRect(x + 9, y + 3, 2, 2);
  ctx.fillStyle = outline;
  ctx.fillRect(x + 5, y + 4, 2, 1); // closed left
  ctx.fillRect(x + 9, y + 4, 2, 1); // closed right

  // Zzz
  ctx.fillStyle = '#8888cc';
  if (frame === 0) {
    ctx.fillRect(x + 13, y + 0, 1, 1);
    ctx.fillRect(x + 14, y + 1, 1, 1);
    ctx.fillRect(x + 13, y + 2, 1, 1);
  } else {
    ctx.fillRect(x + 14, y + 0, 1, 1);
    ctx.fillRect(x + 13, y + 1, 1, 1);
    ctx.fillRect(x + 14, y + 2, 1, 1);
  }
}

function drawCreatureCelebrating(ctx, x, y, palette, frame) {
  const { outline, body, accent } = palette;

  // Jump offset
  const jumpY = frame === 0 || frame === 2 ? -2 : -4;
  drawCreatureBase(ctx, x, y + jumpY, palette);

  // Override eyes to happy
  ctx.fillStyle = body;
  ctx.fillRect(x + 5, y + jumpY + 3, 2, 2);
  ctx.fillRect(x + 9, y + jumpY + 3, 2, 2);
  ctx.fillStyle = outline;
  // Happy arc eyes
  ctx.fillRect(x + 5, y + jumpY + 3, 2, 1);
  ctx.fillRect(x + 9, y + jumpY + 3, 2, 1);

  // Sparkles
  const sparkleColors = ['#ffdd44', '#ff88aa', '#44ddff', '#88ff88'];
  ctx.fillStyle = sparkleColors[frame];
  ctx.fillRect(x + 1, y + jumpY + 2, 1, 1);
  ctx.fillRect(x + 14, y + jumpY + 1, 1, 1);
  ctx.fillRect(x + 0, y + jumpY + 8, 1, 1);
  ctx.fillRect(x + 15, y + jumpY + 6, 1, 1);
}

function generateCreature(filename, palette) {
  // 4 columns x 4 rows, each frame 16x24
  const canvas = createCanvas(64, 96);
  const ctx = canvas.getContext('2d');

  // Clear with transparency
  ctx.clearRect(0, 0, 64, 96);

  // Row 0: Idle (frames 0-1, cols 2-3 empty)
  drawCreatureBase(ctx, 0, 0, palette);        // frame 0
  drawCreatureIdle2(ctx, 16, 0, palette);       // frame 1 (bounced)

  // Row 1: Active (frames 0-3)
  drawCreatureActive(ctx, 0, 24, palette, 0);
  drawCreatureActive(ctx, 16, 24, palette, 1);
  drawCreatureActive(ctx, 32, 24, palette, 2);
  drawCreatureActive(ctx, 48, 24, palette, 3);

  // Row 2: Sleeping (frames 0-1, cols 2-3 empty)
  drawCreatureSleeping(ctx, 0, 48, palette, 0);
  drawCreatureSleeping(ctx, 16, 48, palette, 1);

  // Row 3: Celebrating (frames 0-3)
  drawCreatureCelebrating(ctx, 0, 72, palette, 0);
  drawCreatureCelebrating(ctx, 16, 72, palette, 1);
  drawCreatureCelebrating(ctx, 32, 72, palette, 2);
  drawCreatureCelebrating(ctx, 48, 72, palette, 3);

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(ASSETS_DIR, 'sprites', filename), buf);
  console.log(`Created sprites/${filename}`);
}

// ============================================================
// Run
// ============================================================

generateTileset();

// Creature palettes (inspired by user's pastel pixel art references)
generateCreature('creature-01.png', {
  outline: '#2d2d5e',
  body:    '#e8e0d0',
  face:    '#2d2d5e',
  accent:  '#a0d0a0', // green - Sprout
});

generateCreature('creature-02.png', {
  outline: '#2d2d5e',
  body:    '#f0d8d0',
  face:    '#2d2d5e',
  accent:  '#e0a0a0', // pink/red - Ember
});

generateCreature('creature-03.png', {
  outline: '#2d2d5e',
  body:    '#d8e0f0',
  face:    '#2d2d5e',
  accent:  '#a0c0e0', // blue - Dewdrop
});

console.log('\nDone! Assets generated in web/assets/');
