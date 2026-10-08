import { fileURLToPath } from 'node:url';
import {
  type CookedMaterialRecord,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import type { MaterialAsset } from '@forgeax/engine-types';
import { standardSurfaceParameters } from '@forgeax/engine-types';
import { beforeAll, expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker.js';

// The installed SDK failed this exact authored Surface after renderer recovery
// selected WebGL2. Cook its real source; no driver or synthetic program fixture.
const source: MaterialAsset = {
  kind: 'material',
  parameters: standardSurfaceParameters([
    { name: 'ironColor', type: 'color' },
    { name: 'rustDark', type: 'color' },
    { name: 'rustBright', type: 'color' },
    { name: 'noiseScale', type: 'f32' },
  ]),
  values: {
    ironColor: [0.4, 0.45, 0.47, 1],
    rustDark: [0.42, 0.085, 0.018, 1],
    rustBright: [0.95, 0.34, 0.055, 1],
    noiseScale: 1.85,
  },
  passes: [
    {
      name: 'forward',
      program: {
        module: 'forgeax_material::standard',
        fragmentEntry: 'fs_main',
        moduleSlots: { surface: 'game_3d::rusted_iron_surface' },
      },
    },
  ],
};

let record: CookedMaterialRecord;

beforeAll(async () => {
  const root = fileURLToPath(
    new URL('../../../../../templates/game-3d/assets/shaders/', import.meta.url),
  );
  const cooked = await createMaterialPackCooker([root]).cook({
    guid: '6c771936-3236-50c4-956c-ec4baa8fd381',
    source,
  });
  record = validateCookedMaterialRecord((cooked.payload as { cooked: unknown }).cooked).unwrap();
}, 60_000);

it.each([
  ['webgpu', 'storage-buffer'],
  ['webgpu', 'uniform-fallback'],
  ['webgl2', 'uniform-fallback'],
] as const)('publishes one direct authored program for %s/%s', (backend, capability) => {
  const programs = record.programs.filter((program) =>
    program.selections.some(
      (selection) =>
        selection.context.pipeline !== 'ray' &&
        selection.pass === 'forward' &&
        selection.context.backend === backend &&
        selection.context.capability === capability &&
        selection.context.geometry === 'mesh' &&
        selection.context.visibleSurface !== true &&
        selection.address === 'direct',
    ),
  );
  expect(programs).toHaveLength(1);
  expect(programs[0]?.artifact.bytes.byteLength).toBeGreaterThan(0);
  if (capability === 'uniform-fallback') {
    expect(
      record.programs.some((program) =>
        program.selections.some(
          (selection) =>
            selection.context.backend === backend &&
            selection.context.capability === capability &&
            selection.address === 'scene-index',
        ),
      ),
    ).toBe(false);
  }
});
