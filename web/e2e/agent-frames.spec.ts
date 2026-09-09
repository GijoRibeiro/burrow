import { test, type Page } from '@playwright/test';

// Visual checks for agent-grid responsive behavior. Drives the layout
// into a narrow column and a wide column so we can eyeball the
// "horizontal list row" narrow mode vs the "stretched cards" wide
// mode in the captured screenshots.

async function gotoFresh(page: Page) {
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto('/legacy.html');
  await page.waitForSelector('[data-layout-section="chat"]');
  await page.waitForSelector('[data-layout-section="agent-grid"]');
}

async function dragHandleTo(page: Page, sectionId: string, target: { x: number; y: number }) {
  const handle = page.locator(`[data-layout-section-id="${sectionId}"][data-layout-kind="leaf"] > .layout-drag-handle`);
  await handle.waitFor({ state: 'attached' });
  const box = await handle.boundingBox();
  if (!box) throw new Error(`no handle for ${sectionId}`);
  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(sx + (target.x - sx) * (i / 10), sy + (target.y - sy) * (i / 10));
  }
  await page.mouse.up();
}

async function dragDivider(page: Page, target: { x: number; y: number }) {
  const divider = page.locator('.layout-divider').first();
  const box = await divider.boundingBox();
  if (!box) throw new Error('no divider');
  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(sx + (target.x - sx) * (i / 10), sy + (target.y - sy) * (i / 10));
  }
  await page.mouse.up();
}

test('agent-grid: wide horizontal split, cards stretch', async ({ page }) => {
  await gotoFresh(page);
  // Drag agent-grid to right of chat, keep agents on a wide ~50% slot.
  const w = 1280, h = 800;
  await dragHandleTo(page, 'agent-grid', { x: w * 0.95, y: h * 0.5 });
  await page.screenshot({ path: 'test-results/agents-wide.png', fullPage: false });
});

test('agent-grid: narrow column → horizontal list rows', async ({ page }) => {
  await gotoFresh(page);
  const w = 1280, h = 800;
  // Put agents on the right
  await dragHandleTo(page, 'agent-grid', { x: w * 0.95, y: h * 0.5 });
  // Then drag the divider far to the right so agents takes only ~250px
  await dragDivider(page, { x: w * 0.82, y: h * 0.5 });
  await page.screenshot({ path: 'test-results/agents-narrow.png', fullPage: false });
});

test('agent-grid: full top, stretched row', async ({ page }) => {
  await gotoFresh(page);
  const w = 1280, h = 800;
  // Drag agent-grid to TOP of chat — agents takes full width on top half
  await dragHandleTo(page, 'agent-grid', { x: w * 0.5, y: h * 0.05 });
  await page.screenshot({ path: 'test-results/agents-top-row.png', fullPage: false });
});
