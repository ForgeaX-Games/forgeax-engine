import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { cookMaterialAsset } from '../material/cook.js';
import { createMaterialPackCooker } from '../material/pack-cooker.js';
import { buildMaterialSourceCatalog } from '../material/source-catalog.js';
import { createMaterialSpecializationKey } from '../material/specialization-key.js';

const source = `#define_import_path game::pulse
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let sample = textureSample(baseColorTexture, baseColorTexture_sampler, vec2<f32>(0.5));
  var color = material.baseColor * sample;
  return color;
}`;

const material: MaterialAsset = {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'game::pulse' } }],
  parameters: [
    { name: 'baseColor', type: 'color' },
    { name: 'baseColorTexture', type: 'texture' },
  ],
  values: { baseColor: [0.1, 0.2, 0.3, 1] },
};

function packShader(module: string, body: string): string {
  return `#define_import_path ${module}
${body}
`;
}

function packRecord(value: unknown): {
  readonly specializationKey: string;
  readonly receipt: {
    readonly identity: { readonly sourceClosureDigest: string };
  };
} {
  const record = value as {
    readonly specializationKey?: unknown;
    readonly receipt?: { readonly identity?: { readonly sourceClosureDigest?: unknown } };
  };
  const specializationKey = record.specializationKey;
  const sourceClosureDigest = record.receipt?.identity?.sourceClosureDigest;
  if (typeof specializationKey !== 'string' || typeof sourceClosureDigest !== 'string') {
    throw new Error('material pack fixture did not produce canonical specialization identity');
  }
  return { specializationKey, receipt: { identity: { sourceClosureDigest } } };
}

function cookedPayload(value: { readonly payload: unknown }): unknown {
  if (value.payload === null || typeof value.payload !== 'object') {
    throw new Error('material pack fixture did not produce a payload');
  }
  return (value.payload as { readonly cooked?: unknown }).cooked;
}

describe('cookMaterialAsset', () => {
  it('exposes the Pack cooker from the shader compiler owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-material-pack-cooker-'));
    const sourcePath = resolve(root, 'pulse.wgsl');
    await writeFile(
      sourcePath,
      '#define_import_path game::pack\n@fragment\nfn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\n',
    );
    try {
      const draft = await createMaterialPackCooker([root]).cook({
        guid: 'material-pack-test',
        source: {
          kind: 'material',
          passes: [{ name: 'Forward', program: { module: 'game::pack' } }],
        },
        sourceKey: 'pulse.wgsl',
        sourcePath: resolve(root, 'material.pack.json'),
        refs: [],
      });
      expect(draft.payload).toMatchObject({
        cooked: {
          schemaVersion: 'material-cook/3',
          receipt: { identity: { sourceClosureDigest: expect.any(String) } },
        },
      });
      expect(Object.keys(draft.artifacts)).toEqual(['materials/material-pack-test/shader.wgsl']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the canonical key for equivalent contracts and excludes runtime identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-material-specialization-'));
    const sourcePath = resolve(root, 'pack-key.wgsl');
    const slotPath = resolve(root, 'lighting.wgsl');
    await writeFile(
      sourcePath,
      packShader(
        'game::pack-key',
        '#pragma material_slot lighting\n#import forgeax_material::slot::lighting::{shade}\n@fragment\nfn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(material.value + shade(), 0.0, 0.0, 1.0); }',
      ),
    );
    await writeFile(slotPath, packShader('game::lighting', 'fn shade() -> f32 { return 0.0; }'));
    const sourceMaterial: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: {
            module: 'game::pack-key',
            fragmentEntry: 'fs_main',
            moduleSlots: { lighting: 'game::lighting' },
          },
        },
      ],
      parameters: [
        { name: 'value', type: 'f32' },
        { name: 'texture', type: 'texture' },
      ],
      values: {
        value: 0.5,
        texture: { texture: 'texture-a', sampler: 'sampler-a' },
      },
    };
    try {
      const cooker = createMaterialPackCooker([root]);
      const first = await cooker.cook({
        guid: 'material-root',
        source: sourceMaterial,
        sourcePath: resolve(root, 'material.pack.json'),
        sourceKey: 'pack-key.wgsl',
      });
      const second = await cooker.cook({
        guid: 'material-derived',
        source: {
          ...sourceMaterial,
          values: {
            value: 0.75,
            texture: { texture: 'texture-b', sampler: 'sampler-b' },
          },
        },
        sourcePath: resolve(root, 'material.pack.json'),
        sourceKey: 'pack-key.wgsl',
      });
      const firstRecord = packRecord(cookedPayload(first));
      const secondRecord = packRecord(cookedPayload(second));
      const expected = createMaterialSpecializationKey({
        contractHash: JSON.stringify(sourceMaterial.parameters),
        passes: [
          {
            name: 'Forward',
            module: 'game::pack-key',
            entries: { vertex: '', fragment: 'fs_main' },
            sourceClosure: { digest: firstRecord.receipt.identity.sourceClosureDigest },
            moduleSlots: { lighting: 'game::lighting' },
          },
        ],
        vertexInputs: [],
        versions: {
          profile: 'webgpu/v1',
          adapter: 'generic',
          compiler: 'forgeax-material-cooker/1',
        },
      });
      expect(firstRecord.specializationKey).toBe(expected.digest);
      expect(secondRecord.specializationKey).toBe(firstRecord.specializationKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('changes the canonical key for pass, module, and source changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-material-specialization-mutations-'));
    const sourcePath = resolve(root, 'mutation.wgsl');
    const otherPath = resolve(root, 'other.wgsl');
    const writeSource = async (path: string, module: string, value: number) => {
      await writeFile(
        path,
        packShader(
          module,
          `@fragment\nfn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(${value}.0); }`,
        ),
      );
    };
    await writeSource(sourcePath, 'game::mutation', 1);
    await writeSource(otherPath, 'game::other', 1);
    const materialFor = (module: string, name = 'Forward'): MaterialAsset => ({
      kind: 'material',
      passes: [{ name, program: { module, fragmentEntry: 'fs_main' } }],
      parameters: [],
    });
    try {
      const cooker = createMaterialPackCooker([root]);
      const cook = (source: MaterialAsset, sourceKey: string) =>
        cooker.cook({
          guid: 'material-mutation',
          source,
          sourcePath: resolve(root, 'material.pack.json'),
          sourceKey,
        });
      const baseline = packRecord(
        cookedPayload(await cook(materialFor('game::mutation'), 'mutation.wgsl')),
      );
      const pass = packRecord(
        cookedPayload(await cook(materialFor('game::mutation', 'Shadow'), 'mutation.wgsl')),
      );
      const module = packRecord(
        cookedPayload(await cook(materialFor('game::other'), 'other.wgsl')),
      );
      await writeSource(sourcePath, 'game::mutation', 2);
      const source = packRecord(
        cookedPayload(await cook(materialFor('game::mutation'), 'mutation.wgsl')),
      );

      expect(pass.specializationKey).not.toBe(baseline.specializationKey);
      expect(module.specializationKey).not.toBe(baseline.specializationKey);
      expect(source.specializationKey).not.toBe(baseline.specializationKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      '@fragment\n',
      '#import forgeax_material::parameters::{material, baseColorTexture, baseColorTexture_sampler}\n@fragment\n',
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

  it('accepts an authored Material interface without injecting a duplicate binding', async () => {
    const authoredSource = `#define_import_path game::authored
struct Material {
  baseColor : vec4<f32>,
};
@group(1) @binding(0) var<uniform> material : Material;
@fragment
fn fs_main() -> @location(0) vec4<f32> { return material.baseColor; }`;
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'authored.wgsl', source: authoredSource }],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const result = await cookMaterialAsset({
      material: 'root',
      table: {
        root: {
          kind: 'material',
          passes: [{ name: 'Forward', program: { module: 'game::authored' } }],
          parameters: [{ name: 'baseColor', type: 'color' }],
        },
      },
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

  it('accepts an unused schema-derived interface injected into the composed shader', async () => {
    const unusedSource = `#define_import_path game::unused\n@fragment\nfn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`;
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'unused.wgsl', source: unusedSource }],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;

    const result = await cookMaterialAsset({
      material: 'root',
      table: {
        root: {
          kind: 'material',
          passes: [{ name: 'Forward', program: { module: 'game::unused' } }],
          parameters: [{ name: 'time', type: 'f32' }],
        },
      },
      sources: catalog.value,
    });

    expect(result.ok).toBe(true);
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

  it('returns the derived layout identity for every cooked pass', async () => {
    const roots = ['/game/assets'];
    const catalog = buildMaterialSourceCatalog({
      roots,
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

    expect(result).toMatchObject({
      ok: true,
      value: {
        resolved: { leaf: 'root' },
        passes: [{ layoutIdentity: expect.stringMatching(/^sha256-/) }],
      },
    });
  });

  it('composes the selected ABI-compatible module slot into the artifact', async () => {
    const entry = `#define_import_path game::slot-entry
#pragma material_slot lighting
#import forgeax_material::slot::lighting::{lighting_color}
@fragment
fn fs_main() -> @location(0) vec4<f32> { return lighting_color(); }`;
    const first = `#define_import_path game::lighting_a
fn lighting_color() -> vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }`;
    const second = first
      .replace('1.0, 0.0, 0.0', '0.0, 1.0, 0.0')
      .replace('lighting_a', 'lighting_b');
    const firstCatalog = buildMaterialSourceCatalog({
      engine: [],
      project: [
        { path: 'entry.wgsl', source: entry },
        { path: 'a.wgsl', source: first },
      ],
    });
    const secondCatalog = buildMaterialSourceCatalog({
      engine: [],
      project: [
        { path: 'entry.wgsl', source: entry },
        { path: 'b.wgsl', source: second },
      ],
    });
    expect(firstCatalog.ok).toBe(true);
    expect(secondCatalog.ok).toBe(true);
    if (!firstCatalog.ok || !secondCatalog.ok) return;
    const base: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'game::slot-entry', moduleSlots: { lighting: 'game::lighting_a' } },
        },
      ],
    };
    const firstCook = await cookMaterialAsset({
      material: 'root',
      table: { root: base },
      sources: firstCatalog.value,
    });
    const secondCook = await cookMaterialAsset({
      material: 'root',
      table: {
        root: {
          ...base,
          passes: [
            {
              name: 'Forward',
              program: {
                module: 'game::slot-entry',
                moduleSlots: { lighting: 'game::lighting_b' },
              },
            },
          ],
        },
      },
      sources: secondCatalog.value,
    });
    expect(firstCook.ok).toBe(true);
    expect(secondCook.ok).toBe(true);
    if (!firstCook.ok || !secondCook.ok) return;
    expect(firstCook.value.passes[0]?.compile.wgsl).not.toBe(
      secondCook.value.passes[0]?.compile.wgsl,
    );
    expect(firstCook.value.passes[0]?.layoutIdentity).toBe(
      secondCook.value.passes[0]?.layoutIdentity,
    );
  });
});
