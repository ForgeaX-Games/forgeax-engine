import { GPU_DRIVEN_MATERIAL_ROW_BYTES } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { cookMaterialAsset, generateParameterModule } from '../cook.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

const source = `#define_import_path test::entries
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}
@vertex fn vs_main() -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  output.color = vec4<f32>(1.0);
  return output;
}
@fragment fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
  return color;
}
@fragment fn fs_wrong_input(@location(0) color: vec3<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(color, 1.0);
}
`;

async function cook(
  vertexEntry: string,
  fragmentEntry: string | undefined,
  moduleSource = source,
  passName = 'Forward',
  parameters: readonly { readonly name: string; readonly type: 'color' | 'f32' }[] = [],
) {
  const sources = buildMaterialSourceCatalog({
    engine: [],
    project: [{ path: 'entries.wgsl', source: moduleSource }],
  });
  if (!sources.ok) throw sources.error;
  return cookMaterialAsset({
    material: 'entry-validation',
    table: {
      'entry-validation': {
        kind: 'material',
        parameters,
        passes: [
          {
            name: passName,
            program: {
              module: 'test::entries',
              vertexEntry,
              ...(fragmentEntry === undefined ? {} : { fragmentEntry }),
            },
          },
        ],
      },
    },
    sources: sources.value,
  });
}

const sceneIndexSource = `#define_import_path test::entries
#import forgeax_material::parameters::{material}
struct VsInput {
  @location(0) position : vec3<f32>,
}
struct VsOutput {
  @builtin(position) clip : vec4<f32>,
}
@vertex fn vs_main(in : VsInput, @builtin(instance_index) idx : u32) -> VsOutput {
  var out : VsOutput;
  out.clip = vec4<f32>(in.position, 1.0);
  return out;
}
@vertex fn vs_scene_index(in : VsInput, @builtin(instance_index) idx : u32) -> VsOutput {
  let visible = visibleItems[idx];
  let tint = sceneMaterials[visible.y].tint;
  var out : VsOutput;
  out.clip = vec4<f32>(in.position + vec3<f32>(tint.x * 0.0), 1.0);
  return out;
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return material.tint;
}
`;

const wrongStrideSceneIndexSource = `#define_import_path test::entries
struct MaterialParameters {
  tint : vec4<f32>,
}
struct VsInput {
  @location(0) position : vec3<f32>,
}
struct VsOutput {
  @builtin(position) clip : vec4<f32>,
}
@group(1) @binding(46) var<storage, read> sceneMaterials : array<MaterialParameters>;
@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>;
@vertex fn vs_main(in : VsInput) -> VsOutput {
  var out : VsOutput;
  out.clip = vec4<f32>(in.position, 1.0);
  return out;
}
@vertex fn vs_scene_index(in : VsInput, @builtin(instance_index) idx : u32) -> VsOutput {
  let visible = visibleItems[idx];
  let tint = sceneMaterials[visible.y].tint;
  var out : VsOutput;
  out.clip = vec4<f32>(in.position + vec3<f32>(tint.x * 0.0), 1.0);
  return out;
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0);
}
`;

const wrongBindingSceneIndexSource = wrongStrideSceneIndexSource.replace(
  '@group(1) @binding(46) var<storage, read> sceneMaterials',
  '@group(2) @binding(9) var<storage, read> sceneMaterials',
);

const readOnlySceneIndexSource = `#define_import_path test::entries
struct MaterialParameters {
  tint : vec4<f32>,
  _gpuDrivenPadding : array<vec4<f32>, ${GPU_DRIVEN_MATERIAL_ROW_BYTES / 16 - 1}>,
}
struct VsInput {
  @location(0) position : vec3<f32>,
}
struct VsOutput {
  @builtin(position) clip : vec4<f32>,
}
@group(1) @binding(46) var<storage, read> sceneMaterials : array<MaterialParameters>;
@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>;
@vertex fn vs_main(in : VsInput) -> VsOutput {
  var out : VsOutput;
  out.clip = vec4<f32>(in.position, 1.0);
  return out;
}
@vertex fn vs_scene_index(in : VsInput, @builtin(instance_index) idx : u32) -> VsOutput {
  let visible = visibleItems[idx];
  let tint = sceneMaterials[visible.y].tint;
  var out : VsOutput;
  out.clip = vec4<f32>(in.position + vec3<f32>(tint.x * 0.0), 1.0);
  return out;
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0);
}
`;

const readWriteSceneMaterialsSource = readOnlySceneIndexSource.replace(
  '@group(1) @binding(46) var<storage, read> sceneMaterials',
  '@group(1) @binding(46) var<storage, read_write> sceneMaterials',
);

const readWriteVisibleItemsSource = readOnlySceneIndexSource.replace(
  '@group(3) @binding(2) var<storage, read> visibleItems',
  '@group(3) @binding(2) var<storage, read_write> visibleItems',
);

const authoredEquivalentSceneIndexSource = `#define_import_path test::entries
struct Material {
  tint : vec4<f32>,
}
struct MaterialParameters {
  tint : vec4<f32>,
  _gpuDrivenPadding : array<vec4<f32>, ${GPU_DRIVEN_MATERIAL_ROW_BYTES / 16 - 1}>,
}
@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(46) var<storage, read> sceneMaterials : array<MaterialParameters>;
@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>;
struct VsInput {
  @location(0) position : vec3<f32>,
}
struct VsOutput {
  @builtin(position) clip : vec4<f32>,
}
@vertex fn vs_main(in : VsInput) -> VsOutput {
  var out : VsOutput;
  out.clip = vec4<f32>(in.position + vec3<f32>(material.tint.x * 0.0), 1.0);
  return out;
}
@vertex fn vs_scene_index(in : VsInput, @builtin(instance_index) idx : u32) -> VsOutput {
  let visible = visibleItems[idx];
  let tint = sceneMaterials[visible.y].tint;
  var out : VsOutput;
  out.clip = vec4<f32>(in.position + vec3<f32>(tint.x * 0.0), 1.0);
  return out;
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return material.tint;
}
`;

describe('selected material graphics entries', () => {
  it('publishes a padded scene-index parameter module without changing direct-only output', () => {
    const schema = [
      { name: 'tint', type: 'color' as const },
      { name: 'roughness', type: 'f32' as const },
    ];
    const direct = generateParameterModule(schema);
    const scene = generateParameterModule(schema, { sceneIndex: true });
    const shadowScene = generateParameterModule(schema, {
      sceneIndex: true,
      visibleItemsBinding: 2,
    });
    expect(direct).not.toContain('sceneMaterials');
    expect(scene).toContain('@group(1) @binding(46) var<storage, read> sceneMaterials');
    expect(scene).toContain('_gpuDrivenPadding');
    expect(scene).toContain(`array<vec4<f32>, ${GPU_DRIVEN_MATERIAL_ROW_BYTES / 16 - 2}>`);
    expect(shadowScene).toContain(
      '@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>',
    );
  });

  it('accepts a matching stage pair', async () => {
    expect((await cook('vs_main', 'fs_main')).ok).toBe(true);
  });

  it('publishes a producer-backed custom scene-index ABI from one source closure', async () => {
    const result = await cook('vs_main', 'fs_main', sceneIndexSource, 'Forward', [
      { name: 'tint', type: 'color' },
    ]);
    expect(
      result.ok,
      result.ok ? '' : `${result.error.message} ${JSON.stringify(result.error.detail)}`,
    ).toBe(true);
    if (!result.ok) return;
    const pass = result.value.passes[0];
    expect(pass?.abi).toMatchObject({
      directEntry: 'vs_main',
      sceneIndexEntry: 'vs_scene_index',
      materialRow: { byteLength: GPU_DRIVEN_MATERIAL_ROW_BYTES },
      vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
    });
    expect(pass?.compile.wgsl).toContain('sceneMaterials');
    expect(pass?.compile.wgsl).toContain('visibleItems');
  });

  it('publishes an authored equivalent row when a full-custom source owns Material', async () => {
    const result = await cook('vs_main', 'fs_main', authoredEquivalentSceneIndexSource, 'Forward', [
      { name: 'tint', type: 'color' },
    ]);
    expect(
      result.ok,
      result.ok ? '' : `${result.error.message} ${JSON.stringify(result.error.detail)}`,
    ).toBe(true);
    if (!result.ok) return;
    expect(result.value.passes[0]?.abi).toMatchObject({
      directEntry: 'vs_main',
      sceneIndexEntry: 'vs_scene_index',
      materialRow: { byteLength: GPU_DRIVEN_MATERIAL_ROW_BYTES, fields: ['tint'] },
    });
  });

  it('rejects a custom scene-index storage row with the wrong element stride', async () => {
    const result = await cook('vs_main', 'fs_main', wrongStrideSceneIndexSource, 'Forward', [
      { name: 'tint', type: 'color' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('material-schema-mismatch');
    expect(result.error.message).toContain('storage array stride 16');
    expect(result.error.detail).toMatchObject({
      mismatchKind: 'type-mismatch',
      availableBytes: GPU_DRIVEN_MATERIAL_ROW_BYTES,
      owner: 'shader-compiler scene-index publication',
    });
  });

  it('rejects authored scene-index bindings outside the engine-owned coordinates', async () => {
    const result = await cook('vs_main', 'fs_main', wrongBindingSceneIndexSource, 'Forward', [
      { name: 'tint', type: 'color' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('material-schema-mismatch');
    expect(result.error.message).toContain('@group(2) @binding(9)');
    expect(result.error.detail).toMatchObject({
      mismatchKind: 'type-mismatch',
      owner: 'shader-compiler scene-index publication',
    });
  });

  it('accepts read-only scene-index storage in the reflected bind-group layouts', async () => {
    const result = await cook('vs_main', 'fs_main', readOnlySceneIndexSource, 'Forward', [
      { name: 'tint', type: 'color' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.passes[0]?.abi?.materialRow.byteLength).toBe(GPU_DRIVEN_MATERIAL_ROW_BYTES);
  });

  it.each([
    ['sceneMaterials', readWriteSceneMaterialsSource],
    ['visibleItems', readWriteVisibleItemsSource],
  ])('rejects %s when the reflected bind-group layout is read-write', async (_name, sourceCode) => {
    const result = await cook('vs_main', 'fs_main', sourceCode, 'Forward', [
      { name: 'tint', type: 'color' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('material-schema-mismatch');
    expect(result.error.message).toContain('read-only storage');
    expect(result.error.detail).toMatchObject({
      mismatchKind: 'type-mismatch',
      owner: 'shader-compiler scene-index publication',
    });
  });

  it('publishes every byte of a full canonical page without truncating the last parameter', async () => {
    const parameters = [
      { name: 'tint', type: 'color' as const },
      ...Array.from({ length: GPU_DRIVEN_MATERIAL_ROW_BYTES / 16 - 1 }, (_, index) => ({
        name: `extra${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
        type: 'color' as const,
      })),
    ];
    const result = await cook('vs_main', 'fs_main', sceneIndexSource, 'Forward', parameters);
    expect(
      result.ok,
      result.ok ? '' : `${result.error.message} ${JSON.stringify(result.error.detail)}`,
    ).toBe(true);
    if (!result.ok) return;
    expect(result.value.passes[0]?.abi?.materialRow.byteLength).toBe(GPU_DRIVEN_MATERIAL_ROW_BYTES);
    expect(result.value.passes[0]?.abi?.materialRow.fields.at(-1)).toBe(parameters.at(-1)?.name);
  });

  it('reports an oversized custom scene-index row as structured ABI overflow', async () => {
    const parameters = Array.from(
      { length: GPU_DRIVEN_MATERIAL_ROW_BYTES / 16 + 1 },
      (_, index) => ({
        name: `color${index}`,
        type: 'color' as const,
      }),
    );
    const result = await cook('vs_main', 'fs_main', sceneIndexSource, 'Forward', parameters);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('material-schema-mismatch');
    expect(result.error.detail).toMatchObject({
      mismatchKind: 'bg-overflow',
      expectedBytes: GPU_DRIVEN_MATERIAL_ROW_BYTES + 16,
      availableBytes: GPU_DRIVEN_MATERIAL_ROW_BYTES,
      owner: 'shader-compiler scene-index publication',
    });
  });

  it.each([
    ['Forward', 'fs_main'],
    ['Deferred', 'fs_gbuffer'],
    ['ShadowCaster', 'fs_shadow'],
  ])('validates the implicit %s fragment entry', async (passName, fragment) => {
    const matchingSource = source.replace('fn fs_main(', `fn ${fragment}(`);
    expect((await cook('vs_main', undefined, matchingSource, passName)).ok).toBe(true);
    const result = await cook(
      'vs_main',
      undefined,
      source.replace('fn fs_main(', 'fn fs_other('),
      passName,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('shader-compile-failed');
    expect(result.error.message).toContain(`fragment entry '${fragment}'`);
  });

  it.each([
    ['vs_missing', 'fs_main', "vertex entry 'vs_missing'"],
    ['vs_main', 'fs_missing', "fragment entry 'fs_missing'"],
    ['fs_main', 'fs_main', "vertex entry 'fs_main'"],
    ['vs_main', 'vs_main', "fragment entry 'vs_main'"],
    ['vs_main', 'fs_wrong_input', '@location(0)'],
  ])('rejects %s / %s before publication', async (vertex, fragment, diagnostic) => {
    const result = await cook(vertex, fragment);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('shader-compile-failed');
    expect(result.error.message).toContain(diagnostic);
  });
});
