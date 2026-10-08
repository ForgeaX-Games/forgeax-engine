import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  serializeCookedMaterialRecord,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import type { MaterialAsset } from '@forgeax/engine-types';
import { beforeAll, expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker.js';

async function buildPublicationScenario() {
  const root = await mkdtemp(join(tmpdir(), 'material-program-publication-'));
  try {
    for (const [name, factor] of [
      ['first', 1],
      ['second', 2],
    ] as const) {
      await writeFile(
        join(root, `${name}.wgsl`),
        `#define_import_path game::${name}
#import forgeax_material::parameters::{material}
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return material.baseColor * ${factor}.0; }
`,
      );
    }
    const source: MaterialAsset = {
      kind: 'material',
      parameters: [{ name: 'baseColor', type: 'vec4' }],
      values: { baseColor: [1, 0, 0, 1] },
      passes: [
        {
          name: 'Forward',
          program: { module: 'game::first', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
        },
        {
          name: 'Overlay',
          program: { module: 'game::second', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
        },
      ],
    };
    const cooker = createMaterialPackCooker([root]);
    const first = await cooker.cook({ guid: 'first-root', source });
    const record = validateCookedMaterialRecord(
      (first.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const second = await cooker.cook({
      guid: 'second-root',
      source: { ...source, values: { baseColor: [0, 1, 0, 1] } },
    });
    const changed = validateCookedMaterialRecord(
      (second.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const editedPath = join(root, 'second.wgsl');
    await writeFile(editedPath, (await readFile(editedPath, 'utf8')).replace('2.0', '3.0'));
    const edited = await cooker.cook({ guid: 'first-root', source, cookGeneration: 2 });
    const editedRecord = validateCookedMaterialRecord(
      (edited.payload as { cooked: unknown }).cooked,
    ).unwrap();
    return { first, record, changed, editedRecord };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let scenario: Awaited<ReturnType<typeof buildPublicationScenario>>;

beforeAll(async () => {
  scenario = await buildPublicationScenario();
});

it('publishes independent pass artifacts in both View capability layouts', () => {
  expect(scenario.record.programs).toHaveLength(4);
  expect(Object.keys(scenario.first.artifacts)).toHaveLength(2);
  for (const capability of ['storage-buffer', 'storage-buffer-atmosphere']) {
    const programs = scenario.record.programs.filter((program) =>
      program.selections.some((selection) => selection.context.capability === capability),
    );
    expect(
      programs.map((program) => program.selections.map((selection) => selection.pass)),
    ).toEqual([['Forward'], ['Overlay']]);
    expect(new Set(programs.map((program) => program.specializationKey)).size).toBe(2);
  }
});

it('reuses programs across GUIDs while changing material publication identity', () => {
  expect(scenario.changed.programs).toEqual(scenario.record.programs);
  expect(scenario.changed.receipt.identity.materialPublicationIdentity).not.toBe(
    scenario.record.receipt.identity.materialPublicationIdentity,
  );
});

it('rereads shader bytes at the same source path and publishes the new generation', () => {
  expect(scenario.editedRecord.programs[0]).toEqual(scenario.record.programs[0]);
  expect(scenario.editedRecord.programs[1]?.artifact.digest).not.toBe(
    scenario.record.programs[1]?.artifact.digest,
  );
  expect(scenario.editedRecord.receipt.identity.cookGeneration).toBe(2);
  expect(scenario.editedRecord.receipt.identity.artifactDigest).not.toBe(
    scenario.record.receipt.identity.artifactDigest,
  );
});

it('keeps native shader bytes binary until the Pack transport boundary', () => {
  const native = (
    scenario.first.payload as { cooked: { programs: { artifact: { bytes: unknown } }[] } }
  ).cooked;
  expect(native.programs[0]?.artifact.bytes).toBeInstanceOf(Uint8Array);
  const wire = JSON.parse(serializeCookedMaterialRecord(scenario.record));
  expect(Array.isArray(wire.programs[0].artifact.bytes)).toBe(true);
  expect(validateCookedMaterialRecord(wire).unwrap().programs).toEqual(scenario.record.programs);
});
