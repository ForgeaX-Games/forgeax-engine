import { chromium } from 'playwright';
import { preview } from 'vite';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5199;
const server = await preview({
  preview: { host: '127.0.0.1', port, strictPort: true },
  logLevel: 'error',
});

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('preview server deadline exceeded');
}

function assertFaultView(view) {
  if (view.status === 'running') throw new Error('fault view still presents the Engine as running');
  if (!view.summary.includes('faulted') || !view.summary.includes('shared-kernel-failed')) {
    throw new Error('fault view summary omits the stopped state or stable fault code');
  }
  if (!view.report.includes('shared-kernel-failed')) {
    throw new Error('fault view omits the stable shared-kernel-failed code');
  }
  if (view.rebuildHidden) throw new Error('fault view hides the rebuild action');
}

try {
  await waitForServer();
  const browser = await chromium.launch(chromeLaunchOptions());
  const reports = [];
  for (const tier of ['main-serial', 'engine-worker', 'shared']) {
    const page = await browser.newPage();
    const errors = [];
    const logs = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    await page.goto(`http://127.0.0.1:${port}/?tier=${tier}`, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForFunction(() => globalThis.__forgeaxExecutionReady === true, null, { timeout: 30_000 });
    } catch (error) {
      const output = await page.locator('#execution-report').textContent();
      throw new Error(`${tier} did not become ready: ${String(error)}; output=${output}; errors=${errors.join(' | ')}; logs=${logs.join(' | ')}`);
    }
    const report = JSON.parse(await page.locator('#execution-report').textContent());
    if (report.actualTier !== tier) throw new Error(`unexpected tier: ${report.actualTier}`);
    const expectedRealm = tier === 'main-serial' ? 'host' : 'worker';
    if (report.engine.realm !== expectedRealm) throw new Error(`unexpected realm: ${report.engine.realm}`);
    if (report.world.identity === null) throw new Error('missing World identity');
    if (tier === 'shared' && report.kernelDispatch.usedShared !== true) {
      throw new Error(`shared kernel did not dispatch: ${JSON.stringify(report.kernelDispatch)}`);
    }
    if (errors.length > 0) throw new Error(`browser errors: ${errors.join(' | ')}`);
    reports.push({ tier, worldIdentity: report.world.identity, kernelDispatch: report.kernelDispatch });
    await page.close();
  }
  const faultPage = await browser.newPage();
  const faultErrors = [];
  faultPage.on('pageerror', (error) => faultErrors.push(error.message));
  await faultPage.goto(`http://127.0.0.1:${port}/?tier=shared&fault=1`, {
    waitUntil: 'domcontentloaded',
  });
  await faultPage.waitForFunction(
    () => globalThis.__forgeaxExecutionReport?.().world.health === 'poisoned',
    null,
    { timeout: 30_000 },
  );
  const poisoned = await faultPage.evaluate(() => globalThis.__forgeaxExecutionReport());
  if (poisoned.world.partialWrite !== true || poisoned.world.retryable !== false) {
    throw new Error(`fault did not poison World: ${JSON.stringify(poisoned.world)}`);
  }
  if (poisoned.fault?.code !== 'shared-kernel-failed') {
    throw new Error(`unexpected fault: ${JSON.stringify(poisoned.fault)}`);
  }
  const frozenSamples = poisoned.performance.hostFrameMs?.samples ?? 0;
  await faultPage.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
  const stopped = await faultPage.evaluate(() => ({
    status: document.querySelector('#execution-report')?.getAttribute('data-status'),
    summary: document.querySelector('#execution-summary')?.textContent ?? '',
    report: document.querySelector('#execution-report')?.textContent ?? '',
    rebuildHidden: document.querySelector('#rebuild')?.hasAttribute('hidden') ?? true,
    samples: globalThis.__forgeaxExecutionReport?.().performance.hostFrameMs?.samples ?? 0,
  }));
  assertFaultView(stopped);
  if (stopped.samples !== frozenSamples) {
    throw new Error(`fault view frame samples advanced after poison: ${frozenSamples} -> ${stopped.samples}`);
  }
  const falsified = await faultPage.evaluate(() => {
    const output = document.querySelector('#execution-report');
    const rebuild = document.querySelector('#rebuild');
    output?.setAttribute('data-status', 'running');
    rebuild?.setAttribute('hidden', '');
    return {
      status: output?.getAttribute('data-status'),
      summary: document.querySelector('#execution-summary')?.textContent ?? '',
      report: output?.textContent ?? '',
      rebuildHidden: rebuild?.hasAttribute('hidden') ?? true,
    };
  });
  let falsificationCaught = false;
  try {
    assertFaultView(falsified);
  } catch {
    falsificationCaught = true;
  }
  if (!falsificationCaught) throw new Error('fault-view falsification was not detected');
  await faultPage.waitForFunction(() => {
    const output = document.querySelector('#execution-report');
    const rebuild = document.querySelector('#rebuild');
    return output?.getAttribute('data-status') !== 'running' && rebuild?.hasAttribute('hidden') === false;
  });
  const oldIdentity = poisoned.world.identity;
  await faultPage.getByRole('button', { name: 'Rebuild poisoned World' }).click();
  await faultPage.waitForFunction(
    (identity) => {
      const report = globalThis.__forgeaxExecutionReport?.();
      return report?.engine.health === 'running' && report.world.identity !== identity;
    },
    oldIdentity,
    { timeout: 30_000 },
  );
  const rebuilt = await faultPage.evaluate(() => globalThis.__forgeaxExecutionReport());
  if (rebuilt.world.health !== 'healthy' || rebuilt.fault !== null) {
    throw new Error(`rebuild did not recover: ${JSON.stringify(rebuilt)}`);
  }
  if (faultErrors.length > 0) throw new Error(`fault page errors: ${faultErrors.join(' | ')}`);
  reports.push({
    tier: 'shared-fault-rebuild',
    oldWorldIdentity: oldIdentity,
    worldIdentity: rebuilt.world.identity,
    kernelDispatch: rebuilt.kernelDispatch,
  });
  await faultPage.close();
  await browser.close();
  process.stdout.write(`${JSON.stringify({ ok: true, reports })}\n`);
} finally {
  await server.close();
}
