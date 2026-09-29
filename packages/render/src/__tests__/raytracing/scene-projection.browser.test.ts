import { it } from 'vitest';
import { loadPublishedRayKernels } from './published-kernels.fixture';
import { verifyRetainedRayScene } from './scene-projection.gpu-fixture';

it('traces retained offscreen contributors and replays edits after original resources retire', async () => {
  await verifyRetainedRayScene((await loadPublishedRayKernels('/shaders/manifest.json')).query);
}, 60_000);
