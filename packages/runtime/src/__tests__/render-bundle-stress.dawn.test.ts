import { mkdir, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { bundleStressCases, runRenderBundleStressCase } from './render-bundle-stress.fixture';

it.each(
  bundleStressCases,
)('keeps changing render bundles pixel-equivalent under %s', async (scenario) => {
  const directory = 'artifacts/render-bundle/stress';
  await mkdir(directory, { recursive: true });
  const result = await runRenderBundleStressCase(scenario, async (capture, frame) => {
    await writeFile(`${directory}/${scenario}-${frame}.rhitape`, capture.bytes);
  });
  await writeFile(`${directory}/${scenario}.json`, JSON.stringify(result, null, 2));
}, 180_000);
