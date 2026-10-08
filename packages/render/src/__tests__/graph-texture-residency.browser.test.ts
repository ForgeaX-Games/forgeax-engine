import { it } from 'vitest';
import { verifyGraphTextureResidency } from './graph-texture-residency.gpu-fixture';

it('keeps graph mip residency private and replays both source generations', async () => {
  await verifyGraphTextureResidency();
}, 60_000);
