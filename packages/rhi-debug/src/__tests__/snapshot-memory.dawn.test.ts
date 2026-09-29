import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'vitest';
import { verifyCancelledSnapshotHash, verifySnapshotMemory } from './snapshot-memory.fixture';

it('bounds texture snapshot staging and replays complete array/mip seeds', async () => {
  const { bytes, ...result } = await verifySnapshotMemory();
  if (process.env.FORGEAX_RAY_EVIDENCE) {
    const dir = process.env.FORGEAX_RAY_EVIDENCE;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'snapshot-memory.rhitape'), bytes);
    await writeFile(join(dir, 'snapshot-memory.json'), JSON.stringify(result, null, 2));
  }
}, 120000);

it(
  'does not publish a cancelled snapshot after its native digest completes',
  verifyCancelledSnapshotHash,
);
