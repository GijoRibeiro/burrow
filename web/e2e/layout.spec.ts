import { test, expect, type Page } from '@playwright/test';

// These tests drive the modular layout system in a real Chromium. They
// simulate pointer-based drags against the in-page drag handles and
// verify the resulting tree shape. The dev server doesn't need a daemon
// running — the layout system is purely client-side; the only thing
// that requires the daemon is WebSocket data, which we don't touch.

async function gotoFresh(page: Page) {
  // Clear localStorage before every test so layout starts empty (only
  // the initial chat + agent-grid leaves are present after init).
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch {}
  });
  await page.goto('/legacy.html');
  // Wait for the layout-root to appear and host our two known sections.
  await page.waitForSelector('[data-layout-section="chat"]');
  await page.waitForSelector('[data-layout-section="agent-grid"]');
}

// Drag the section's drag handle from its current position to a target
// XY in the viewport, simulating pointer events. The layout system uses
// PointerEvent so this maps 1:1 to its drag handler.
async function dragHandleTo(page: Page, sectionId: string, target: { x: number; y: number }) {
  // The drag handle is a sibling of the section host inside the leaf
  // wrapper. Use a CSS selector that finds the wrapper for this section.
  const handle = page.locator(`[data-layout-section-id="${sectionId}"][data-layout-kind="leaf"] > .layout-drag-handle`);
  await handle.waitFor({ state: 'attached' });
  const box = await handle.boundingBox();
  if (!box) throw new Error(`no bounding box for handle of ${sectionId}`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  // Send a pointerdown directly on the handle (mouse.move + down also
  // works, but we want to be precise — Playwright's mouse uses pointer
  // events under the hood).
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Move in steps so the layout sees ongoing pointermove events
  // (pointermove is what paints the drop overlay and updates lastTarget).
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const x = startX + (target.x - startX) * (i / steps);
    const y = startY + (target.y - startY) * (i / steps);
    await page.mouse.move(x, y);
  }
  await page.mouse.up();
}

async function readTree(page: Page) {
  return await page.evaluate(() => {
    const api = (window as any).__layout;
    if (!api) return null;
    return api.getTree();
  });
}

async function leafWrapperBox(page: Page, sectionId: string) {
  const wrap = page.locator(`[data-layout-section-id="${sectionId}"][data-layout-kind="leaf"]`);
  await wrap.waitFor({ state: 'attached' });
  const box = await wrap.boundingBox();
  if (!box) throw new Error(`no bounding box for wrapper of ${sectionId}`);
  return box;
}

test.describe('layout drag-and-drop', () => {
  test('initial layout renders chat + agent-grid as known sections', async ({ page }) => {
    await gotoFresh(page);
    const tree = await readTree(page);
    expect(tree).toBeTruthy();
    // Both must be reachable in the tree
    const sections = await page.evaluate(() => {
      function collect(n: any): string[] {
        if (!n) return [];
        if (n.kind === 'leaf') return [n.section];
        if (n.kind === 'tabs') return n.tabs;
        return [...collect(n.children[0]), ...collect(n.children[1])];
      }
      return collect((window as any).__layout.getTree().root);
    });
    expect(sections).toContain('chat');
    expect(sections).toContain('agent-grid');
  });

  test('drag agent-grid onto right edge of chat → horizontal split', async ({ page }) => {
    await gotoFresh(page);
    const chatBox = await leafWrapperBox(page, 'chat');
    // Right edge of chat = (chat.x + chat.width - 5%, chat.y + chat.height/2)
    const targetX = chatBox.x + chatBox.width - chatBox.width * 0.05;
    const targetY = chatBox.y + chatBox.height / 2;
    await dragHandleTo(page, 'agent-grid', { x: targetX, y: targetY });

    // After drop the tree should be a horizontal split with chat on the
    // left and agent-grid on the right (or whichever orientation given
    // the initial layout).
    const tree = await readTree(page);
    expect(tree.root.kind).toBe('split');
    expect(tree.root.orientation).toBe('horizontal');
  });

  test('drag agent-grid onto center of chat → tabs', async ({ page }) => {
    await gotoFresh(page);
    const chatBox = await leafWrapperBox(page, 'chat');
    const targetX = chatBox.x + chatBox.width / 2;
    const targetY = chatBox.y + chatBox.height / 2;
    await dragHandleTo(page, 'agent-grid', { x: targetX, y: targetY });

    const tree = await readTree(page);
    // Center drop → tabs node containing both sections.
    function findTabs(n: any): any {
      if (!n) return null;
      if (n.kind === 'tabs') return n;
      if (n.kind === 'split') return findTabs(n.children[0]) || findTabs(n.children[1]);
      return null;
    }
    const tabs = findTabs(tree.root);
    expect(tabs).toBeTruthy();
    expect(tabs.tabs).toContain('chat');
    expect(tabs.tabs).toContain('agent-grid');
  });

  test('layout persists across reload', async ({ page }) => {
    await gotoFresh(page);
    const chatBox = await leafWrapperBox(page, 'chat');
    await dragHandleTo(page, 'agent-grid', {
      x: chatBox.x + chatBox.width - chatBox.width * 0.05,
      y: chatBox.y + chatBox.height / 2,
    });
    const before = await readTree(page);
    expect(before.root.kind).toBe('split');

    await page.reload();
    await page.waitForSelector('[data-layout-section="chat"]');
    const after = await readTree(page);
    expect(after.root.kind).toBe('split');
  });

  test('phantom legacy ids (top-controls / debug-panel) are scrubbed on load', async ({ page }) => {
    // Pre-seed localStorage with a layout tree that contains junk ids,
    // then load the page and verify the layout system pruned them.
    await page.addInitScript(() => {
      const tree = {
        version: 1,
        tree: {
          kind: 'split',
          orientation: 'vertical',
          split: 0.5,
          children: [
            { kind: 'leaf', section: 'chat' },
            {
              kind: 'split',
              orientation: 'horizontal',
              split: 0.5,
              children: [
                { kind: 'leaf', section: 'top-controls' },
                { kind: 'leaf', section: 'debug-panel' },
              ],
            },
          ],
        },
      };
      try {
        localStorage.setItem('layoutTree', JSON.stringify(tree));
        localStorage.setItem('layoutTreeV1Migrated', '1');
      } catch {}
    });
    await page.goto('/legacy.html');
    await page.waitForSelector('[data-layout-section="chat"]');
    const sections = await page.evaluate(() => {
      function collect(n: any): string[] {
        if (!n) return [];
        if (n.kind === 'leaf') return [n.section];
        if (n.kind === 'tabs') return n.tabs;
        return [...collect(n.children[0]), ...collect(n.children[1])];
      }
      return collect((window as any).__layout.getTree().root);
    });
    expect(sections).not.toContain('top-controls');
    expect(sections).not.toContain('debug-panel');
    expect(sections).toContain('chat');
  });

  test('close button hides a section, shelf restores it', async ({ page }) => {
    await gotoFresh(page);
    // First add music-bar to the registry by faking it: we insert via the
    // window API since music isn't loaded by default in the bare dev page.
    await page.evaluate(() => {
      (window as any).__layout.unhideSection('music-bar');
    });
    // Now hide it via the API (close button needs hover, which is fiddly
    // in the harness — we test the underlying behavior via the API).
    await page.evaluate(() => {
      (window as any).__layout.hideSection('music-bar');
    });
    const after = await page.evaluate(() => {
      return {
        hidden: (window as any).__layout.hiddenSections(),
        sections: (function collect(n: any): string[] {
          if (!n) return [];
          if (n.kind === 'leaf') return [n.section];
          if (n.kind === 'tabs') return n.tabs;
          return [...collect(n.children[0]), ...collect(n.children[1])];
        })((window as any).__layout.getTree().root),
      };
    });
    expect(after.sections).not.toContain('music-bar');
    expect(after.hidden).toContain('music-bar');

    // Restore via API and confirm it lands back in the tree.
    await page.evaluate(() => (window as any).__layout.unhideSection('music-bar'));
    const restored = await page.evaluate(() => {
      return (function collect(n: any): string[] {
        if (!n) return [];
        if (n.kind === 'leaf') return [n.section];
        if (n.kind === 'tabs') return n.tabs;
        return [...collect(n.children[0]), ...collect(n.children[1])];
      })((window as any).__layout.getTree().root);
    });
    expect(restored).toContain('music-bar');
  });

  test('always-on sections refuse hide', async ({ page }) => {
    await gotoFresh(page);
    await page.evaluate(() => (window as any).__layout.hideSection('chat'));
    const after = await page.evaluate(() => {
      return (function collect(n: any): string[] {
        if (!n) return [];
        if (n.kind === 'leaf') return [n.section];
        if (n.kind === 'tabs') return n.tabs;
        return [...collect(n.children[0]), ...collect(n.children[1])];
      })((window as any).__layout.getTree().root);
    });
    expect(after).toContain('chat');
  });

  test('divider drag updates split fraction', async ({ page }) => {
    await gotoFresh(page);
    const chatBox = await leafWrapperBox(page, 'chat');
    await dragHandleTo(page, 'agent-grid', {
      x: chatBox.x + chatBox.width - chatBox.width * 0.05,
      y: chatBox.y + chatBox.height / 2,
    });
    const treeBefore = await readTree(page);
    const splitBefore = treeBefore.root.split;

    // Find the divider, drag it left by 100px
    const divider = page.locator('.layout-divider').first();
    const dbox = await divider.boundingBox();
    if (!dbox) throw new Error('no divider bounding box');
    const startX = dbox.x + dbox.width / 2;
    const startY = dbox.y + dbox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(startX - 100 * (i / 10), startY);
    }
    await page.mouse.up();

    const treeAfter = await readTree(page);
    expect(treeAfter.root.split).not.toBeCloseTo(splitBefore, 1);
  });
});
