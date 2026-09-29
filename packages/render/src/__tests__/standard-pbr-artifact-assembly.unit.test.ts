import { rhi } from '@forgeax/engine-rhi-null';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  assembleStandardPbrArtifact,
  resolveMaterialShaderArtifact,
  resolveStandardPbrArtifact,
} from '../assembly/material/assembly';

import { buildGpuDrivenPbrReadyModules } from '../assembly/webgpu-pbr-ready';

const source = '@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4(0.0); }';

describe('Standard PBR artifact assembly', () => {
  it('reuses program facts when GPU prewarming rebuilds modules for another device', async () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const program = registry.materialProgram(source);
    const replacement = registry.forkForDevice({
      createShaderModule: () => {
        throw new Error('prewarming must use the explicit backend');
      },
    });
    const modules = [];
    const seeds: Map<string, unknown>[] = [];
    for (const owner of [registry, replacement]) {
      const seeded = new Map<string, unknown>();
      seeds.push(seeded);
      const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const ready = await buildGpuDrivenPbrReadyModules({
        registry: owner,
        device,
        storageBufferCapable: true,
        asyncCreateShaderModule: rhi.createShaderModule,
        pbrSkinEntry: undefined,
        pbrSkinManifestEntry: undefined,
        pbrManifestEntry: {
          identifier: 'forgeax::default-standard-pbr',
          sourcePath: 'standard.wgsl',
          composedWgsl: source,
          paramSchema: '[]',
          variants: [
            {
              definesKey: 'scene',
              defines: { STORAGE_BUFFER_AVAILABLE: true, GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true },
              composedWgsl: source,
            },
          ],
        },
        extendedLightingShaderAvailable: false,
        directionalPcssAvailable: false,
        projectorAvailable: false,
        seedShaderModule: (label, module) => seeded.set(label, module),
      });
      const prepared = ready.gpuDrivenPbrPrograms.get('forgeax::default-standard-pbr|color=false');
      expect(prepared?.artifact.program).toBe(program);
      // The GPU-driven raster adapter requests the variant through its lazy
      // material label; a missing seed leaves the first frame pending.
      expect(seeded.get('module-forgeax::default-standard-pbr#scene')).toBe(prepared?.module);
      modules.push(prepared?.module);
    }
    expect(modules[0]).toBeDefined();
    expect(modules[1]).not.toBe(modules[0]);
  });

  it.each([
    'direct',
    'scene-index',
  ] as const)('selects the requested %s address instead of the all-true shadow variant', (address) => {
    const receipt = createStandardPbrArtifactReceipt(false, true);
    const variants = [
      { available: true, explicit: true, key: '' },
      { available: true, explicit: false, key: 'scene' },
      { available: false, explicit: false, key: 'direct' },
    ].map(({ available, explicit, key }) => ({
      definesKey: key,
      defines: {
        STORAGE_BUFFER_AVAILABLE: true,
        SKINNING_DISABLED: true,
        VERTEX_COLOR_AVAILABLE: true,
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: available,
        GPU_DRIVEN_SCENE_INDEX_EXPLICIT: explicit,
      },
      composedWgsl: key,
      receipt,
    }));
    const shader = {
      materialProgram: createMaterialShaderProgram,
      findMaterialArtifact: () => ({
        ok: true as const,
        value: { program: createMaterialShaderProgram(source), source, paramSchema: [], receipt },
      }),
      materialShaderManifestEntries: () => [
        {
          identifier: 'forgeax::default-shadow-caster',
          variants,
        },
      ],
    } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
    const artifact = resolveMaterialShaderArtifact('forgeax::default-standard-pbr', shader, {
      address,
      pass: 'shadow',
      deformation: 'rigid',
      vertexColorAvailable: true,
    });
    expect(artifact?.program.source).toBe(address === 'scene-index' ? 'scene' : 'direct');
  });

  it('assembles the rigid registry entry from one receipt producer', () => {
    const artifact = assembleStandardPbrArtifact(
      'forgeax::default-standard-pbr',
      createMaterialShaderProgram(source),
    );
    const receipt = createStandardPbrArtifactReceipt();

    expect(artifact).toBeDefined();
    expect(artifact?.material).toBe('forgeax::default-standard-pbr');
    expect(artifact?.program.source).toBe(source);
    expect(artifact?.program).toEqual(createMaterialShaderProgram(source));
    expect(artifact?.layoutIdentity).toBe(receipt.reflection.layoutIdentity);
    expect(artifact?.receipt).toEqual(receipt);
    expect(artifact?.vertexInputs).toEqual(
      receipt.vertexInputs.map(({ semantic, location, format }) => ({
        semantic,
        location,
        format,
      })),
    );
  });

  it('retains shader UV aliases beyond the minimum geometry receipt after recovery', () => {
    const receipt = createStandardPbrArtifactReceipt();
    const wgsl = `struct VsIn { @location(2) uv: vec2<f32>, @location(12) uv7: vec2<f32>, }
@vertex fn vs_scene_index(input: VsIn) -> @builtin(position) vec4<f32> { return vec4(input.uv, 0., 1.); }`;
    const artifact = resolveMaterialShaderArtifact(
      'forgeax::default-standard-pbr',
      {
        materialProgram: createMaterialShaderProgram,
        findMaterialArtifact: () => ({
          ok: true,
          value: {
            program: createMaterialShaderProgram(wgsl),
            source: wgsl,
            paramSchema: [],
            receipt,
          },
        }),
      } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1],
      { address: 'scene-index' },
    );
    expect(artifact?.uvSetCount).toBe(8);
    expect(artifact?.receipt).toBe(receipt);
  });

  it('adds the skin palette receipt facts for the skinned registry entry', () => {
    const artifact = assembleStandardPbrArtifact(
      'forgeax::default-standard-pbr-skin',
      createMaterialShaderProgram(source),
    );
    const receipt = createStandardPbrArtifactReceipt(true);

    expect(artifact?.receipt).toEqual(receipt);
    expect(artifact?.receipt?.skinPaletteAddress).toEqual({ group: 2, binding: 1, stride: 64 });
    expect(artifact?.vertexInputs).toHaveLength(receipt.vertexInputs.length);
  });

  it('rejects unsupported shader identifiers without manufacturing an artifact', () => {
    expect(
      assembleStandardPbrArtifact('forgeax::default-unlit', createMaterialShaderProgram(source)),
    ).toBeUndefined();
  });

  it('fails closed when a geometry-specific color fact has no matching producer receipt', () => {
    expect(
      assembleStandardPbrArtifact(
        'forgeax::default-standard-pbr',
        { program: createMaterialShaderProgram(source), source, paramSchema: [] },
        { vertexColorAvailable: true },
      ),
    ).toBeUndefined();
    expect(
      assembleStandardPbrArtifact(
        'forgeax::default-standard-pbr',
        {
          program: createMaterialShaderProgram(source),
          source,
          paramSchema: [],
          receipt: createStandardPbrArtifactReceipt(),
        },
        { vertexColorAvailable: true },
      ),
    ).toBeUndefined();
  });

  it('selects the published COLOR_0 ABI and keeps colored/plain identities apart', () => {
    const plain = createStandardPbrArtifactReceipt();
    const colored = createStandardPbrArtifactReceipt(false, true);
    const shader = {
      materialProgram: createMaterialShaderProgram,
      findMaterialArtifact: () => ({
        ok: true as const,
        value: {
          program: createMaterialShaderProgram('fallback'),
          source: 'fallback',
          paramSchema: [],
          receipt: plain,
        },
      }),
      materialShaderManifestEntries: () => [
        {
          identifier: 'forgeax::default-standard-pbr',
          sourcePath: 'default-standard-pbr.wgsl',
          composedWgsl: 'fallback',
          paramSchema: '[]',
          variants: [
            {
              definesKey: 'VERTEX_COLOR_AVAILABLE=false',
              defines: { VERTEX_COLOR_AVAILABLE: false },
              composedWgsl: 'plain-variant',
              receipt: plain,
            },
            {
              definesKey: 'VERTEX_COLOR_AVAILABLE=true',
              defines: { VERTEX_COLOR_AVAILABLE: true },
              composedWgsl: 'colored-variant',
              receipt: colored,
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof resolveStandardPbrArtifact>[1];

    const coloredArtifact = resolveStandardPbrArtifact('forgeax::default-standard-pbr', shader, {
      vertexColorAvailable: true,
    });
    const plainArtifact = resolveStandardPbrArtifact('forgeax::default-standard-pbr', shader, {
      vertexColorAvailable: false,
    });

    expect(coloredArtifact?.program.source).toBe('colored-variant');
    expect(coloredArtifact?.receipt).toEqual(colored);
    expect(coloredArtifact?.receipt?.vertexInputs).toContainEqual({
      semantic: 'color',
      location: 13,
      format: 'float32x4',
    });
    expect(plainArtifact?.program.source).toBe('plain-variant');
    expect(plainArtifact?.receipt).toEqual(plain);
    expect(plainArtifact?.receipt?.vertexInputs).not.toContainEqual(
      expect.objectContaining({ semantic: 'color' }),
    );
    expect(coloredArtifact?.receipt?.receiptIdentity).not.toBe(
      plainArtifact?.receipt?.receiptIdentity,
    );

    const custom = resolveMaterialShaderArtifact(
      'game::custom-surface',
      {
        materialProgram: createMaterialShaderProgram,
        findMaterialArtifact: () => ({
          ok: true as const,
          value: {
            program: createMaterialShaderProgram('custom-fallback'),
            source: 'custom-fallback',
            paramSchema: [],
            receipt: plain,
          },
        }),
        materialShaderManifestEntries: () => [
          {
            identifier: 'game::custom-surface',
            sourcePath: 'custom.wgsl',
            composedWgsl: 'custom-fallback',
            paramSchema: '[]',
            variants: [
              {
                definesKey: 'VERTEX_COLOR_AVAILABLE=true',
                defines: { VERTEX_COLOR_AVAILABLE: true },
                composedWgsl: 'custom-colored',
                receipt: colored,
              },
            ],
          },
        ],
      } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1],
      { vertexColorAvailable: true },
    );
    expect(custom?.program.source).toBe('custom-colored');
    expect(custom?.program).toEqual(createMaterialShaderProgram('custom-colored'));
    expect(custom?.receipt).toEqual(colored);
  });

  it('resolves a topology projection against the producer complete variant key', () => {
    const receipt = createStandardPbrArtifactReceipt();
    const shader = {
      materialProgram: createMaterialShaderProgram,
      findMaterialArtifact: () => ({
        ok: true as const,
        value: {
          program: createMaterialShaderProgram('boot-direct'),
          source: 'boot-direct',
          paramSchema: [],
          receipt,
        },
      }),
      materialShaderManifestEntries: () => [
        {
          identifier: 'forgeax::default-standard-pbr',
          sourcePath: 'default-standard-pbr.wgsl',
          composedWgsl: 'boot-direct',
          paramSchema: '[]',
          variants: [
            {
              definesKey:
                'CLUSTER_FORWARD_AVAILABLE=false+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true+PROBE_BLEND_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
              defines: {
                CLUSTER_FORWARD_AVAILABLE: false,
                GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
                PROBE_BLEND_AVAILABLE: false,
                STORAGE_BUFFER_AVAILABLE: true,
                VERTEX_COLOR_AVAILABLE: false,
              },
              composedWgsl: 'scene-index',
              receipt,
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
    const artifact = resolveMaterialShaderArtifact('forgeax::default-standard-pbr', shader, {
      address: 'scene-index',
      pass: 'forward',
      vertexColorAvailable: false,
      variantSet:
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    });
    expect(artifact?.program.source).toBe('scene-index');
    expect(artifact?.receipt).toEqual(receipt);
  });

  it('keeps probe-enabled scene programs distinct in the publication cache', () => {
    const receipt = createStandardPbrArtifactReceipt();
    const entry = {
      program: createMaterialShaderProgram('boot-direct'),
      source: 'boot-direct',
      paramSchema: [],
      receipt,
    };
    const manifest = {
      identifier: 'forgeax::default-standard-pbr',
      sourcePath: 'default-standard-pbr.wgsl',
      composedWgsl: entry.source,
      paramSchema: '[]',
      variants: [false, true].map((probeBlend) => ({
        definesKey: `PROBE_BLEND_AVAILABLE=${probeBlend}`,
        defines: {
          PROBE_BLEND_AVAILABLE: probeBlend,
          STORAGE_BUFFER_AVAILABLE: true,
          GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
        },
        composedWgsl: probeBlend ? 'scene-probe' : 'scene-sky',
        receipt,
      })),
    };
    const shader = {
      materialProgram: createMaterialShaderProgram,
      findMaterialArtifact: () => ({ ok: true as const, value: entry }),
      materialShaderManifestEntries: () => [manifest],
    } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
    for (const probeBlend of [false, true, false, true]) {
      const artifact = resolveMaterialShaderArtifact('forgeax::default-standard-pbr', shader, {
        address: 'scene-index',
        pass: 'forward',
        probeBlend,
      });
      expect(artifact?.program.source).toBe(probeBlend ? 'scene-probe' : 'scene-sky');
      expect(artifact?.variantSet).toBe(`PROBE_BLEND_AVAILABLE=${probeBlend}`);
    }
  });

  it('routes built-in Standard shadow requests through the shadow-caster artifact', () => {
    const rigidPlain = createStandardPbrArtifactReceipt();
    const rigidColor = createStandardPbrArtifactReceipt(false, true);
    const skinPlain = createStandardPbrArtifactReceipt(true);
    const shadowEntry = {
      identifier: 'forgeax::default-shadow-caster',
      sourcePath: 'default-shadow-caster.wgsl',
      composedWgsl: 'shadow-primary',
      paramSchema: '[]',
      variants: [
        {
          definesKey: 'SKINNING_DISABLED=true+VERTEX_COLOR_AVAILABLE=false',
          defines: { SKINNING_DISABLED: true, VERTEX_COLOR_AVAILABLE: false },
          composedWgsl: 'shadow-rigid-plain-with-fs_shadow',
          receipt: rigidPlain,
        },
        {
          definesKey: 'SKINNING_DISABLED=true+VERTEX_COLOR_AVAILABLE=true',
          defines: { SKINNING_DISABLED: true, VERTEX_COLOR_AVAILABLE: true },
          composedWgsl: 'shadow-rigid-color-with-fs_shadow',
          receipt: rigidColor,
        },
        {
          definesKey: 'SKINNING_DISABLED=false+VERTEX_COLOR_AVAILABLE=false',
          defines: { SKINNING_DISABLED: false, VERTEX_COLOR_AVAILABLE: false },
          composedWgsl: 'shadow-skin-plain-with-fs_shadow',
          receipt: skinPlain,
        },
      ],
    };
    const standardEntry = {
      identifier: 'forgeax::default-standard-pbr',
      sourcePath: 'default-standard-pbr.wgsl',
      composedWgsl: 'standard-forward-without-fs_shadow',
      paramSchema: '[]',
      variants: [],
    };

    for (const entries of [
      [standardEntry, shadowEntry],
      [shadowEntry, standardEntry],
    ]) {
      const shader = {
        materialProgram: createMaterialShaderProgram,
        findMaterialArtifact: (identifier: string) => ({
          ok: true as const,
          value: {
            program: createMaterialShaderProgram(
              identifier === 'forgeax::default-shadow-caster' ? 'shadow-primary' : 'standard',
            ),
            source: identifier === 'forgeax::default-shadow-caster' ? 'shadow-primary' : 'standard',
            paramSchema: [],
            receipt: rigidPlain,
          },
        }),
        materialShaderManifestEntries: () => entries,
      } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];

      const rigidColorArtifact = resolveMaterialShaderArtifact(
        'forgeax::default-standard-pbr',
        shader,
        {
          address: 'scene-index',
          deformation: 'rigid',
          pass: 'shadow',
          vertexColorAvailable: true,
        },
      );
      const skinPlainArtifact = resolveMaterialShaderArtifact(
        'forgeax::default-standard-pbr-skin',
        shader,
        { address: 'scene-index', deformation: 'skin', pass: 'shadow' },
      );

      expect(rigidColorArtifact?.material).toBe('forgeax::default-shadow-caster');
      expect(rigidColorArtifact?.fragmentEntry).toBe('fs_shadow');
      expect(rigidColorArtifact?.program.source).toBe('shadow-rigid-color-with-fs_shadow');
      expect(rigidColorArtifact?.receipt).toEqual(rigidColor);
      expect(skinPlainArtifact?.material).toBe('forgeax::default-shadow-caster');
      expect(skinPlainArtifact?.program.source).toBe('shadow-skin-plain-with-fs_shadow');
      expect(skinPlainArtifact?.receipt).toEqual(skinPlain);
    }
  });
  it('reuses immutable publications and invalidates changed registry or manifest identities', () => {
    const receipt = createStandardPbrArtifactReceipt();
    let entry = { program: createMaterialShaderProgram(source), source, paramSchema: [], receipt };
    let manifest = {
      identifier: 'game::surface',
      sourcePath: 'surface.wgsl',
      composedWgsl: source,
      paramSchema: '[]',
      variants: [{ definesKey: '', defines: {}, composedWgsl: 'first', receipt }],
    };
    const registry = {
      materialProgram: createMaterialShaderProgram,
      findMaterialArtifact: () => ({ ok: true, value: entry }),
      *materialShaderManifestEntries() {
        yield manifest;
        throw new Error('manifest search must stop at the first matching publication');
      },
    } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
    const resolve = () =>
      resolveMaterialShaderArtifact('game::surface', registry, { address: 'scene-index' });
    const first = resolve();
    expect(first?.program.source).toBe('first');
    expect(resolve()).toBe(first);
    expect(
      resolveMaterialShaderArtifact('game::surface', registry, { address: 'direct' })?.vertexEntry,
    ).toBe(receipt.directEntry);
    manifest = {
      ...manifest,
      variants: [{ definesKey: '', defines: {}, receipt, composedWgsl: 'second' }],
    };
    const second = resolve();
    expect(second).not.toBe(first);
    expect(second?.program.source).toBe('second');
    expect(resolve()).toBe(second);
    entry = { ...entry };
    expect(resolve()).not.toBe(second);
  });
});
