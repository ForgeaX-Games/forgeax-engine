import { it } from 'vitest';
import { commands } from 'vitest/browser';
import type { DiffuseReconstructionFixture } from './diffuse-reconstruction.commands';
import { verifyDiffuseReconstruction } from './diffuse-reconstruction.fixture';
import { loadPublishedRayKernels } from './published-kernels.fixture';

declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareDiffuseReconstructionFixture(): Promise<DiffuseReconstructionFixture>;
  }
}
it('rejects incompatible history and reconstructs raw diffuse with exact history replay', async () => {
  const published = await loadPublishedRayKernels('/shaders/manifest.json');
  await verifyDiffuseReconstruction(
    {
      ...(await commands.prepareDiffuseReconstructionFixture()),
      kernel: published.reconstruction,
    },
    () => {},
  );
}, 120000);
