import { it } from 'vitest';
import { loadPublishedRayKernels } from './published-kernels.fixture';
import { verifyRayReference } from './query.fixture';

it(
  'captures and independently replays opaque ray queries in the browser',
  async () => verifyRayReference((await loadPublishedRayKernels('/shaders/manifest.json')).query),
  60_000,
);
