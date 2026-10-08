import { it } from 'vitest';
import { verifyGlobalSdfGpuRays } from './global-sdf-gpu-rays.fixture';

it('traces GPU-written ray ranges with browser validation and fresh replay', async () => {
  await verifyGlobalSdfGpuRays();
}, 120000);
