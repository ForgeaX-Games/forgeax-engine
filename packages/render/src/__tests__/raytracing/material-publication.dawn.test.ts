import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'vitest';
import { verifyPublishedRayMaterial } from './material-publication.gpu-fixture';
import { prepareRayPathFixture } from './path-tracer.commands';

it('traces with accepted material snapshots and replays retired parameter, Surface and transport outputs', async () => {
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  const result = await verifyPublishedRayMaterial(await prepareRayPathFixture(), async (bytes) => {
    if (directory) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'material-publication.rhitape'), bytes);
    }
  });
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'material-publication.json'),
      JSON.stringify(result.facts, null, 2),
    );
    await writeFile(
      join(directory, 'material-preparation.json'),
      JSON.stringify(result.preparationFences, null, 2),
    );
    for (const [stage, output] of result.transportOutputs.entries())
      await writeFile(join(directory, `material-transport-${stage}.bin`), output);
    for (const [stage, output] of result.outputs.entries()) {
      await writeFile(join(directory, `material-surface-${stage}.bin`), output);
      await writeFile(
        join(directory, `material-row-${stage}.bin`),
        result.rows[stage] as Uint8Array,
      );
    }
  }
}, 120_000);
