import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { waitGizmoFrames } from '../browser-host.mjs';
import { smokeFrameBudget } from '../../../../shared/scripts/smoke-receipt.mjs';

test('the submitted-frame admission uses its declared budget with real Playwright', async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome-beta',
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20);
    await page.setContent('<div>Frame admission contract</div>', { timeout: 10000 });
    const observed = smokeFrameBudget() + 1;
    await page.evaluate((observed) => {
      let frames = 0;
      globalThis.__gizmo = { frames: () => frames };
      setTimeout(() => { frames = observed; }, 100);
    }, observed);
    await waitGizmoFrames(page);
    assert.equal(await page.evaluate(() => globalThis.__gizmo.frames()), observed);
  } finally {
    await browser.close();
  }
});

test('the real frame admission honors an explicit smoke minimum', async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome-beta',
  });
  const previous = process.env.SMOKE_MIN_FRAMES;
  try {
    process.env.SMOKE_MIN_FRAMES = '300';
    const page = await browser.newPage();
    await page.setContent('<div>Explicit completed-frame minimum</div>');
    await page.evaluate(() => {
      let frames = 61;
      globalThis.__gizmo = { frames: () => frames };
      setTimeout(() => { frames = 301; }, 100);
    });
    await waitGizmoFrames(page);
    assert.equal(await page.evaluate(() => globalThis.__gizmo.frames()), 301);
  } finally {
    if (previous === undefined) delete process.env.SMOKE_MIN_FRAMES;
    else process.env.SMOKE_MIN_FRAMES = previous;
    await browser.close();
  }
});
