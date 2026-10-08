import { it } from 'vitest';
import { verifyCloudWindHistory } from './cloud-wind-history.fixture';

it('accepts advected history and rejects unadvected history, cuts and disocclusion', async () => {
  await verifyCloudWindHistory();
}, 30_000);
