import { it } from 'vitest';
import { verifyProbeCardSupport } from './probe-card-support.fixture';

it('preserves the Global caller truth table independently of Surface RGB and replays after disposal', async () => {
  await verifyProbeCardSupport();
}, 60000);
