import { webkit } from 'playwright';

const browser = await webkit.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto('about:blank');
const r = await page.evaluate(() => ({
  hasGpu: 'gpu' in navigator,
  gpuType: typeof navigator.gpu,
  ua: navigator.userAgent,
}));
console.log(JSON.stringify(r, null, 2));
await browser.close();
