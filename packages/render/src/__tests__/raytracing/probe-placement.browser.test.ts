import { it } from 'vitest';
import { commands } from 'vitest/browser';
import type { ProbePlacementFixture } from './probe-placement.commands';
import { verifyProbePlacement } from './probe-placement.fixture';
import { loadPublishedRayKernels } from './published-kernels.fixture';

declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareProbePlacementFixture(): Promise<ProbePlacementFixture>;
  }
}
it('places candidate probes from native raster inputs without publishing accepted state', async () => {
  const published = await loadPublishedRayKernels('/shaders/manifest.json');
  await verifyProbePlacement({
    ...(await commands.prepareProbePlacementFixture()),
    kernel: published.placement,
  });
}, 120000);
