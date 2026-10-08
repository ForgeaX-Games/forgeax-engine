import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifySubmittedTextures } from './submitted-textures.gpu-fixture';

it('traces dynamic MASK through accepted texture and sampler residency and fresh replay', async () => {
  await verifySubmittedTextures(await commands.prepareRayPublicationFixture('cutout'));
}, 120_000);
