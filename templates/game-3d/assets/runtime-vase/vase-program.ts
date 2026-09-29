import type { EntityHandle } from '@forgeax/engine/ecs';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import { PackageId } from '@forgeax/engine/pack/guid';
import { definePackageId } from '@forgeax/engine/pack/source';

export const VASE_GENERATOR = definePackageId('019fb7ce-3e00-7000-8000-000000000001');
export const VASE_INSTANCE = definePackageId('019fb7ce-3e00-7000-8000-000000000002');
export const VASE_PLUGIN = definePackageId('019fb7ce-3e00-7000-8000-000000000000');
export const VASE_CHANNEL = 'game-3d/runtime-vase';
export const VASE_PARAMETERS = [
  { name: 'height', type: 'f32', default: 2.4, minimum: 1, maximum: 4 },
  { name: 'radius', type: 'f32', default: 0.75, minimum: 0.4, maximum: 1.3 },
  { name: 'sides', type: 'u32', default: 32, minimum: 8, maximum: 64 },
] as const;
export type VaseValues = Record<(typeof VASE_PARAMETERS)[number]['name'], number>;
export const VASE_DEFAULTS = Object.fromEntries(
  VASE_PARAMETERS.map((parameter) => [parameter.name, parameter.default]),
) as VaseValues;
export interface VaseState {
  readonly busy: boolean;
  readonly guid: string;
  readonly values: VaseValues;
  readonly generation?: number;
  readonly entity?: EntityHandle;
  readonly vertexCount?: number;
  readonly aabb?: number[];
  readonly error?: string;
}

/** Native JS is admitted and executed only after the game starts. No variant is cooked. */
export function vaseContent(imports: Readonly<Record<string, string>>, material: string, digest: string) {
  return {
    source: {
      schemaVersion: '2.0.0' as const,
      kind: 'scriptable-pack-source' as const,
      source: 'Runtime vase.js',
      packageId: PackageId.format(VASE_GENERATOR),
      program: 'game-3d/vase',
      runtime: { dependencies: [material] },
      parameters: VASE_PARAMETERS,
    },
    dependencies: { [material]: digest },
    programs: {
      'game-3d/vase': {
        artifact: preparePackProgram({
          entry: 'vase.js',
          export: 'build',
          imports: Object.fromEntries(
            ['@forgeax/engine/geometry', '@forgeax/engine/pack/source'].map((name) => [name, imports[name]]),
          ),
          modules: {
            'vase.js': `import { createRevolutionGeometry } from '@forgeax/engine/geometry';
import { AssetGuid } from '@forgeax/engine/pack/source';
export function build({ values }) {
  const { height, radius, sides } = values;
  const profile = [[0, 0], [0.55, 0], [0.65, 0.08], [1, 0.35],
    [0.9, 0.58], [0.4, 0.82], [0.42, 0.96], [0.55, 1],
    [0.47, 1], [0.34, 0.95], [0.32, 0.82], [0.82, 0.58],
    [0.9, 0.35], [0.55, 0.12], [0, 0.12]];
  const material = AssetGuid.parse(${JSON.stringify(material)});
  if (!material.ok) return material;
  const mesh = createRevolutionGeometry(profile.map(([x, y]) => ({ x: x * radius, y: y * height })), sides).unwrap();
  return { ok: true, value: { vase: { ...mesh,
    materialSlots: [{ slotName: 'surface', sourceKey: 'game-3d:vase',
      defaultMaterial: material.value }],
  } } };
}`,
          },
        }).unwrap(),
      },
    },
  };
}
