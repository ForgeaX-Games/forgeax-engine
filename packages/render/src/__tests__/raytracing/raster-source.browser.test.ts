import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { loadPublishedRayKernels } from './published-kernels.fixture';
import type { RasterRayFixture } from './raster-source.commands';
import { verifyRasterRaySource } from './raster-source.fixture';

declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareRasterRayFixture(): Promise<RasterRayFixture>;
  }
}
it('generates receiver rays from real raster attachments and exposes invalid inputs in replay', async () => {
  const published = await loadPublishedRayKernels('/shaders/manifest.json');
  await verifyRasterRaySource(
    { ...(await commands.prepareRasterRayFixture()), kernel: published.raster },
    { ...(await commands.prepareRayPathFixture()), kernel: published.transport },
    published.composite,
  );
}, 120000);
