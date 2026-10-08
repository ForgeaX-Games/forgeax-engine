import { it } from 'vitest';
import { verifySdfStorage } from './sdf-storage.fixture';
import { verifyVisibilitySdf } from './sdf-visibility.fixture';

it('builds, traces and replays sampled visibility in browser WebGPU', async () => {
  await verifyVisibilitySdf();
}, 120000);

it('decodes all shared-brick and geometric texels and replays browser WebGPU', async () => {
  await verifySdfStorage();
});
