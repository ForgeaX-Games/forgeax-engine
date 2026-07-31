import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { cookMaterialAsset } from '../material/cook.js';
import { buildMaterialSourceCatalog } from '../material/source-catalog.js';

const source = `#define_import_path game::pulse
#pragma variant_axis IS_RED
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let sample = textureSample(baseColorTexture, baseColorTexture_sampler, vec2<f32>(0.5));
  var color = material.baseColor * sample;
#if IS_RED == true
  color = vec4<f32>(1.0, 0.0, 0.0, 1.0);
#endif
  return color;
}`;

const material: MaterialAsset = {
  kind: 'material',
  passes: [
    { name: 'Forward', program: { module: 'game::pulse', moduleSlots: { IS_RED: 'false' } } },
  ],
  parameters: [
    { name: 'baseColor', type: 'color' },
    { name: 'baseColorTexture', type: 'texture' },
    { name: 'IS_RED', type: 'bool', static: true },
  ],
  values: { baseColor: [0.1, 0.2, 0.3, 1], IS_RED: false },
};

describe('cookMaterialAsset', () => {
  it('generates the interface from MaterialAsset and reflects it', async () => {
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'shader-defs.wgsl', source }],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;

    const result = await cookMaterialAsset({
      material: 'root',
      table: { root: material },
      sources: catalog.value,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const pass = result.value.passes[0];
    expect(pass).toBeDefined();
    if (pass === undefined) return;
    expect(pass.generatedModule).toContain('var<uniform> material');
    expect(pass.generatedModule).toContain('baseColorTexture_sampler');
    expect(pass.compile.wgsl).toContain('baseColorTexture');
    expect(pass.compile.bindings.length).toBeGreaterThan(0);
  });

  it('accepts an explicit import of the generated parameters module', async () => {
    const explicitSource = source.replace(
      '#pragma variant_axis IS_RED\n',
      '#pragma variant_axis IS_RED\n#import forgeax_material::parameters::{material, baseColorTexture, baseColorTexture_sampler}\n',
    );
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'explicit.wgsl', source: explicitSource }],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const result = await cookMaterialAsset({
      material: 'root',
      table: { root: material },
      sources: catalog.value,
    });
    expect(result.ok).toBe(true);
  });

  it('keeps the generated module out of disk lookup while closing transitive imports', async () => {
    const helper = `#define_import_path game::helper\n#import forgeax_material::parameters::{material}\nfn tint(value: vec4<f32>) -> vec4<f32> { return value * material.baseColor; }`;
    const root = `#define_import_path game::root\n#import game::helper::{tint}\n#import forgeax_material::parameters::{material}\n@fragment\nfn fs_main() -> @location(0) vec4<f32> { return tint(material.baseColor); }`;
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [
        { path: 'root.wgsl', source: root },
        { path: 'helper.wgsl', source: helper },
      ],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const result = await cookMaterialAsset({
      material: 'root',
      table: {
        root: {
          kind: 'material',
          passes: [{ name: 'Forward', program: { module: 'game::root' } }],
          parameters: [{ name: 'baseColor', type: 'color' }],
        },
      },
      sources: catalog.value,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.passes[0]?.sourceClosure).toEqual([
      'root.wgsl',
      'forgeax_material::parameters',
      'game::helper',
    ]);
  });

  it('cooks every pass instead of silently truncating the material', async () => {
    const sourceA = source.replace('game::pulse', 'game::first');
    const sourceB = source.replace('game::pulse', 'game::second');
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [
        { path: 'first.wgsl', source: sourceA },
        { path: 'second.wgsl', source: sourceB },
      ],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const result = await cookMaterialAsset({
      material: 'root',
      table: {
        root: {
          ...material,
          passes: [
            {
              name: 'Forward',
              program: { module: 'game::first', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
            },
            {
              name: 'Shadow',
              program: {
                module: 'game::second',
                vertexEntry: 'shadow_vs',
                fragmentEntry: 'shadow_fs',
              },
            },
          ],
        },
      },
      sources: catalog.value,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.passes.map((pass) => [pass.pass, pass.module])).toEqual([
      ['Forward', 'game::first'],
      ['Shadow', 'game::second'],
    ]);
  });

  it('preserves pass identity when passes share a module', async () => {
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'shared.wgsl', source: source.replace('game::pulse', 'game::shared') }],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const result = await cookMaterialAsset({
      material: 'root',
      table: {
        root: {
          ...material,
          passes: [
            { name: 'Forward', program: { module: 'game::shared', fragmentEntry: 'fs_main' } },
            { name: 'Overlay', program: { module: 'game::shared', fragmentEntry: 'overlay_fs' } },
          ],
        },
      },
      sources: catalog.value,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.passes.map((pass) => pass.pass)).toEqual(['Forward', 'Overlay']);
  });
});
