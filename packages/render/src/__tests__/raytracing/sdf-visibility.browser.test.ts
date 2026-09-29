import { it } from 'vitest';
import { verifySdfStorage } from './sdf-storage.fixture';
import { verifyVisibilitySdf } from './sdf-visibility.fixture';

it('builds, traces and replays sampled visibility in browser WebGPU', async () => {
  await verifyVisibilitySdf();
}, 120000);

it('reads and replays mixed SNORM16 and geometric fields in browser WebGPU', async () => {
  await verifySdfStorage();
});
