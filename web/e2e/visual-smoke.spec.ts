import { test, expect, type Page } from '@playwright/test';

// Visual smoke test — drives the layout into a few interesting shapes,
// captures screenshots for human review, and asserts no console errors.
//
// Screenshots land in test-results/ for inspection. Not pixel-comparison
// (sprites animate, dates change) — these are for "did it visually
// render at all" + a record we can eyeball.

async function gotoFresh(page: Page) {
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  (page as any).__errors = errors;
  // These are layout tests. Isolate the optional agent backend so they
  // run on a clean checkout without reading a developer's live agents.
  await page.route('http://localhost:3333/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const data = path === '/api/creatures' ? [] : path === '/api/preflight'
      ? { status: 'ok', okCount: 0, warnCount: 0, errorCount: 0, checks: [], diagnostics: {}, generatedAt: '' }
      : {};
    await route.fulfill({ json: data, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.routeWebSocket('ws://localhost:3333/ws', socket => {
    socket.send(JSON.stringify({ type: 'state', agents: [] }));
  });
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

async function leafBox(page: Page, sectionId: string) {
  const wrap = page.locator(`[data-layout-section-id="${sectionId}"][data-layout-kind="leaf"]`);
  const box = await wrap.boundingBox();
  if (!box) throw new Error(`no wrapper for ${sectionId}`);
  return box;
}

test('visual: initial layout', async ({ page }) => {
  await gotoFresh(page);
  await page.screenshot({ path: 'test-results/01-initial.png', fullPage: false });
  expect((page as any).__errors).toEqual([]);
});

test('visual: agent-grid split right of chat', async ({ page }) => {
  await gotoFresh(page);
  const cb = await leafBox(page, 'chat');
  await dragHandleTo(page, 'agent-grid', { x: cb.x + cb.width - cb.width * 0.05, y: cb.y + cb.height / 2 });
  await page.screenshot({ path: 'test-results/02-split-right.png', fullPage: false });
  expect((page as any).__errors).toEqual([]);
});

test('visual: agent-grid + chat in tabs', async ({ page }) => {
  await gotoFresh(page);
  const cb = await leafBox(page, 'chat');
  await dragHandleTo(page, 'agent-grid', { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 });
  await page.screenshot({ path: 'test-results/03-tabs.png', fullPage: false });
  expect((page as any).__errors).toEqual([]);
});

test('visual: vertical split (top)', async ({ page }) => {
  await gotoFresh(page);
  const cb = await leafBox(page, 'chat');
  await dragHandleTo(page, 'agent-grid', { x: cb.x + cb.width / 2, y: cb.y + cb.height * 0.05 });
  await page.screenshot({ path: 'test-results/04-vertical.png', fullPage: false });
  expect((page as any).__errors).toEqual([]);
});
