// Spotify now-playing bar. Toggled via settings ("spotify player").
// Artwork is fetched from Spotify's CDN and re-rendered with a 4x4 Bayer
// ordered dither using the app's two palette colors (light #eae5ce, dark #2e2f38)
// to match the retro 1-bit look of the rest of the UI.

interface NowPlaying {
  available: boolean;
  running: boolean;
  playing: boolean;
  track: string;
  artist: string;
  album: string;
  positionMs: number;
  durationMs: number;
  artworkUrl: string;
}

const LIGHT: [number, number, number] = [0xea, 0xe5, 0xce];
const DARK: [number, number, number] = [0x2e, 0x2f, 0x38];
const ART_SIZE = 48;
const POLL_MS = 2500;

let enabled = false;
let initialized = false;
let pollTimer: number | null = null;

let barEl: HTMLElement | null = null;
let artworkCanvas: HTMLCanvasElement | null = null;
let bannerCanvas: HTMLCanvasElement | null = null;
let titleEl: HTMLElement | null = null;
let artistEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let progressFill: HTMLElement | null = null;
let playPauseEl: HTMLElement | null = null;
let playPauseCanvas: HTMLCanvasElement | null = null;
let lyricEl: HTMLElement | null = null;
let lyricPrevEl: HTMLElement | null = null;
let lyricPrev2El: HTMLElement | null = null;
let lyricCurrentEl: HTMLElement | null = null;
let lyricNextEl: HTMLElement | null = null;
let lyricNext2El: HTMLElement | null = null;

// Lyrics state — fetched from LRCLIB when a track changes. The current line
// is advanced locally using lastPositionMs + elapsed wall-clock so the lyric
// updates smoothly between server polls.
interface LyricLine { time: number; text: string; }
let currentLyrics: LyricLine[] | null = null;
let lyricsTrackKey = '';
let lastPositionMs = 0;
let lastPositionAt = 0;
let lastPlaying = false;
let lyricTimer: number | null = null;
let lyricsEnabled = true;
let lyricsLayout: 'vertical' | 'horizontal' = (localStorage.getItem('musicLyricsLayout') === 'horizontal' ? 'horizontal' : 'vertical');
let musicSource = 'auto';
let style: 'framed' | 'banner' | 'frame' | 'cover' = 'framed';

let lastArtworkUrl = '';
let artworkImg: HTMLImageElement | null = null;

// 4x4 Bayer matrix, normalized to [0, 15]. Coarse / chunky pattern.
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// 8x8 Bayer, normalized to [0, 63]. Finer dither — ~4x more gray levels,
// preserves detail of the source image better while still reading as 1-bit.
const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

interface DitherMode {
  method: 'bayer' | 'floyd';
  matrix?: number[][];
  size?: number;
  scale?: number; // multiplier to get threshold in [0, 255]
  contrast: number;
  // Oversample: if > 1, render source at higher internal resolution before
  // dithering, so the final pattern packs more detail per displayed pixel.
  oversample: number;
}

// A continuous "strength" slider (0–10). Both contrast and oversample are
// continuous functions of the slider so there's no sudden chunk-size jump.
// Oversample controls dot size: higher = finer pattern, lower = chunkier.
// Contrast controls how aggressively the image is pushed to black/white.
// The dither method steps at fixed thresholds (those are discrete by nature).
function modeForStrength(strength: number): DitherMode {
  const s = Math.max(0, Math.min(10, strength));
  const contrast = 0.7 + (s / 10) * 1.8;   // 0.7 → 2.5
  const oversample = 2.5 - (s / 10) * 1.5; // 2.5 → 1.0
  if (s < 3) return { method: 'floyd', contrast, oversample };
  if (s < 7) return { method: 'bayer', matrix: BAYER_8, size: 8, scale: 255 / 64, contrast, oversample };
  return { method: 'bayer', matrix: BAYER_4, size: 4, scale: 255 / 16, contrast, oversample };
}

let currentMode: DitherMode = modeForStrength(6);

// 11x11 pixel-art glyphs for media controls. '#' = foreground (light), '.' = transparent.
const ICON_PREV = [
  '...........',
  '...........',
  '...#....#..',
  '..##...##..',
  '.###..###..',
  '####.####..',
  '.###..###..',
  '..##...##..',
  '...#....#..',
  '...........',
  '...........',
];

const ICON_NEXT = [
  '...........',
  '...........',
  '..#....#...',
  '..##...##..',
  '..###..###.',
  '..####.####',
  '..###..###.',
  '..##...##..',
  '..#....#...',
  '...........',
  '...........',
];

const ICON_PLAY = [
  '...........',
  '...........',
  '...##......',
  '...###.....',
  '...####....',
  '...#####...',
  '...####....',
  '...###.....',
  '...##......',
  '...........',
  '...........',
];

const ICON_PAUSE = [
  '...........',
  '...........',
  '..##..##...',
  '..##..##...',
  '..##..##...',
  '..##..##...',
  '..##..##...',
  '..##..##...',
  '..##..##...',
  '...........',
  '...........',
];

// Parse LRC-format synced lyrics into sorted [{time, text}] lines.
function parseLRC(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of lrc.split('\n')) {
    // A single line can carry multiple timestamps: `[00:10.50][01:20.00]Text`.
    const timeRe = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
    const times: number[] = [];
    let m: RegExpExecArray | null;
    let lastIdx = 0;
    while ((m = timeRe.exec(raw)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      times.push(min * 60000 + sec * 1000 + frac);
      lastIdx = m.index + m[0].length;
    }
    if (times.length === 0) continue;
    const text = raw.slice(lastIdx).trim();
    for (const t of times) out.push({ time: t, text });
  }
  return out.sort((a, b) => a.time - b.time);
}

// Try LRCLIB's exact `/api/get` first (track + artist + album + duration
// must match the indexed metadata exactly). Spotify and LRCLIB often
// disagree on album name or have small differences in reported track
// duration, which returns a 404 from `/api/get` even when synced lyrics
// exist on LRCLIB — that's the "I see no lyrics for this song" bug.
//
// Fall back to `/api/search`, which does fuzzy matching on track +
// artist alone, and pick the first result that has `syncedLyrics`.
// This catches almost every case the strict endpoint misses without
// surfacing wrong-track lyrics, because LRCLIB ranks by relevance.
async function fetchLyrics(track: string, artist: string, album: string, durationMs: number): Promise<LyricLine[] | null> {
  const tryParse = (synced: unknown): LyricLine[] | null => {
    if (typeof synced !== 'string' || synced === '') return null;
    const lines = parseLRC(synced);
    return lines.length > 0 ? lines : null;
  };

  // 1. Exact GET — fastest path when metadata aligns.
  try {
    const params = new URLSearchParams({
      track_name: track,
      artist_name: artist,
      album_name: album,
      duration: String(Math.round(durationMs / 1000)),
    });
    const r = await fetch('https://lrclib.net/api/get?' + params.toString());
    if (r.ok) {
      const data = await r.json();
      if (data && !data.instrumental) {
        const parsed = tryParse(data.syncedLyrics);
        if (parsed) return parsed;
      }
    }
  } catch {
    // network failure on first endpoint — fall through to search.
  }

  // 2. Fuzzy SEARCH — track + artist, scan results for the first one
  //    with syncedLyrics. Prefer a close duration match when present.
  try {
    const params = new URLSearchParams({
      track_name: track,
      artist_name: artist,
    });
    const r = await fetch('https://lrclib.net/api/search?' + params.toString());
    if (!r.ok) return null;
    const list = (await r.json()) as Array<{
      syncedLyrics?: string;
      instrumental?: boolean;
      duration?: number;
    }>;
    if (!Array.isArray(list) || list.length === 0) return null;
    const wantSec = Math.round(durationMs / 1000);
    const candidates = list.filter((x) => x && !x.instrumental && typeof x.syncedLyrics === 'string' && x.syncedLyrics);
    if (candidates.length === 0) return null;
    // Pick the candidate with the closest duration (when LRCLIB
    // reports one); otherwise the first result, which is the most
    // relevant by LRCLIB's own ranking.
    candidates.sort((a, b) => {
      const da = typeof a.duration === 'number' ? Math.abs(a.duration - wantSec) : 1e9;
      const db = typeof b.duration === 'number' ? Math.abs(b.duration - wantSec) : 1e9;
      return da - db;
    });
    return tryParse(candidates[0].syncedLyrics);
  } catch {
    return null;
  }
}

function currentLyricIndex(): number {
  if (!currentLyrics || currentLyrics.length === 0) return -1;
  const elapsed = lastPlaying ? performance.now() - lastPositionAt : 0;
  const pos = lastPositionMs + elapsed;
  for (let i = currentLyrics.length - 1; i >= 0; i--) {
    if (currentLyrics[i].time <= pos) return i;
  }
  return -1;
}

function tickLyrics(): void {
  if (!barEl || !lyricCurrentEl || !lyricPrevEl || !lyricNextEl) return;
  const hasLyrics = !!(currentLyrics && currentLyrics.length > 0);
  barEl.dataset.hasLyrics = hasLyrics ? 'true' : 'false';
  if (!hasLyrics || !currentLyrics) {
    lyricPrevEl.textContent = '';
    lyricCurrentEl.textContent = '';
    lyricNextEl.textContent = '';
    return;
  }
  const idx = currentLyricIndex();
  const at = (i: number) => (i >= 0 && i < currentLyrics!.length ? currentLyrics![i].text : '');
  const prev2 = at(idx - 2);
  const prev = at(idx - 1);
  const curr = idx >= 0 ? currentLyrics[idx].text : '';
  const next = at(idx + 1);
  const next2 = at(idx + 2);
  if (lyricPrev2El && lyricPrev2El.textContent !== prev2) lyricPrev2El.textContent = prev2;
  if (lyricPrevEl.textContent !== prev) lyricPrevEl.textContent = prev;
  if (lyricCurrentEl.textContent !== (curr || '♪')) lyricCurrentEl.textContent = curr || '♪';
  if (lyricNextEl.textContent !== next) lyricNextEl.textContent = next;
  if (lyricNext2El && lyricNext2El.textContent !== next2) lyricNext2El.textContent = next2;
}

function startLyricsTimer(): void {
  if (lyricTimer !== null) return;
  lyricTimer = window.setInterval(tickLyrics, 250);
}

function stopLyricsTimer(): void {
  if (lyricTimer !== null) {
    clearInterval(lyricTimer);
    lyricTimer = null;
  }
}

function drawPixelIcon(canvas: HTMLCanvasElement, glyph: string[]): void {
  const size = glyph.length;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#eae5ce';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < glyph[y].length; x++) {
      if (glyph[y][x] === '#') ctx.fillRect(x, y, 1, 1);
    }
  }
}

function makeIconButton(glyph: string[], title: string, onClick: () => void, extraClass = ''): { el: HTMLElement; canvas: HTMLCanvasElement } {
  const el = document.createElement('span');
  el.className = 'music-btn' + (extraClass ? ' ' + extraClass : '');
  el.title = title;
  const canvas = document.createElement('canvas');
  canvas.className = 'music-btn-icon';
  drawPixelIcon(canvas, glyph);
  el.appendChild(canvas);
  el.addEventListener('click', onClick);
  return { el, canvas };
}

function applyBayerDither(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const matrix = currentMode.matrix!;
  const size = currentMode.size!;
  const scale = currentMode.scale!;
  const contrast = currentMode.contrast;
  const mask = size - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      lum = (lum - 128) * contrast + 128;
      if (lum < 0) lum = 0; else if (lum > 255) lum = 255;
      const t = (matrix[y & mask][x & mask] + 0.5) * scale;
      const on = lum > t;
      const c = on ? LIGHT : DARK;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

// Floyd-Steinberg error diffusion. Each pixel snaps to black/white and the
// quantization error is spread to the right and next-row neighbors. Produces
// the natural-looking retro newsprint pattern that keeps images recognizable.
function applyFloydDither(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const contrast = currentMode.contrast;
  const lumBuf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    let lum = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
    lum = (lum - 128) * contrast + 128;
    lumBuf[i] = lum;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const old = lumBuf[idx];
      const on = old >= 128;
      const newV = on ? 255 : 0;
      const err = old - newV;
      const c = on ? LIGHT : DARK;
      const o = idx * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      if (x + 1 < w) lumBuf[idx + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) lumBuf[idx + w - 1] += (err * 3) / 16;
        lumBuf[idx + w] += (err * 5) / 16;
        if (x + 1 < w) lumBuf[idx + w + 1] += err / 16;
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

function applyDither(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  if (currentMode.method === 'floyd') applyFloydDither(ctx, w, h);
  else applyBayerDither(ctx, w, h);
}

function ditherTo(canvas: HTMLCanvasElement, img: HTMLImageElement): void {
  const size = Math.round(ART_SIZE * currentMode.oversample);
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, size, size);
  applyDither(ctx, size, size);
}

// Renders the cover into a wide, stretched band with chunky 1-bit dithering —
// used as the full-width background when the "banner" style is active. The
// internal canvas resolution is kept low on purpose so that CSS pixelation
// blows up the dither pattern for a retro look.
const BANNER_W = 256;
const BANNER_H = 40;

function ditherBanner(canvas: HTMLCanvasElement, img: HTMLImageElement): void {
  const os = currentMode.oversample;
  const w = Math.round(BANNER_W * os);
  const h = Math.round(BANNER_H * os);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const iw = img.naturalWidth || 1;
  const ih = img.naturalHeight || 1;
  const scale = Math.max(w / iw, h / ih);
  const sw = iw * scale;
  const sh = ih * scale;
  const dx = (w - sw) / 2;
  const dy = (h - sh) / 2;
  ctx.fillStyle = '#2e2f38';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, dx, dy, sw, sh);
  applyDither(ctx, w, h);
}

function drawPlaceholderBanner(canvas: HTMLCanvasElement): void {
  canvas.width = BANNER_W;
  canvas.height = BANNER_H;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#2e2f38';
  ctx.fillRect(0, 0, BANNER_W, BANNER_H);
  ctx.fillStyle = '#eae5ce';
  for (let y = 0; y < BANNER_H; y++) {
    for (let x = 0; x < BANNER_W; x++) {
      if ((BAYER_4[y & 3][x & 3] + (x + y)) % 5 === 0) ctx.fillRect(x, y, 1, 1);
    }
  }
}

function drawPlaceholderArtwork(canvas: HTMLCanvasElement): void {
  const size = ART_SIZE;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#2e2f38';
  ctx.fillRect(0, 0, size, size);
  // Dithered checker border — nods to the rest of the UI.
  ctx.fillStyle = '#eae5ce';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = x < 2 || y < 2 || x > size - 3 || y > size - 3;
      if (edge && ((x + y) & 1) === 0) ctx.fillRect(x, y, 1, 1);
    }
  }
  // Small note glyph in the middle.
  ctx.fillRect(size / 2 - 1, size / 2 - 6, 2, 10);
  ctx.fillRect(size / 2 - 4, size / 2 + 3, 5, 2);
}

function createBar(): HTMLElement {
  const bar = document.createElement('section');
  bar.id = 'music-bar';
  bar.dataset.style = 'framed';
  bar.dataset.layoutSection = 'music-bar';

  const banner = document.createElement('canvas');
  banner.className = 'music-banner-canvas';
  bannerCanvas = banner;
  drawPlaceholderBanner(banner);
  bar.appendChild(banner);


  const artworkWrap = document.createElement('div');
  artworkWrap.className = 'music-artwork-wrap';
  const art = document.createElement('canvas');
  art.className = 'music-artwork';
  art.width = ART_SIZE;
  art.height = ART_SIZE;
  artworkCanvas = art;
  drawPlaceholderArtwork(art);
  artworkWrap.appendChild(art);

  const info = document.createElement('div');
  info.className = 'music-info';

  const title = document.createElement('div');
  title.className = 'music-title';
  title.textContent = '—';
  titleEl = title;

  const artist = document.createElement('div');
  artist.className = 'music-artist';
  artist.textContent = '';
  artistEl = artist;

  const status = document.createElement('div');
  status.className = 'music-status';
  statusEl = status;

  info.appendChild(title);
  info.appendChild(artist);
  info.appendChild(status);

  const progress = document.createElement('div');
  progress.className = 'music-progress';
  const fill = document.createElement('div');
  fill.className = 'music-progress-fill';
  progress.appendChild(fill);
  progressFill = fill;

  const lyric = document.createElement('div');
  lyric.className = 'music-lyric';
  lyric.dataset.layout = lyricsLayout;
  // ±2 context lines exist in DOM but only render in horizontal layout
  // (CSS hides them in vertical mode). Order in horizontal flex-row
  // is prev2 · prev · current · next · next2.
  const lyricPrev2 = document.createElement('div');
  lyricPrev2.className = 'music-lyric-prev2';
  const lyricPrev = document.createElement('div');
  lyricPrev.className = 'music-lyric-prev';
  const lyricCurrent = document.createElement('div');
  lyricCurrent.className = 'music-lyric-current';
  const lyricNext = document.createElement('div');
  lyricNext.className = 'music-lyric-next';
  const lyricNext2 = document.createElement('div');
  lyricNext2.className = 'music-lyric-next2';
  lyric.appendChild(lyricPrev2);
  lyric.appendChild(lyricPrev);
  lyric.appendChild(lyricCurrent);
  lyric.appendChild(lyricNext);
  lyric.appendChild(lyricNext2);
  lyricEl = lyric;
  lyricPrev2El = lyricPrev2;
  lyricPrevEl = lyricPrev;
  lyricCurrentEl = lyricCurrent;
  lyricNextEl = lyricNext;
  lyricNext2El = lyricNext2;

  const controls = document.createElement('div');
  controls.className = 'music-controls';

  const prev = makeIconButton(ICON_PREV, 'previous', () => control('previous'));
  const playPause = makeIconButton(ICON_PLAY, 'play / pause', () => control('play-pause'), 'music-play');
  playPauseEl = playPause.el;
  playPauseCanvas = playPause.canvas;
  const next = makeIconButton(ICON_NEXT, 'next', () => control('next'));

  controls.appendChild(prev.el);
  controls.appendChild(playPause.el);
  controls.appendChild(next.el);

  // Lyrics layout toggle — vertical 3-stack vs horizontal row. Lives
  // at the top-right of the music bar (absolutely positioned via CSS)
  // so it doesn't crowd the playback controls and sits where the user
  // expects layout-control affordances. Persisted in localStorage;
  // flip emits a re-render on the next tickLyrics frame.
  const lyricsLayoutBtn = document.createElement('span');
  lyricsLayoutBtn.className = 'music-btn music-lyrics-layout-btn';
  lyricsLayoutBtn.title = 'lyrics layout (vertical / horizontal)';
  lyricsLayoutBtn.textContent = lyricsLayout === 'horizontal' ? '↕' : '↔';
  lyricsLayoutBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    lyricsLayout = lyricsLayout === 'horizontal' ? 'vertical' : 'horizontal';
    localStorage.setItem('musicLyricsLayout', lyricsLayout);
    if (lyricEl) lyricEl.dataset.layout = lyricsLayout;
    lyricsLayoutBtn.textContent = lyricsLayout === 'horizontal' ? '↕' : '↔';
    tickLyrics();
  });

  // Style cycle — tap to rotate through the four player layouts
  // (framed → banner → frame → cover → framed). Lives next to the
  // lyrics-layout toggle in the top-right corner. Persists to
  // localStorage so it survives reloads, matching how the settings
  // modal writes the same key. Hover-revealed via CSS, same as the
  // sibling lyrics button. Avoids a trip to the main menu for what
  // is essentially a "try the other look" gesture.
  const styleCycleBtn = document.createElement('span');
  styleCycleBtn.className = 'music-btn music-style-cycle-btn';
  const STYLES: Array<'framed' | 'banner' | 'frame' | 'cover'> = ['framed', 'banner', 'frame', 'cover'];
  const refreshStyleBtnLabel = () => {
    styleCycleBtn.title = `player style: ${style} (click to cycle)`;
  };
  styleCycleBtn.textContent = '▦';
  refreshStyleBtnLabel();
  styleCycleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = STYLES.indexOf(style);
    const next = STYLES[(i + 1) % STYLES.length];
    localStorage.setItem('musicStyle', next);
    setMusicStyle(next);
    refreshStyleBtnLabel();
  });

  bar.appendChild(artworkWrap);
  // Group info / progress / lyric / controls in a vertical stack so the
  // bar layout is just two children: cover + stack. Style modes target
  // .music-stack to lay them out (column on the right of the cover for
  // the framed default; row beneath the banner for banner mode; etc.).
  const stack = document.createElement('div');
  stack.className = 'music-stack';
  stack.appendChild(info);
  // Progress bar removed from the visible stack per user feedback —
  // it added visual noise without serving the "now playing" surface
  // (Spotify already shows progress in its own UI). The element is
  // still constructed and `progressFill` still updated by render()
  // so the existing code path doesn't have to special-case absence;
  // CSS hides it everywhere via `.music-progress { display: none }`.
  // Keep `progress` referenced so the variable doesn't become unused
  // and the playback events keep populating the data harmlessly.
  void progress;
  stack.appendChild(lyric);
  stack.appendChild(controls);
  bar.appendChild(stack);
  // Lyrics-layout toggle + style-cycle button are direct children of
  // the bar so their absolute positioning anchors to the bar itself
  // (top-right corner), not the stack.
  bar.appendChild(lyricsLayoutBtn);
  bar.appendChild(styleCycleBtn);

  return bar;
}

async function control(action: 'play-pause' | 'next' | 'previous'): Promise<void> {
  try {
    await fetch('/api/spotify/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, source: musicSource }),
    });
    setTimeout(poll, 200);
  } catch {}
}

async function poll(): Promise<void> {
  if (!enabled || !barEl) return;
  try {
    const q = musicSource && musicSource !== 'auto' ? '?source=' + encodeURIComponent(musicSource) : '';
    const r = await fetch('/api/now-playing' + q);
    const s = (await r.json()) as NowPlaying;
    render(s);
  } catch {
    hideBar();
  }
}

// The bar is kept hidden whenever there's no active track, so users who have
// the player enabled but no music playing get an uncluttered layout.
function hideBar(): void {
  if (barEl) barEl.style.display = 'none';
  if (lastArtworkUrl !== '') {
    lastArtworkUrl = '';
    if (artworkCanvas) drawPlaceholderArtwork(artworkCanvas);
    if (bannerCanvas) drawPlaceholderBanner(bannerCanvas);
  }
}

function render(s: NowPlaying): void {
  if (!barEl || !titleEl || !artistEl || !statusEl || !progressFill || !playPauseEl || !artworkCanvas) return;
  if (!s.available || !s.running || !s.track) {
    hideBar();
    return;
  }
  barEl.style.display = '';

  // Lyrics: fetch on track change, keep local position so the current line
  // advances between polls.
  const key = s.track + '|' + s.artist;
  lastPositionMs = s.positionMs;
  lastPositionAt = performance.now();
  lastPlaying = s.playing;
  if (lyricsEnabled && key !== lyricsTrackKey) {
    lyricsTrackKey = key;
    currentLyrics = null;
    if (barEl) barEl.dataset.hasLyrics = 'false';
    fetchLyrics(s.track, s.artist, s.album, s.durationMs).then((lines) => {
      if (lyricsTrackKey !== key || !lyricsEnabled) return; // track changed or toggled off
      currentLyrics = lines;
      tickLyrics();
    });
  }
  titleEl.textContent = s.track;
  artistEl.textContent = s.artist;
  statusEl.textContent = '';
  if (playPauseCanvas) drawPixelIcon(playPauseCanvas, s.playing ? ICON_PAUSE : ICON_PLAY);
  const pct = s.durationMs > 0 ? Math.min(100, (s.positionMs / s.durationMs) * 100) : 0;
  progressFill.style.width = pct + '%';

  if (s.artworkUrl && s.artworkUrl !== lastArtworkUrl) {
    lastArtworkUrl = s.artworkUrl;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (s.artworkUrl !== lastArtworkUrl) return;
      try {
        ditherTo(artworkCanvas!, img);
        if (bannerCanvas) ditherBanner(bannerCanvas, img);
      } catch {
        drawPlaceholderArtwork(artworkCanvas!);
        if (bannerCanvas) drawPlaceholderBanner(bannerCanvas);
      }
    };
    img.onerror = () => {
      drawPlaceholderArtwork(artworkCanvas!);
      if (bannerCanvas) drawPlaceholderBanner(bannerCanvas);
    };
    img.src = s.artworkUrl;
    artworkImg = img;
  } else if (!s.artworkUrl) {
    drawPlaceholderArtwork(artworkCanvas);
    if (bannerCanvas) drawPlaceholderBanner(bannerCanvas);
  }
}

// Returns the current Spotify artwork image if one has loaded, otherwise null.
// Used by the settings preview so the user can see exactly how the live track
// renders at different dither strengths.
export function getCurrentArtwork(): HTMLImageElement | null {
  return artworkImg && artworkImg.complete && artworkImg.naturalWidth > 0 ? artworkImg : null;
}

// Renders the given image into the given canvas at the requested strength,
// WITHOUT touching the live player's dither mode. Pure preview path.
export function ditherPreview(canvas: HTMLCanvasElement, img: HTMLImageElement, strength: number): void {
  const saved = currentMode;
  currentMode = modeForStrength(strength);
  try {
    const size = Math.round(ART_SIZE * currentMode.oversample);
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, size, size);
    applyDither(ctx, size, size);
  } finally {
    currentMode = saved;
  }
}

// Accepts the slider value as a number OR one of the legacy preset names
// ("subtle", "medium") so existing localStorage values keep working.
export function setMusicSource(source: string): void {
  musicSource = (source === 'spotify' || source === 'apple-music' || source === 'auto') ? source : 'auto';
  // Drop any lyrics tied to the old source's current track so the next poll
  // refetches with fresh metadata.
  lyricsTrackKey = '';
  currentLyrics = null;
  if (barEl) barEl.dataset.hasLyrics = 'false';
  if (enabled) poll();
}

export function setMusicLyrics(on: boolean): void {
  lyricsEnabled = on;
  if (!on) {
    currentLyrics = null;
    lyricsTrackKey = '';
    if (barEl) barEl.dataset.hasLyrics = 'false';
    if (lyricPrevEl) lyricPrevEl.textContent = '';
    if (lyricCurrentEl) lyricCurrentEl.textContent = '';
    if (lyricNextEl) lyricNextEl.textContent = '';
  }
}

export function setMusicDither(value: string | number): void {
  let strength: number;
  if (typeof value === 'number') strength = value;
  else if (value === 'subtle') strength = 1;
  else if (value === 'medium') strength = 6;
  else strength = parseFloat(value);
  if (!isFinite(strength)) strength = 6;
  currentMode = modeForStrength(strength);
  // Re-dither the current artwork if we have one so the change is visible
  // immediately instead of waiting for the next track change.
  if (artworkImg && artworkImg.complete && artworkImg.naturalWidth > 0) {
    if (artworkCanvas) try { ditherTo(artworkCanvas, artworkImg); } catch {}
    if (bannerCanvas) try { ditherBanner(bannerCanvas, artworkImg); } catch {}
  }
}

export function setMusicStyle(next: string): void {
  if (next === 'banner' || next === 'frame' || next === 'cover') style = next;
  else style = 'framed';
  if (!barEl) return;
  barEl.dataset.style = style;
  // In 'frame' and 'cover' modes the player joins the agent row as another
  // card. In every other mode it lives as its own top-level section under #app.
  const agentGrid = document.getElementById('agent-grid');
  const app = document.getElementById('app');
  const inRow = style === 'frame' || style === 'cover';
  let reparentedToApp = false;
  if (inRow) {
    if (agentGrid && barEl.parentElement !== agentGrid) agentGrid.appendChild(barEl);
  } else if (app && barEl.parentElement !== app) {
    app.appendChild(barEl);
    reparentedToApp = true;
  }
  // If we moved the bar back to #app, the layout system's MutationObserver
  // picks it up automatically and re-renders into the saved tree slot.
  void reparentedToApp;
}

function startPolling(): void {
  if (pollTimer !== null) return;
  poll();
  pollTimer = window.setInterval(poll, POLL_MS);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function initMusic(initiallyEnabled: boolean): void {
  if (initialized) return;
  initialized = true;
  barEl = createBar();
  document.getElementById('app')?.appendChild(barEl);
  setMusicEnabled(initiallyEnabled);
  // Shape-driven layout. Container queries can only key off inline-size
  // without `container-type: size` (which has unwanted layout side-
  // effects), so a ResizeObserver picks a discrete `data-fit` that CSS
  // keys off. Two states beyond the default wide-grid:
  //
  //   stage → tall+wide slot (w > 360 AND h ≥ 280 AND h / w ≥ 0.7):
  //           cover dominates the top as a big square, info / lyrics /
  //           controls flow underneath. The "now playing panel" feel
  //           for a vertical lane that's wider than a sidebar.
  //   ''    → the default wide horizontal grid (cover | info | lyrics
  //           | controls). Narrow widths (w ≤ 360) are already handled
  //           by the `@container (max-width: 360px)` rule which
  //           vertically stacks everything in a thin column.
  //
  // The breakpoints are loose on purpose so the layout doesn't flicker
  // between modes on tiny pixel changes during a divider drag — and
  // the observer also no-ops while `body.lane-resizing` is set, with a
  // single reconcile pass on `lane-resize-end`.
  const computeFit = (w: number, h: number): 'stage' | '' => {
    if (w <= 0 || h <= 0) return '';
    if (w > 360 && h >= 280 && h / w >= 0.7) return 'stage';
    return '';
  };
  const applyFit = (w: number, h: number) => {
    if (!barEl) return;
    const fit = computeFit(w, h);
    if (barEl.dataset.fit !== fit) barEl.dataset.fit = fit;
  };
  const ro = new ResizeObserver((entries) => {
    if (document.body.classList.contains('lane-resizing')) return;
    const r = entries[0].contentRect;
    applyFit(r.width, r.height);
  });
  ro.observe(barEl);
  window.addEventListener('lane-resize-end', () => {
    if (!barEl) return;
    const r = barEl.getBoundingClientRect();
    applyFit(r.width, r.height);
  });
}

export function setMusicEnabled(on: boolean): void {
  enabled = on;
  if (!barEl) return;
  // Bar stays hidden until a track is detected by poll(). Turning off hides
  // it immediately; turning on starts polling but leaves the bar hidden
  // until the first poll returns a playing track.
  barEl.style.display = 'none';
  if (on) { startPolling(); startLyricsTimer(); }
  else { stopPolling(); stopLyricsTimer(); }
}

// Silence unused-var warning when artworkImg is only held as reference.
export const __keepAlive = () => artworkImg;
