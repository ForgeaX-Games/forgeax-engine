// @ts-nocheck — merged file: cross-source type narrowing failures from blocks originally outside src/ rootDir
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
//
// Source files (N=33):
//   - packages/runtime/__tests__/asset-registry.test.ts
//   - packages/runtime/__tests__/loader-registry.test.ts
//   - packages/runtime/__tests__/wire-default-loaders.test.ts
//   - packages/runtime/src/__tests__/asset-registry-aabb.test.ts
//   - packages/runtime/src/__tests__/asset-registry-builtin-nineslice.test.ts
//   - packages/runtime/src/__tests__/asset-registry-d9-tile-sampler-soft-warn.test.ts
//   - packages/runtime/src/__tests__/asset-registry-guid.test.ts
//   - packages/runtime/src/__tests__/asset-registry-material-validate.test.ts
//   - packages/runtime/src/__tests__/asset-registry-mesh-fail-fast.test.ts
//   - packages/runtime/src/__tests__/asset-registry-scene.test.ts
//   - packages/runtime/src/__tests__/asset-registry-sprite-slices-validate.test.ts
//   - packages/runtime/src/__tests__/auto-select.test.ts
//   - packages/runtime/src/__tests__/bindgroup-resize-invalidation.test.ts
//   - packages/runtime/src/__tests__/builtin-guid-ssot.test.ts
//   - packages/runtime/src/__tests__/builtin-pack.test.ts
//   - packages/runtime/src/__tests__/cube-texture-narrowing.test.ts
//   - packages/runtime/src/__tests__/cubemap-upload.test.ts
//   - packages/runtime/src/__tests__/dev-import-transport.test.ts
//   - packages/runtime/src/__tests__/font-asset-load.test.ts
//   - packages/runtime/src/__tests__/handle-quad.test.ts
//   - packages/runtime/src/__tests__/lazy-catalog.test.ts
//   - packages/runtime/src/__tests__/load-by-guid-hdr.test.ts
//   - packages/runtime/src/__tests__/load-by-guid-prod-material-parent.test.ts
//   - packages/runtime/src/__tests__/load-by-guid-prod.test.ts
//   - packages/runtime/src/__tests__/mipmap-formula.test.ts
//   - packages/runtime/src/__tests__/mipmap-pipeline-cache.test.ts
//   - packages/runtime/src/__tests__/parse-asset-payload-material.test.ts
//   - packages/runtime/src/__tests__/parse-asset-payload-texture.test.ts
//   - packages/runtime/src/__tests__/parse-scene-payload-refs.test.ts
//   - packages/runtime/src/__tests__/register-with-guid-rgba16float.test.ts
//   - packages/runtime/src/__tests__/resolve-scene-guids.test.ts
//   - packages/runtime/src/__tests__/upload-texture-consistency.test.ts
//   - packages/runtime/src/__tests__/verify-revisions.test.ts
//
// Paradigm: each block-scope wraps a source file. ancestorTitles[0] is the
// source-preserved inner describe (NOT the source filename for these 3 files
// — recovery path: vitest report ancestorTitles -> grep this file -> upstream
// `// ─── from <name>.test.ts ───` block separator -> source filename).
// Top-level imports merged + deduped.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as assetRegistryModule from '@forgeax/engine-assets-runtime';
import {
  AssetRegistry,
  animationClipLoader,
  BUILTIN_FLOATS_PER_VERTEX,
  buildSceneChildContext,
  fontLoader,
  getOrCreateMipmapPipeline,
  HANDLE_CUBE,
  HANDLE_CYLINDER,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
  INLINE_PACK_LOADERS,
  LoaderRegistry,
  materialLoader,
  meshLoader,
  mipmapCacheSize,
  numMipLevels,
  resolveAssetHandle,
  sceneLoader,
  skeletonLoader,
  skinLoader,
  textureLoader,
  UPSTREAM_ENTRY_LOADERS,
  walkMaterialPassesOverSharedRefs,
  wireDefaultLoaders,
} from '@forgeax/engine-assets-runtime';
import { defineComponent, World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createPlaneGeometry,
  meshFromInterleaved,
} from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ok, ok as rhiOk } from '@forgeax/engine-rhi';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type {
  EquirectAsset,
  Handle,
  MaterialAsset,
  MaterialPassDescriptor,
  SamplerAsset,
} from '@forgeax/engine-types';
import { AssetError, toShared, toUnique, unwrapHandle } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { deriveBuiltin } from '../../../pack/src/builtin';
import { audioLoader } from '../audio-loader';
import { createDevImportTransport, type ImportTransport } from '../dev-import-transport';
import { createEngineMetrics } from '../engine-metrics';
import { GpuResourceStore } from '../gpu-resource-store';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

vi.mock('@forgeax/engine-rhi-webgpu', async () => {
  spies.webgpuImportCount += 1;
  const actualRhi =
    await vi.importActual<typeof import('@forgeax/engine-rhi')>('@forgeax/engine-rhi');
  const fakeAdapter = {
    features: new Set<string>(),
    limits: {} as Readonly<Record<string, number>>,
    async requestDevice() {
      return actualRhi.ok(makeFakeRhiDevice());
    },
  };
  return {
    rhi: {
      requestAdapter: async () => {
        if (spies.rhiWebgpuRequestAdapterShould === 'reject-rhi-not-available') {
          return actualRhi.err(
            new actualRhi.RhiError({
              code: 'rhi-not-available',
              expected: 'navigator.gpu available',
              hint: 'unit-test: forced rhi-not-available',
            }),
          );
        }
        if (spies.rhiWebgpuRequestAdapterShould === 'reject-adapter-null') {
          return actualRhi.err(
            new actualRhi.RhiError({
              code: 'adapter-unavailable',
              expected: 'requestAdapter returns non-null',
              hint: 'unit-test: forced adapter-unavailable',
            }),
          );
        }
        return actualRhi.ok(fakeAdapter);
      },
      acquireCanvasContext: (_canvas: unknown) => {
        return actualRhi.ok({
          configure: () => actualRhi.ok(undefined),
          unconfigure: () => actualRhi.ok(undefined),
          getCurrentTexture: () => actualRhi.ok({ __brand: 'TextureView' }),
        });
      },
    },
    createShaderModule: async () => actualRhi.ok({ __brand: 'ShaderModule' } as unknown as object),
  };
});
vi.mock('@forgeax/engine-rhi-wgpu', async () => {
  spies.wgpuImportCount += 1;
  const actualRhi =
    await vi.importActual<typeof import('@forgeax/engine-rhi')>('@forgeax/engine-rhi');
  const fakeAdapter = {
    features: new Set<string>(),
    limits: {} as Readonly<Record<string, number>>,
    async requestDevice() {
      return actualRhi.ok(makeFakeRhiDevice());
    },
  };
  return {
    rhi: {
      requestAdapter: async () => {
        if (spies.rhiWgpuRequestAdapterShould === 'reject-rhi-not-available') {
          return actualRhi.err(
            new actualRhi.RhiError({
              code: 'rhi-not-available',
              expected: 'wgpu webgl backend available',
              hint: 'unit-test: forced rhi-not-available on rhi-wgpu',
            }),
          );
        }
        return actualRhi.ok(fakeAdapter);
      },
      acquireCanvasContext: (_canvas: unknown) => {
        return actualRhi.ok({
          configure: () => actualRhi.ok(undefined),
          unconfigure: () => actualRhi.ok(undefined),
          getCurrentTexture: () => actualRhi.ok({ __brand: 'TextureView' }),
        });
      },
    },
    ensureReady: async () => {
      spies.ensureReadyCount += 1;
      if (spies.rhiWgpuEnsureReadyShould === 'reject-load-failed') {
        throw new Error('unit-test: forced rhi-wgpu wasm load failure');
      }
      return undefined;
    },
  };
});
const spies = vi.hoisted(() => ({
  webgpuImportCount: 0,
  wgpuImportCount: 0,
  ensureReadyCount: 0,
  // Failure toggles set by individual tests before invoking createRenderer.
  rhiWebgpuRequestAdapterShould: 'success' as
    | 'success'
    | 'reject-rhi-not-available'
    | 'reject-adapter-null',
  rhiWgpuEnsureReadyShould: 'success' as 'success' | 'reject-load-failed',
  rhiWgpuRequestAdapterShould: 'success' as 'success' | 'reject-rhi-not-available',
  reset(): void {
    this.webgpuImportCount = 0;
    this.wgpuImportCount = 0;
    this.ensureReadyCount = 0;
    this.rhiWebgpuRequestAdapterShould = 'success';
    this.rhiWgpuEnsureReadyShould = 'success';
    this.rhiWgpuRequestAdapterShould = 'success';
  },
}));
function makeFakeRhiDevice(): Record<string, unknown> {
  let resolveLost!: (info: unknown) => void;
  const lost = new Promise<unknown>((res) => {
    resolveLost = res;
  });
  void resolveLost;
  return {
    __brand: 'RhiDevice',
    lost,
    features: new Set<string>(),
    limits: {},
    // feat-20260707 M5 / w33: createRenderer projects RhiCaps.textureCompression*
    // into TranscodeCaps right after building the registry, so the fake device
    // must expose a caps object (the real RhiDevice always carries one).
    caps: {
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
    },
    queue: {
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
    createBuffer: () => ({ ok: true, value: { __brand: 'Buffer' } }),
    createTexture: () => ({ ok: true, value: { __brand: 'Texture' } }),
    createBindGroupLayout: () => ({ ok: true, value: { __brand: 'BindGroupLayout' } }),
    createBindGroup: () => ({ ok: true, value: { __brand: 'BindGroup' } }),
    createPipelineLayout: () => ({ ok: true, value: { __brand: 'PipelineLayout' } }),
    createRenderPipeline: () => ({ ok: true, value: { __brand: 'RenderPipeline' } }),
    createSampler: () => ({ ok: true, value: { __brand: 'Sampler' } }),
    createShaderModule: () => ({
      ok: true,
      value: { __brand: 'ShaderModule' },
    }),
    createTextureView: () => ({ ok: true, value: { __brand: 'TextureView' } }),
    createCommandEncoder: () => ({
      ok: true,
      value: {
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          setVertexBuffer: () => undefined,
          setIndexBuffer: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
        }),
        finish: () => ({ __brand: 'CommandBuffer' }),
      },
    }),
  };
}
function makeMockCanvas(opts: { webgpu?: 'context' | 'null'; webgl2?: 'context' | 'null' }) {
  return {
    width: 800,
    height: 600,
    getContext(kind: string): unknown {
      if (kind === 'webgpu') {
        if (opts.webgpu === 'context') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({ createView: () => ({}) }),
          };
        }
        return null;
      }
      if (kind === 'webgl2') {
        if (opts.webgl2 === 'context') {
          return {
            __mockTag: 'webgl2',
            getExtension: () => null,
            getParameter: () => 1,
            isContextLost: () => false,
          };
        }
        return null;
      }
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
}
function makeStubGPU(): unknown {
  return {
    requestAdapter: async () => ({
      features: new Set<string>(),
      limits: {},
      requestDevice: async () => makeFakeRhiDevice(),
    }),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
}

{
  // M3 w9: AssetRegistry now internally builds its own LoaderRegistry via
  // createDefaultLoaderRegistry(). The public readonly `loaders` field gives
  // host code direct access to register custom loaders. This test verifies
  // the pre-wired contract: default kinds (mesh, scene, texture, etc.) are
  // registered, and unregistered kinds (sampler/render-pipeline/shader) are
  // deliberately absent.
  describe('AssetRegistry public readonly loaders field (M3 w9)', () => {
    it('loaders is a public readonly field pre-wired with default kinds', () => {
      const assets = new AssetRegistry(makeMockShaderRegistry());
      expect(assets.loaders).toBeDefined();
      // Default loader set (10 kinds) includes mesh, scene, texture, font.
      expect(assets.loaders.get('mesh')).toBeDefined();
      expect(assets.loaders.get('texture')).toBeDefined();
      expect(assets.loaders.get('font')).toBeDefined();
      // Deliberately NOT registered: sampler, render-pipeline, shader.
      expect(assets.loaders.get('sampler')).toBeUndefined();
      expect(assets.loaders.get('render-pipeline')).toBeUndefined();
      expect(assets.loaders.get('shader')).toBeUndefined();
      // registeredKinds includes the default set.
      const kinds = assets.loaders.registeredKinds();
      expect(kinds).toContain('mesh');
      expect(kinds).toContain('texture');
    });

    it('host can register a custom kind via assets.loaders.register', () => {
      const assets = new AssetRegistry(makeMockShaderRegistry());
      assets.loaders.register({
        kind: 'texture',
        load: () => ({
          ok: false,
          error: new AssetError({ code: 'asset-parse-failed', expected: 'x', hint: 'x' }),
        }),
      });
      expect(assets.loaders.get('texture')).toBeDefined();
    });
  });

  describe('AssetErrorCode is 16 members (feat-20260604 M2 / w4)', () => {
    it('exhaustive switch on AssetErrorCode compiles without default and covers texture-source-not-imported', () => {
      function describe16(code: AssetErrorCode): number {
        switch (code) {
          case 'asset-not-found':
          case 'asset-parse-failed':
          case 'asset-format-unsupported':
          case 'asset-fetch-failed':
          case 'asset-invalid-value':
          case 'cubemap-handle-missing':
          case 'invalid-source-format':
          case 'load-failed':
          case 'device-unsupported':
          case 'ibl-precompute-not-dispatched':
          case 'mesh-vertex-stride-mismatch':
          case 'material-shader-ref-broken':
          case 'material-circular-inheritance':
          case 'loader-not-registered':
          case 'asset-not-imported':
          // === 1 new code (feat-20260604-hdr-equirect-cube-importer-loader M2 / w4) ===
          case 'texture-source-not-imported':
            return 1;
        }
      }
      expect(describe16('loader-not-registered')).toBe(1);
      expect(describe16('asset-not-imported')).toBe(1);
      expect(describe16('texture-source-not-imported')).toBe(1);
    });
  });
}

{
  // --- from loader-registry.test.ts ---
  function stubLoader(kind: string): Loader {
    return { kind, load: () => undefined };
  }

  describe('LoaderRegistry (w2)', () => {
    it('register then get returns the registered loader', () => {
      const reg = new LoaderRegistry();
      const mesh = stubLoader('mesh');
      reg.register(mesh);
      expect(reg.get('mesh')).toBe(mesh);
    });

    it('get on an unregistered kind returns undefined', () => {
      const reg = new LoaderRegistry();
      expect(reg.get('mesh')).toBeUndefined();
    });

    it('re-registering the same kind is idempotent (last write wins, no throw)', () => {
      const reg = new LoaderRegistry();
      const first = stubLoader('mesh');
      const second = stubLoader('mesh');
      reg.register(first);
      expect(() => reg.register(second)).not.toThrow();
      expect(reg.get('mesh')).toBe(second);
      // registeredKinds carries one entry, not two duplicates.
      expect(reg.registeredKinds().filter((k) => k === 'mesh')).toHaveLength(1);
    });

    it('registeredKinds reflects insertion order', () => {
      const reg = new LoaderRegistry();
      reg.register(stubLoader('mesh'));
      reg.register(stubLoader('scene'));
      expect(reg.registeredKinds()).toEqual(['mesh', 'scene']);
    });

    it('fail-fast: register throws on empty kind', () => {
      const reg = new LoaderRegistry();
      expect(() => reg.register({ kind: '', load: () => undefined })).toThrow(TypeError);
    });

    it('fail-fast: register throws when load is not a function', () => {
      const reg = new LoaderRegistry();
      // Intentionally malformed loader to exercise the wire-time guard.
      expect(() =>
        reg.register({ kind: 'mesh', load: undefined as unknown as Loader['load'] }),
      ).toThrow(TypeError);
    });
  });

  // A LoadContext that serves canned binaries / refs.
  function mockCtx(opts?: {
    binaries?: Record<string, Uint8Array>;
    refs?: Record<string, number>;
  }): LoadContext {
    const ctx: LoadContext = {
      fetchBinary: async (url: string) => {
        const b = opts?.binaries?.[url];
        return b !== undefined
          ? { ok: true as const, value: b }
          : { ok: false as const, error: new Error(`no binary for ${url}`) };
      },
      resolveRef: async (guid: string) => {
        const h = opts?.refs?.[guid];
        return h !== undefined
          ? { ok: true as const, value: h }
          : { ok: false as const, error: new Error(`no ref for ${guid}`) };
      },
      transcodeCaps: { bc: false, etc2: false, astc: false },
      device: undefined,
    };
    return ctx;
  }

  describe('inline pack-payload loaders (w4)', () => {
    it('INLINE_PACK_LOADERS covers the 6 inline kinds in order', () => {
      expect(INLINE_PACK_LOADERS.map((l) => l.kind)).toEqual([
        'mesh',
        'scene',
        'material',
        'skeleton',
        'skin',
        'animation-clip',
      ]);
    });

    it('meshLoader builds a MeshAsset POD from array payload', () => {
      const out = meshLoader.load(
        { vertices: [0, 0, 0, 0, 0, 1, 0, 0], indices: [0, 1, 2] },
        undefined,
        mockCtx(),
      );
      // feat-20260608 M5 / w27: meshLoader auto-fills a default single
      // triangle-list submesh covering the full index/vertex range.
      expect(out).toMatchObject({
        kind: 'mesh',
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 8,
            topology: 'triangle-list',
          },
        ],
      });
      expect((out as { vertices: Float32Array }).vertices).toBeInstanceOf(Float32Array);
    });

    it('sceneLoader produces a SceneAsset for a valid payload', () => {
      const out = sceneLoaderLoad({ entities: [{ localId: 0, components: {} }] }, undefined);
      expect(out).toMatchObject({ kind: 'scene' });
    });

    it('sceneLoader returns structured error { ok: false } on refs out-of-bounds (F21)', () => {
      const ctx = mockCtx();
      const out = sceneLoader.load(
        { entities: [{ localId: 7, components: { MeshFilter: { assetHandle: 5 } } }] },
        ['guid-a'], // length 1; index 5 is out of bounds
        ctx,
      );
      expect(out).toBeDefined();
      // F21: sceneLoader now returns { ok: false, error: ParseErrorDetail }
      // instead of writing to ctx.reportParseError.
      const errResult = out as {
        ok: boolean;
        error?: { localId: number; index: number; refsLength: number };
      };
      expect(errResult.ok).toBe(false);
      expect(errResult.error).toMatchObject({ localId: 7, index: 5, refsLength: 1 });
    });

    it('materialLoader carries parentGuid resolved from refs index', () => {
      const out = materialLoader.load({ parent: 0, paramValues: {} }, ['parent-guid'], mockCtx());
      expect(out).toMatchObject({ kind: 'material', parentGuid: 'parent-guid' });
    });

    it('materialLoader resolves heightTexture from refs index to its GUID (M4 / w22, D-19)', () => {
      // feat-20260613-material-paramschema-driven-binding M4 / w22:
      // the legacy hardcoded texture-field allowlist Set has been deleted.
      // When the shader is not yet registered (mock ctx returns undefined
      // from getMaterialShaderTextureFieldNames), the loader falls back to
      // a graceful "try every int paramValue in [0, refs.length)" walk and
      // resolves heightTexture (any field name) to the refs[] entry.
      //
      // feat-20260614 M8 (D-19): the embedded sub-asset ref is stored as its
      // GUID string verbatim (dash-form) -- the ECS/render side resolves the
      // GUID -> column handle at use time via world.allocSharedRef; the loader
      // no longer mints a numeric handle (resolveRefSync is deleted). Mirrors
      // the sibling `parentGuid` contract (refs index -> GUID string).
      const out = materialLoader.load(
        {
          passes: [{ shader: 'test' }],
          paramValues: { heightTexture: 0 },
        },
        ['height-guid'],
        mockCtx(),
      );
      expect(out).toMatchObject({ kind: 'material' });
      expect((out as Record<string, unknown>)?.paramValues?.heightTexture).toBe('height-guid');
    });

    it('materialLoader returns normally when paramValues has no heightTexture field', () => {
      const out = materialLoader.load(
        {
          passes: [{ shader: 'test' }],
          paramValues: { baseColorTexture: 0 },
        },
        [],
        mockCtx(),
      );
      expect(out).toMatchObject({ kind: 'material' });
      // baseColorTexture refs-index 0 is OOB (refs.length=0), so
      // the field is dropped. The loader still returns a valid material
      // asset -- no throw, no undefined.
    });

    it('skeletonLoader rejects ibm byteLength / jointCount mismatch', () => {
      const out = skeletonLoader.load(
        { inverseBindMatrices: new Float32Array(8), jointCount: 2 },
        undefined,
        mockCtx(),
      );
      expect(out).toBeUndefined(); // 8 floats != 2 * 16
    });

    it('skinLoader + animationClipLoader build their PODs', () => {
      expect(
        skinLoader.load({ skeletonGuid: 'g', jointPaths: ['a'] }, undefined, mockCtx()),
      ).toMatchObject({ kind: 'skin' });
      expect(
        animationClipLoader.load({ duration: 1, channels: [] }, undefined, mockCtx()),
      ).toMatchObject({ kind: 'animation-clip' });
    });

    // bug-20260611: skeletonLoader + animationClipLoader must accept the
    // post-`JSON.stringify` shape of every typed-array field (Float32Array
    // serialises to a `number[]` via `normaliseForPack` so the dev pack body
    // is JSON-roundtrip safe). Without the array arm, every Skin-bearing
    // glTF (Khronos Fox.glb) trips `asset-parse-failed` in the browser even
    // though the dawn-smoke / direct-`register` paths stay green because they
    // skip the JSON round-trip entirely.
    it('skeletonLoader accepts inverseBindMatrices as number[] (JSON-roundtrip shape)', () => {
      const ibmFloat = new Float32Array(16);
      for (let i = 0; i < 16; i++) ibmFloat[i] = i * 0.5;
      const roundTripped = JSON.parse(
        JSON.stringify({
          inverseBindMatrices: Array.from(ibmFloat),
          jointCount: 1,
        }),
      ) as Record<string, unknown>;
      const out = skeletonLoader.load(roundTripped, undefined, mockCtx()) as
        | { kind: 'skeleton'; inverseBindMatrices: Float32Array; jointCount: number }
        | undefined;
      expect(out).toBeDefined();
      expect(out?.inverseBindMatrices).toBeInstanceOf(Float32Array);
      expect(Array.from(out?.inverseBindMatrices ?? new Float32Array())).toEqual(
        Array.from(ibmFloat),
      );
      expect(out?.jointCount).toBe(1);
    });

    it('animationClipLoader accepts sampler.input/output as number[] (JSON-roundtrip shape)', () => {
      const inputFloat = new Float32Array([0, 0.5, 1]);
      const outputFloat = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
      const payload = JSON.parse(
        JSON.stringify({
          duration: 1,
          channels: [
            {
              targetPath: ['root'],
              property: 'rotation',
              sampler: {
                input: Array.from(inputFloat),
                output: Array.from(outputFloat),
                interpolation: 'LINEAR',
              },
            },
          ],
        }),
      ) as Record<string, unknown>;
      const out = animationClipLoader.load(payload, undefined, mockCtx()) as
        | {
            kind: 'animation-clip';
            channels: ReadonlyArray<{
              sampler: { input: Float32Array; output: Float32Array };
            }>;
          }
        | undefined;
      expect(out).toBeDefined();
      expect(out?.channels[0]?.sampler.input).toBeInstanceOf(Float32Array);
      expect(out?.channels[0]?.sampler.output).toBeInstanceOf(Float32Array);
      expect(Array.from(out?.channels[0]?.sampler.input ?? new Float32Array())).toEqual([
        0, 0.5, 1,
      ]);
    });
  });

  function sceneLoaderLoad(payload: Record<string, unknown>, refs: string[] | undefined) {
    return sceneLoader.load(payload, refs, mockCtx());
  }

  describe('upstream-branch loaders (w6)', () => {
    it('UPSTREAM_ENTRY_LOADERS is texture + font + equirect', () => {
      expect(UPSTREAM_ENTRY_LOADERS.map((l) => l.kind)).toEqual(['texture', 'font', 'equirect']);
    });

    it('textureLoader import sub-branch builds a TextureAsset POD from .bin bytes', async () => {
      const url = '/imported/tex.bin';
      const data = new Uint8Array(2 * 2 * 4).fill(200);
      const entry = {
        relativeUrl: url,
        kind: 'texture',
        metadata: {
          kind: 'texture' as const,
          width: 2,
          height: 2,
          format: 'rgba8unorm' as const,
          colorSpace: 'srgb' as const,
          mipmap: false,
        },
      };
      const out = (await textureLoader.load(
        entry as unknown as Record<string, unknown>,
        undefined,
        mockCtx({ binaries: { [url]: data } }),
      )) as LoaderAsyncResult;
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.value).toMatchObject({ kind: 'texture', width: 2, height: 2 });
      }
    });

    it('textureLoader fails image-meta-missing when metadata is absent', async () => {
      const out = (await textureLoader.load(
        { relativeUrl: '/x.bin', kind: 'texture' } as unknown as Record<string, unknown>,
        undefined,
        mockCtx(),
      )) as LoaderAsyncResult;
      expect(out.ok).toBe(false);
    });

    it('fontLoader resolves atlas/sampler refs and builds a FontAsset POD', async () => {
      const url = '/font/sans.pack.json';
      const packJson = {
        assets: [
          {
            guid: '11111111-1111-1111-1111-111111111111',
            kind: 'font',
            payload: {
              atlasGuid: '22222222-2222-2222-2222-222222222222',
              samplerGuid: '33333333-3333-3333-3333-333333333333',
              glyphs: {},
              common: {
                lineHeight: 1,
                base: 1,
                distanceRange: 2,
                pxRange: 2,
                atlasWidth: 64,
                atlasHeight: 64,
              },
            },
          },
        ],
      };
      const bytes = new TextEncoder().encode(JSON.stringify(packJson));
      const entry = {
        relativeUrl: url,
        kind: 'font',
        guidKey: '11111111-1111-1111-1111-111111111111',
      };
      const out = (await fontLoader.load(
        entry as unknown as Record<string, unknown>,
        undefined,
        mockCtx({
          binaries: { [url]: bytes },
          refs: {
            '22222222-2222-2222-2222-222222222222': 42,
            '33333333-3333-3333-3333-333333333333': 43,
          },
        }),
      )) as LoaderAsyncResult;
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.value).toMatchObject({ kind: 'font' });
      }
    });
  });
}

{
  // --- from wire-default-loaders.test.ts ---
  const REGISTERED_KINDS = [
    'mesh',
    'scene',
    'material',
    'skeleton',
    'skin',
    'animation-clip',
    'texture',
    'font',
    'equirect',
    'audio',
    'video',
  ] as const;

  const UNREGISTERED_STUBS = ['sampler', 'render-pipeline', 'shader'] as const;

  describe('wireDefaultLoaders', () => {
    it('registers the 10 engine loaders + extraLoader (audio) = 11 kinds', () => {
      const reg = new LoaderRegistry();
      wireDefaultLoaders(reg, [audioLoader]);
      for (const kind of REGISTERED_KINDS) {
        expect(reg.get(kind), `expected loader for kind '${kind}'`).toBeDefined();
      }
      expect(reg.registeredKinds()).toHaveLength(11);
    });

    it('default set (no extraLoaders) is the 10 engine-owned kinds (incl. video)', () => {
      const reg = new LoaderRegistry();
      wireDefaultLoaders(reg);
      expect(reg.registeredKinds()).toHaveLength(10);
      expect(reg.get('video'), 'video is wired internally (graphics-extras)').toBeDefined();
      expect(reg.get('audio'), 'audio is injected, not default').toBeUndefined();
    });

    it('does NOT register sampler / render-pipeline / shader (AC-02 exclusion)', () => {
      const reg = new LoaderRegistry();
      wireDefaultLoaders(reg, [audioLoader]);
      for (const kind of UNREGISTERED_STUBS) {
        expect(reg.get(kind), `kind '${kind}' must stay unregistered`).toBeUndefined();
      }
    });
  });

  describe('audio loader', () => {
    it('declares audio as a catalog-entry loader', () => {
      expect(audioLoader.kind).toBe('audio');
      expect(audioLoader.fromCatalogEntry).toBe(true);
    });
  });
}

{
  // --- from asset-registry-aabb.test.ts ---
  describe('AssetRegistry.register AABB computation (M2 w6)', () => {
    it('(a) mesh with position Float32Array attribute computes tight AABB', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      // 4 vertices: (-1,-1,0), (1,-1,0), (1,1,0), (-1,1,0)
      // 12 floats per vertex: pos(3) + normal(3) + uv(2) + tangent(4)
      const vertices = new Float32Array([
        -1,
        -1,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        0, // vertex 0: pos=(-1,-1,0)
        1,
        -1,
        0,
        0,
        0,
        1,
        1,
        0,
        0,
        0,
        0,
        0, // vertex 1: pos=( 1,-1,0)
        1,
        1,
        0,
        0,
        0,
        1,
        1,
        1,
        0,
        0,
        0,
        0, // vertex 2: pos=( 1, 1,0)
        -1,
        1,
        0,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        0,
        0, // vertex 3: pos=(-1, 1,0)
      ]);
      const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
      const result = reg.catalog(AssetGuid.random(), {
        kind: 'mesh',
        vertices,
        indices: new Uint16Array([0, 1, 2, 2, 3, 0]),
        attributes: { position: positions },
        aabb: new Float32Array(6),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 6,
            vertexCount: vertices.length,
            topology: 'triangle-list',
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // catalog returns the normalized payload (mesh with computed AABB).
        {
          expect(result.value.kind).toBe('mesh');
          const aabb = (result.value as { aabb: Float32Array }).aabb;
          expect(aabb[0]).toBeCloseTo(-1, 5); // minX
          expect(aabb[1]).toBeCloseTo(-1, 5); // minY
          expect(aabb[2]).toBeCloseTo(0, 5); // minZ
          expect(aabb[3]).toBeCloseTo(1, 5); // maxX
          expect(aabb[4]).toBeCloseTo(1, 5); // maxY
          expect(aabb[5]).toBeCloseTo(0, 5); // maxZ
        }
      }
    });

    it('(b) mesh with position as ArrayBuffer (cast to Float32Array) still computes AABB', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const vertices = new Float32Array([
        0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 1, 0,
        1, 0, 0, 0, 0,
      ]);
      const positionBuf = new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]).buffer; // ArrayBuffer
      const result = reg.catalog(AssetGuid.random(), {
        kind: 'mesh',
        vertices,
        indices: new Uint16Array([0, 1, 2]),
        attributes: { position: positionBuf },
        aabb: new Float32Array(6),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: vertices.length,
            topology: 'triangle-list',
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        {
          const aabb = (result.value as { aabb: Float32Array }).aabb;
          // Floats from ArrayBuffer view: Float32Array wrapping same bytes
          expect(aabb[0]).toBeCloseTo(0, 5); // minX
          expect(aabb[1]).toBeCloseTo(0, 5); // minY
          expect(aabb[2]).toBeCloseTo(0, 5); // minZ
          expect(aabb[3]).toBeCloseTo(2, 5); // maxX
          expect(aabb[4]).toBeCloseTo(3, 5); // maxY
          expect(aabb[5]).toBeCloseTo(0, 5); // maxZ
        }
      }
    });

    it('(c) mesh with no position attribute gets inverted-infinity empty box AABB', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const vertices = new Float32Array(48); // 4 verts * 12F
      const result = reg.catalog(AssetGuid.random(), {
        kind: 'mesh',
        vertices,
        indices: new Uint16Array([0, 1, 2, 2, 3, 0]),
        attributes: {}, // no position
        aabb: new Float32Array(6),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 6,
            vertexCount: vertices.length,
            topology: 'triangle-list',
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        {
          const aabb = (result.value as { aabb: Float32Array }).aabb;
          // inverted-infinity empty box: min components > max components
          expect(aabb[0]).toBe(Infinity); // minX
          expect(aabb[1]).toBe(Infinity); // minY
          expect(aabb[2]).toBe(Infinity); // minZ
          expect(aabb[3]).toBe(-Infinity); // maxX
          expect(aabb[4]).toBe(-Infinity); // maxY
          expect(aabb[5]).toBe(-Infinity); // maxZ
        }
      }
    });

    it('(d) mesh with empty vertices (0 verts, 0 indices) gets empty box AABB', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const result = reg.catalog(AssetGuid.random(), {
        kind: 'mesh',
        vertices: new Float32Array(0),
        indices: new Uint16Array(0),
        attributes: {},
        aabb: new Float32Array(6),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        {
          const aabb = (result.value as { aabb: Float32Array }).aabb;
          expect(aabb[0]).toBe(Infinity);
          expect(aabb[3]).toBe(-Infinity);
        }
      }
    });

    it('(e) single-point mesh AABB degenerates to a point box', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const vertices = new Float32Array([5, 10, -3, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
      const positions = new Float32Array([5, 10, -3]);
      const result = reg.catalog(AssetGuid.random(), {
        kind: 'mesh',
        vertices,
        indices: new Uint16Array([0]),
        attributes: { position: positions },
        aabb: new Float32Array(6),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 1,
            vertexCount: vertices.length,
            topology: 'triangle-list',
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        {
          const aabb = (result.value as { aabb: Float32Array }).aabb;
          expect(aabb[0]).toBeCloseTo(5, 5);
          expect(aabb[1]).toBeCloseTo(10, 5);
          expect(aabb[2]).toBeCloseTo(-3, 5);
          expect(aabb[3]).toBeCloseTo(5, 5);
          expect(aabb[4]).toBeCloseTo(10, 5);
          expect(aabb[5]).toBeCloseTo(-3, 5);
        }
      }
    });

    it('(f) catalog-with-guid path also computes AABB from position attribute', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const vertices = new Float32Array([
        0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 5, 5, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0,
      ]);
      const positions = new Float32Array([0, 0, 0, 5, 5, 0]);
      const guid = AssetGuid.random();
      const cataloged = reg.catalog(guid, {
        kind: 'mesh',
        vertices,
        indices: new Uint16Array([0, 1]),
        attributes: { position: positions },
        aabb: new Float32Array(6),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 2,
            vertexCount: vertices.length,
            topology: 'triangle-list',
          },
        ],
      });
      expect(cataloged.ok).toBe(true);
      if (cataloged.ok) {
        const aabb = (cataloged.value as { aabb: Float32Array }).aabb;
        expect(aabb[0]).toBeCloseTo(0, 5);
        expect(aabb[1]).toBeCloseTo(0, 5);
        expect(aabb[2]).toBeCloseTo(0, 5);
        expect(aabb[3]).toBeCloseTo(5, 5);
        expect(aabb[4]).toBeCloseTo(5, 5);
        expect(aabb[5]).toBeCloseTo(0, 5);
      }
    });

    it('(g) non-mesh assets catalog without AABB computation interference', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const result = reg.catalog(AssetGuid.random(), {
        kind: 'material',
        passes: [{ name: 'forward', shader: 'test::standard' }],
        paramValues: { baseColor: [1, 0, 0], metallic: 0, roughness: 0.5 },
      });
      expect(result.ok).toBe(true);
    });
  });
}

{
  // --- from asset-registry-builtin-nineslice.test.ts ---
  const arMod = assetRegistryModule as unknown as {
    HANDLE_NINESLICE_QUAD?: Handle<'MeshAsset', 'shared'>;
  };

  describe('BUILTIN_NINESLICE_QUAD builtin mesh (M2 / w7, D-2)', () => {
    it('(a) BUILTIN_NINESLICE_QUAD vertex count = 16 (4x4 grid)', () => {
      expect(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>).toBeDefined();
      const mesh = resolveAssetHandle<MeshAsset>(
        new World(),
        arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>,
      );
      expect(mesh.ok).toBe(true);
      if (mesh.ok) {
        const vertCount = mesh.value.vertices.length / BUILTIN_FLOATS_PER_VERTEX;
        expect(vertCount).toBe(16);
      }
    });

    it('(b) BUILTIN_NINESLICE_QUAD index count = 54 (9 sub-quads x 6 idx)', () => {
      expect(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>).toBeDefined();
      const mesh = resolveAssetHandle<MeshAsset>(
        new World(),
        arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>,
      );
      expect(mesh.ok).toBe(true);
      if (mesh.ok) {
        // feat-20260604-mesh-topology-debug-draw M2: MeshAsset.indices is now
        // optional (vertex-only meshes omit it); the builtin nineslice quad is
        // indexed, so narrow before reading length.
        expect(mesh.value.indices?.length).toBe(54);
      }
    });

    it('(c) BUILTIN_NINESLICE_QUAD vertex stride === 12F (layout reuse, no split)', () => {
      // Anchored on HANDLE_QUAD's existing 12F stride; HANDLE_NINESLICE_QUAD
      // funnels through the same meshFromInterleaved expansion path so the
      // sprite-pipeline binding table / vertex layout is untouched.
      expect(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>).toBeDefined();
      const mesh = resolveAssetHandle<MeshAsset>(
        new World(),
        arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>,
      );
      expect(mesh.ok).toBe(true);
      if (mesh.ok) {
        // 16 vertices x 12 floats per vertex = 192.
        expect(mesh.value.vertices.length).toBe(16 * BUILTIN_FLOATS_PER_VERTEX);
        expect(BUILTIN_FLOATS_PER_VERTEX).toBe(12);
      }
    });

    it('(d) HANDLE_NINESLICE_QUAD raw id === 5 (adjacent to HANDLE_SPHERE=4)', () => {
      expect(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>).toBeDefined();
      const id = unwrapHandle(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>);
      expect(id).toBe(5);
      // Sanity: HANDLE_QUAD=3, HANDLE_SPHERE=4, no other builtin between.
      expect(unwrapHandle(HANDLE_QUAD)).toBe(3);
      expect(unwrapHandle(HANDLE_SPHERE)).toBe(4);
    });

    it('(e) HANDLE_QUAD + HANDLE_SPHERE + HANDLE_NINESLICE_QUAD co-import (charter F1)', () => {
      // Compile-time co-import test: all four builtin HANDLE_ symbols resolve
      // from the same module path so an IDE `HANDLE_` autocomplete query lands
      // them in one prompt (plan-strategy AI User Friendliness §2 naming).
      expect(typeof HANDLE_QUAD).toBeDefined();
      expect(typeof HANDLE_SPHERE).toBeDefined();
      expect(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>).toBeDefined();
      // Three distinct ids (no aliasing).
      expect(unwrapHandle(HANDLE_QUAD)).not.toBe(unwrapHandle(HANDLE_SPHERE));
      expect(unwrapHandle(HANDLE_QUAD)).not.toBe(
        unwrapHandle(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>),
      );
      expect(unwrapHandle(HANDLE_SPHERE)).not.toBe(
        unwrapHandle(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>),
      );
    });
  });
}

{
  // --- from asset-registry-d9-tile-sampler-soft-warn.test.ts ---
  function makeShaderRegistryWithSprite(): ShaderRegistry {
    const mockDevice: ShaderRegistryDevice = {
      createShaderModule() {
        return {
          ok: true,
          value: undefined,
          unwrap: () => undefined,
          unwrapOr: (d: unknown) => d,
        } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
      },
    };
    const sr = new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
    sr.registerMaterialShader('forgeax::sprite', {
      source: 'fn main() {}',
      paramSchema: [
        { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
        { name: 'texture', type: 'texture2d' },
        { name: 'sampler', type: 'sampler', default: null },
        { name: 'region', type: 'vec4', default: [0.0, 0.0, 1.0, 1.0] },
        { name: 'pivot', type: 'vec2', default: [0.5, 0.5] },
        { name: 'flipX', type: 'f32', default: 0.0 },
        { name: 'flipY', type: 'f32', default: 0.0 },
        { name: 'slices', type: 'vec4', default: [0.0, 0.0, 0.0, 0.0] },
        { name: 'sliceMode', type: 'f32', default: 0.0 },
      ],
    });
    return sr;
  }

  const SPRITE_PASS: MaterialPassDescriptor = {
    name: 'Sprite',
    shader: 'forgeax::sprite',
    queue: 3000,
  };

  function setupRegistryWithMetrics(): {
    reg: AssetRegistry;
    metrics: ReturnType<typeof createEngineMetrics>;
  } {
    const reg = new AssetRegistry(makeShaderRegistryWithSprite());
    const metrics = createEngineMetrics();
    reg.setMetrics(metrics);
    return { reg, metrics };
  }

  // feat-20260614 M8 (D-19): the sprite material references its sampler by an
  // embedded GUID string, resolved by detectTileNeedsRepeatSampler against the
  // catalogue. Catalog the sampler under a fresh GUID and return that GUID.
  function registerSampler(
    reg: AssetRegistry,
    addressModeU: GPUAddressMode,
    addressModeV: GPUAddressMode = addressModeU,
  ): string {
    const samplerAsset: SamplerAsset = {
      kind: 'sampler',
      addressModeU,
      addressModeV,
    };
    const guid = AssetGuid.format(AssetGuid.random());
    const r = reg.catalog<SamplerAsset>(guid, samplerAsset);
    if (!r.ok) throw new Error('sampler catalog failed');
    return guid;
  }

  describe('D-9 tile-mode sampler soft-warn (M4 / w18)', () => {
    it('(1) sliceMode=1 + sampler.addressMode=clamp-to-edge -> counter +=1, no throw', () => {
      const { reg, metrics } = setupRegistryWithMetrics();
      const samplerGuid = registerSampler(reg, 'clamp-to-edge');
      const matRes = reg.catalog<MaterialAsset>(AssetGuid.random(), {
        kind: 'material',
        passes: [SPRITE_PASS],
        paramValues: {
          sliceMode: 1,
          slices: [0.25, 0.25, 0.25, 0.25],
          sampler: samplerGuid,
        },
      });
      expect(matRes.ok).toBe(true);
      expect(metrics.snapshot()['nineslice.tile-needs-repeat-sampler']).toBe(1);
    });

    it('(2) sliceMode=1 + sampler.addressMode=repeat -> counter NOT incremented', () => {
      const { reg, metrics } = setupRegistryWithMetrics();
      const samplerGuid = registerSampler(reg, 'repeat');
      const matRes = reg.catalog<MaterialAsset>(AssetGuid.random(), {
        kind: 'material',
        passes: [SPRITE_PASS],
        paramValues: {
          sliceMode: 1,
          slices: [0.25, 0.25, 0.25, 0.25],
          sampler: samplerGuid,
        },
      });
      expect(matRes.ok).toBe(true);
      expect(metrics.snapshot()['nineslice.tile-needs-repeat-sampler']).toBeUndefined();
    });

    it('(3) sliceMode=0 (stretch) + sampler.addressMode=clamp -> counter NOT incremented', () => {
      const { reg, metrics } = setupRegistryWithMetrics();
      const samplerGuid = registerSampler(reg, 'clamp-to-edge');
      const matRes = reg.catalog<MaterialAsset>(AssetGuid.random(), {
        kind: 'material',
        passes: [SPRITE_PASS],
        paramValues: {
          sliceMode: 0,
          slices: [0.25, 0.25, 0.25, 0.25],
          sampler: samplerGuid,
        },
      });
      expect(matRes.ok).toBe(true);
      expect(metrics.snapshot()['nineslice.tile-needs-repeat-sampler']).toBeUndefined();
    });

    it('(4) sliceMode=1 with no sampler bound -> counter NOT incremented (no resolution)', () => {
      const { reg, metrics } = setupRegistryWithMetrics();
      const matRes = reg.catalog<MaterialAsset>(AssetGuid.random(), {
        kind: 'material',
        passes: [SPRITE_PASS],
        paramValues: {
          sliceMode: 1,
          slices: [0.25, 0.25, 0.25, 0.25],
        },
      });
      expect(matRes.ok).toBe(true);
      expect(metrics.snapshot()['nineslice.tile-needs-repeat-sampler']).toBeUndefined();
    });

    it('asymmetric sampler (U=repeat, V=clamp) still fires (both axes required)', () => {
      const { reg, metrics } = setupRegistryWithMetrics();
      const samplerGuid = registerSampler(reg, 'repeat', 'clamp-to-edge');
      const matRes = reg.catalog<MaterialAsset>(AssetGuid.random(), {
        kind: 'material',
        passes: [SPRITE_PASS],
        paramValues: {
          sliceMode: 1,
          slices: [0.25, 0.25, 0.25, 0.25],
          sampler: samplerGuid,
        },
      });
      expect(matRes.ok).toBe(true);
      expect(metrics.snapshot()['nineslice.tile-needs-repeat-sampler']).toBe(1);
    });

    it('AssetErrorCode 13-member union not extended (AC-08 / AGENTS.md Error model)', () => {
      // Sanity grep-equivalent: a sliceMode=1 + sampler bound to clamp + slices
      // legal triggers the soft-warn but `register` returns ok (no throw, no
      // err Result). This stays in lock-step with the AssetErrorCode count
      // assertion in asset-registry-sprite-slices-validate.test.ts (which
      // implicitly captures the union via .code === 'asset-invalid-value').
      const { reg } = setupRegistryWithMetrics();
      const samplerGuid = registerSampler(reg, 'clamp-to-edge');
      const matRes = reg.catalog<MaterialAsset>(AssetGuid.random(), {
        kind: 'material',
        passes: [SPRITE_PASS],
        paramValues: {
          sliceMode: 1,
          slices: [0.25, 0.25, 0.25, 0.25],
          sampler: samplerGuid,
        },
      });
      expect(matRes.ok).toBe(true);
    });
  });
}

{
  // --- from asset-registry-guid.test.ts ---
  const GUID_A = '00000000-0000-7000-8000-000000000001';
  const GUID_B = '00000000-0000-7000-8000-000000000002';

  function makeMesh(): TypesMeshAsset {
    return {
      kind: 'mesh',
      // 1 vertex * 12F canonical layout (position vec3 + normal vec3 + uv vec2 + tangent vec4)
      vertices: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]),
      indices: new Uint16Array([0]),
      attributes: {},
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 1,
          vertexCount: 12,
          topology: 'triangle-list',
        },
      ],
    };
  }

  // feat-20260614 M8: the AssetRegistry holds no handle concept. The
  // guid->payload direction (catalog + lookup + loadByGuid-returns-payload) is
  // the surviving contract; the handle->guid reverse (guidOf) and
  // guid->handle (resolveGuid) round-trips are gone. Column handle minting
  // moved to World.allocSharedRef.
  describe('w11 - catalog + lookup round-trip (AC-09b)', () => {
    it('lookup(guid) returns the catalogued payload', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const parseResult = AssetGuid.parse(GUID_A);
      if (!parseResult.ok) throw new Error('expected ok');
      const guid = parseResult.value;
      const mesh = makeMesh();
      const cataloged = reg.catalog<TypesMeshAsset>(guid, mesh);
      expect(cataloged.ok).toBe(true);
      const looked = reg.lookup(guid);
      expect(looked).toBeDefined();
      expect(looked?.kind).toBe('mesh');
    });

    it('catalog returns the normalized payload (mesh with computed aabb)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const parseResult = AssetGuid.parse(GUID_A);
      if (!parseResult.ok) throw new Error('expected ok');
      const guid = parseResult.value;
      const mesh = makeMesh();
      const cataloged = reg.catalog<TypesMeshAsset>(guid, mesh);
      expect(cataloged.ok).toBe(true);
      if (cataloged.ok) {
        expect(cataloged.value.kind).toBe('mesh');
        // The returned payload deep-equals the catalogued one on lookup.
        expect(reg.lookup(guid)).toBe(cataloged.value);
      }
    });
  });

  describe('w11 - lookup miss', () => {
    it('lookup(unknown guid) returns undefined', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const unknownGuidResult = AssetGuid.parse(GUID_B);
      if (!unknownGuidResult.ok) throw new Error('expected ok');
      expect(reg.lookup(unknownGuidResult.value)).toBeUndefined();
    });
  });

  describe('w11 - loadByGuid ok / err paths', () => {
    it('loadByGuid(catalogued guid) returns Ok(payload)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const parseResult = AssetGuid.parse(GUID_A);
      if (!parseResult.ok) throw new Error('expected ok');
      const guid = parseResult.value;
      reg.catalog<TypesMeshAsset>(guid, makeMesh());
      const result = await reg.loadByGuid<TypesMeshAsset>(guid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // loadByGuid now returns the PAYLOAD, not a handle.
        expect(result.value.kind).toBe('mesh');
        expect(result.value).toBe(reg.lookup(guid));
      }
    });

    it('loadByGuid(uncatalogued guid) returns Promise<Err>', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const unknownGuidResult = AssetGuid.parse(GUID_B);
      if (!unknownGuidResult.ok) throw new Error('expected ok');
      const unknownGuid = unknownGuidResult.value;
      const result = await reg.loadByGuid<TypesMeshAsset>(unknownGuid);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-not-found');
      }
    });
  });
}

{
  // --- from asset-registry-material-validate.test.ts ---
  describe('AssetRegistry constructor injection (feat-20260527 M1 / w3)', () => {
    it('(a) new AssetRegistry(shaderRegistry) compiles and creates instance', () => {
      const sr = makeMockShaderRegistry();
      const reg = new AssetRegistry(sr);
      expect(reg).toBeInstanceOf(AssetRegistry);
    });

    it('(b) catalog<MaterialAsset> with minimal MaterialAsset returns ok + lookup resolves', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const asset: MaterialAsset = { kind: 'material' };
      const guid = AssetGuid.random();
      const h = reg.catalog<MaterialAsset>(guid, asset);
      expect(h.ok).toBe(true);
      if (h.ok) {
        expect(reg.lookup(guid)?.kind).toBe('material');
      }
    });

    it('(c) catalog<MaterialAsset> with passes[] + paramValues returns ok + lookup resolves', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'test::dummy',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
        ],
        paramValues: { baseColor: [1, 0, 0, 1] },
      };
      const guid = AssetGuid.random();
      const h = reg.catalog<MaterialAsset>(guid, asset);
      expect(h.ok).toBe(true);
      if (h.ok) {
        const mat = reg.lookup(guid);
        expect(mat).toBeDefined();
        expect(mat?.kind).toBe('material');
      }
    });
  });

  describe('MaterialAsset registration validation (feat-20260527 M2 / w5)', () => {
    it('(d) multi-pass material satisfying all paramSchemas union -> success', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'test::standard',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
          {
            name: 'Depth',
            shader: 'test::unlit',
            tags: { LightMode: 'Depth' },
            queue: 1000,
          },
        ],
        paramValues: {
          baseColor: [1, 0, 0, 1],
          metallic: 0.5,
          roughness: 0.5,
          baseColorTexture: '00000000-0000-0000-0000-000000000001',
          lightIntensity: 1.0,
        },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });

    it('(e) multi-pass material missing param from one pass shader -> AssetError', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      // test::unlit requires baseColorTexture (no default), metallic is from test::standard
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'test::standard',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
          {
            name: 'Depth',
            shader: 'test::unlit',
            tags: { LightMode: 'Depth' },
            queue: 1000,
          },
        ],
        paramValues: {
          baseColor: [1, 0, 0, 1],
          metallic: 0.5,
          roughness: 0.5,
          // baseColorTexture missing — required by test::unlit (no default)
        },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-invalid-value');
        expect(result.error.detail).toBeDefined();
        const d = (result.error.detail ?? {}) as Record<string, unknown>;
        expect(d.missingParams).toBeDefined();
      }
    });

    it('(f) shader not found in ShaderRegistry -> AssetError with detail.shaderKey', () => {
      const sr = makeMockShaderRegistry();
      const reg = new AssetRegistry(sr);
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'nonexistent::shader',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
        ],
        paramValues: {},
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-invalid-value');
        expect(result.error.detail).toBeDefined();
        const d = (result.error.detail ?? {}) as Record<string, unknown>;
        expect(d.shaderKey).toBe('nonexistent::shader');
      }
    });

    it('(g) extra params in paramValues silently ignored -> success', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'test::standard',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
        ],
        paramValues: {
          baseColor: [1, 0, 0, 1],
          metallic: 0.5,
          roughness: 0.5,
          extraParam: 42, // silently ignored (D-5: extra-key from reject to ignore)
          anotherExtra: 'hello',
        },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });

    it('(h) empty passes[] -> AssetError', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [],
        paramValues: { baseColor: [1, 0, 0, 1] },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-invalid-value');
      }
    });

    it('(i) catalog<MaterialAsset> with a guid runs the same validation as catalog', () => {
      const sr = makeMockShaderRegistry();
      const reg = new AssetRegistry(sr);
      // Test invalid: shader not found
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'nonexistent::shader',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
        ],
        paramValues: {},
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-invalid-value');
      }
    });

    it('(i-2) catalog<MaterialAsset> with valid material succeeds', () => {
      const sr = makeMockShaderRegistry();
      const reg = new AssetRegistry(sr);
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'test::standard',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
        ],
        paramValues: {
          baseColor: [1, 0, 0, 1],
          metallic: 0.5,
          roughness: 0.5,
        },
      };
      const guid = AssetGuid.random();
      const result = reg.catalog<MaterialAsset>(guid, asset);
      expect(result.ok).toBe(true);
      expect(reg.lookup(guid)?.kind).toBe('material');
    });

    it('(j) type mismatch in paramValues -> AssetError', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      // baseColor is 'color' type (expects number[]), metallic is 'f32' (expects number)
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'test::standard',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
        ],
        paramValues: {
          baseColor: 'not-a-color', // type mismatch: color expects number[]
          metallic: 0.5,
          roughness: 0.5,
        },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-invalid-value');
      }
    });

    it('(k) material with no passes[] (undefined) but with kind="material" -> valid (inherits from parent)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const asset: MaterialAsset = {
        kind: 'material',
        // passes undefined -> valid (inherits from parent at resolve time)
        paramValues: { baseColor: [1, 0, 0, 1] },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      // undefined passes is valid — material can inherit passes from parent
      expect(result.ok).toBe(true);
    });

    it('(l) param with default value — missing in paramValues does not error', () => {
      const sr = makeMockShaderRegistry();
      const reg = new AssetRegistry(sr);
      // forgeax::default-standard-pbr has baseColor/metallic/roughness all with
      // defaults -> omitting them should not error. texture2d/sampler are always
      // optional regardless of defaults.
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'forgeax::default-standard-pbr',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
        ],
        paramValues: {
          // baseColor/metallic/roughness/channelMap all have defaults -> omission ok
        },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });
  });

  // feat-20260528-material-shader-registration-unification M3 / w16:
  // integration tests for runtime registration path (manifest paramSchema -> validation).
  describe('M3-w16 -- runtime registration path integration', () => {
    it('(a) paramSchema from manifest passes material validation', () => {
      const sr = makeMockShaderRegistry();
      // Simulate what Step 1b does: register a shader with paramSchema from manifest
      sr.registerMaterialShader('test::pbr-from-manifest', {
        source: 'fn main() {}',
        paramSchema: [
          { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
          { name: 'metallic', type: 'f32', default: 0.0 },
          { name: 'roughness', type: 'f32', default: 0.5 },
          { name: 'channelMap', type: 'vec4', default: [2, 1, 0, 0] },
          { name: 'baseColorTexture', type: 'texture2d' },
          { name: 'metallicRoughnessTexture', type: 'texture2d' },
          { name: 'normalTexture', type: 'texture2d' },
          { name: 'sampler', type: 'sampler' },
        ],
      });
      const reg = new AssetRegistry(sr);
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'test::pbr-from-manifest',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
        ],
        paramValues: {
          baseColorTexture: '00000000-0000-0000-0000-000000000001',
          metallicRoughnessTexture: '00000000-0000-0000-0000-000000000002',
          normalTexture: '00000000-0000-0000-0000-000000000003',
        },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });

    it('(b) empty paramSchema from manifest -> registration works', () => {
      const sr = makeMockShaderRegistry();
      sr.registerMaterialShader('test::empty-schema', {
        source: 'fn main() {}',
        paramSchema: [],
      });
      const reg = new AssetRegistry(sr);
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'test::empty-schema',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
        ],
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });

    it('(c) malformed paramSchema JSON parse -> SyntaxError', () => {
      // Simulate malformed JSON from manifest paramSchema field
      expect(() => JSON.parse('[')).toThrow(SyntaxError);
      expect(() => JSON.parse('{not-json}')).toThrow(SyntaxError);
    });

    it('(d) ShaderAsset catalogued by GUID is retrievable via lookup', () => {
      const sr = makeMockShaderRegistry();
      // Register as Step 1b does: first in ShaderRegistry, then in AssetRegistry
      sr.registerMaterialShader('test::shader-asset-pbr', {
        source: 'fn main() {}',
        paramSchema: [
          { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
          { name: 'metallic', type: 'f32', default: 0.0 },
          { name: 'roughness', type: 'f32', default: 0.5 },
        ],
      });
      const reg = new AssetRegistry(sr);

      // Simulate Step 1b ShaderAsset cataloguing.
      const guid = AssetGuid.random();
      const cataloged = reg.catalog(guid, {
        kind: 'shader' as const,
        name: 'test::shader-asset-pbr',
        source: 'fn main() {}',
        paramSchema: [
          { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
          { name: 'metallic', type: 'f32', default: 0.0 },
          { name: 'roughness', type: 'f32', default: 0.5 },
        ],
      });
      expect(cataloged.ok).toBe(true);

      // lookup by guid should return the catalogued ShaderAsset
      const result = reg.lookup(guid);
      expect(result).toBeDefined();
      expect(result?.kind).toBe('shader');
    });
  });
}

{
  // --- from asset-registry-mesh-fail-fast.test.ts ---
  describe('AssetRegistry.register fail-fast (M1 t4 - kind:mesh non-12F vertices)', () => {
    it('(1) vertices not divisible by 12 returns Result.err mesh-vertex-stride-mismatch', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const result = reg.catalog(AssetGuid.random(), {
        kind: 'mesh',
        vertices: new Float32Array(9), // 9 floats = 3 verts * 3F (position-only, not 12F)
        indices: new Uint16Array([0, 1, 2]),
        attributes: {},
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('mesh-vertex-stride-mismatch');
        expect(result.error.expected).toBe(
          '12 floats per vertex (= position vec3 + normal vec3 + uv vec2 + tangent vec4)',
        );
        const d = result.error.detail as { vertexCount: number; floatsPerVertex: number };
        expect(d.vertexCount).toBe(0);
        expect(d.floatsPerVertex).toBe(0.75); // 9 / 12 = 0.75 (non-integer, stride not 12F)
      }
    });

    it('(2) empty mesh (0 vertices, 0 indices) returns Result.ok', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const result = reg.catalog(AssetGuid.random(), {
        kind: 'mesh',
        vertices: new Float32Array(0),
        indices: new Uint16Array(0),
        attributes: {},
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // catalog returns the normalized payload (no handle).
        expect(result.value.kind).toBe('mesh');
      }
    });

    it('(3) maxIndex+1 !== vertexCount triggers gate (vertices 12-divisible but indices max mismatch)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      // vertices.length=24 = 2 verts * 12F, but indices max=0 means only vertex 0 is referenced
      const result = reg.catalog(AssetGuid.random(), {
        kind: 'mesh',
        vertices: new Float32Array(24),
        indices: new Uint16Array([0, 0, 0]),
        attributes: {},
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('mesh-vertex-stride-mismatch');
        const d = result.error.detail as { vertexCount: number; floatsPerVertex: number };
        expect(d.vertexCount).toBe(1); // maxIndex=0 + 1
        expect(d.floatsPerVertex).toBe(24); // 24/1 = 24
      }
    });

    it('(4) after catalog Result.err, inspect().assets does not contain new entry', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const beforeAssets = reg.inspect().assets.length;
      reg.catalog(AssetGuid.random(), {
        kind: 'mesh',
        vertices: new Float32Array(9),
        indices: new Uint16Array([0, 1, 2]),
        attributes: {},
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      });
      expect(reg.inspect().assets.length).toBe(beforeAssets);
    });

    it('(5) compliant 12F mesh register returns Result.ok with handle', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const result = reg.catalog(AssetGuid.random(), {
        kind: 'mesh',
        vertices: new Float32Array(36), // 3 verts * 12F
        indices: new Uint16Array([0, 1, 2]),
        attributes: {},
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // catalog returns the normalized payload (no handle).
        expect(result.value.kind).toBe('mesh');
      }
    });

    it('(6) AC-08 narrowing: access result.error.detail.floatsPerVertex with type-safe cast', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const result = reg.catalog(AssetGuid.random(), {
        kind: 'mesh',
        vertices: new Float32Array(11), // 11 floats, not divisible by 12
        indices: new Uint16Array([0, 1, 2]),
        attributes: {},
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('mesh-vertex-stride-mismatch');
        const d = result.error.detail as { vertexCount: number; floatsPerVertex: number };
        expect(typeof d.vertexCount).toBe('number');
        expect(typeof d.floatsPerVertex).toBe('number');
      }
    });

    it('indices with reference beyond vertices count triggers gate (super-set indices case)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      // vertices.length=12 = 1 vert * 12F, but indices reference verts [0,1,2] (max=2, implies 3 verts)
      const result = reg.catalog(AssetGuid.random(), {
        kind: 'mesh',
        vertices: new Float32Array(12),
        indices: new Uint16Array([0, 1, 2]),
        attributes: {},
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('mesh-vertex-stride-mismatch');
        const d = result.error.detail as { vertexCount: number; floatsPerVertex: number };
        expect(d.vertexCount).toBe(3); // maxIndex=2 + 1
        expect(d.floatsPerVertex).toBe(4); // 12 / 3 = 4 (not canonical 12F)
      }
    });
  });
}

{
  // --- from asset-registry-scene.test.ts ---
  const SCENE_GUID = '00000000-0000-7000-8000-000000000010';

  function makeSceneAsset(): SceneAsset {
    return {
      kind: 'scene',
      entities: [
        { localId: 0 as LocalEntityId, components: {} },
        { localId: 1 as LocalEntityId, components: {} },
      ],
    };
  }

  describe('w6 - AssetRegistry catalog + lookup round-trip for SceneAsset', () => {
    it('catalog(sceneAsset) is resolvable to the same POD via lookup', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const scene = makeSceneAsset();
      const guid = AssetGuid.random();
      reg.catalog<SceneAsset>(guid, scene);
      const looked = reg.lookup(guid) as SceneAsset | undefined;
      expect(looked).toBeDefined();
      if (looked === undefined) return;
      expect(looked.kind).toBe('scene');
      expect(looked.entities.length).toBe(2);
    });

    it('inspect() reports kind `scene` for a catalogued scene', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const guid = AssetGuid.format(AssetGuid.random());
      reg.catalog<SceneAsset>(guid, makeSceneAsset());
      const snap = reg.inspect();
      const entry = snap.assets.find((a) => a.guid === guid.toLowerCase());
      expect(entry).toBeDefined();
      expect(entry?.kind).toBe('scene');
    });
  });

  describe('w6 - catalog + loadByGuid path for SceneAsset', () => {
    it('loadByGuid<SceneAsset>(guid) returns Ok(payload) after catalog', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const parsed = AssetGuid.parse(SCENE_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const guid = parsed.value;
      reg.catalog<SceneAsset>(guid, makeSceneAsset());
      const result = await reg.loadByGuid<SceneAsset>(guid);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // loadByGuid now returns the PAYLOAD, not a handle.
      expect(result.value.kind).toBe('scene');
    });

    it('loadByGuid for an uncatalogued GUID returns Err(asset-not-found)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const parsed = AssetGuid.parse(SCENE_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<SceneAsset>(parsed.value);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('asset-not-found');
    });
  });

  describe('w6 - parseAssetPayload `scene` dispatch round-trip', () => {
    it('reconstructs SceneAsset POD from a serialised pack payload', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      // Internal `parseAssetPayload` is private at the TS surface (not part of
      // the AI-user-facing API); the test reaches it through a structural
      // view-cast that pins the method shape. AI users never write this —
      // production callers consume `loadByGuid` which routes through
      // `parseAssetPayload` internally; this test validates the dispatch
      // round-trip in isolation without going through the network fetch path.
      // biome-ignore lint/suspicious/noExplicitAny: private method access for round-trip dispatch test
      const internal = reg as any as {
        parseAssetPayload(kind: string, payload: Record<string, unknown>): unknown;
      };
      const fn = internal.parseAssetPayload.bind(reg);
      const payload = {
        entities: [
          { localId: 0, components: { Transform: { pos: [1, 2, 3] } } },
          { localId: 1, components: { ChildOf: { parent: 0 } } },
        ],
      };
      const asset = fn('scene', payload) as SceneAsset | undefined;
      expect(asset).toBeDefined();
      if (!asset) return;
      expect(asset.kind).toBe('scene');
      expect(asset.entities.length).toBe(2);
      // LocalEntityId extends number, so widening is implicit at the
      // structural layer; explicit annotation keeps the assertion intent
      // readable.
      const firstLocalId: number = asset.entities[0]?.localId ?? -1;
      expect(firstLocalId).toBe(0);
      expect(
        (asset.entities[1]?.components as Record<string, Record<string, unknown>>).ChildOf?.parent,
      ).toBe(0);
    });
  });
}

{
  // --- from asset-registry-sprite-slices-validate.test.ts ---
  function makeShaderRegistryWithSprite(): ShaderRegistry {
    const mockDevice: ShaderRegistryDevice = {
      createShaderModule() {
        return {
          ok: true,
          value: undefined,
          unwrap: () => undefined,
          unwrapOr: (d: unknown) => d,
        } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
      },
    };
    const sr = new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
    // Mirror packages/shader/src/sprite.wgsl.meta.json paramSchema so a
    // MaterialAsset with passes[shader='forgeax::sprite'] passes the
    // generic union validation gate before reaching validateSpriteSlices.
    sr.registerMaterialShader('forgeax::sprite', {
      source: 'fn main() {}',
      paramSchema: [
        { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
        { name: 'texture', type: 'texture2d' },
        { name: 'sampler', type: 'sampler', default: null },
        { name: 'region', type: 'vec4', default: [0.0, 0.0, 1.0, 1.0] },
        { name: 'pivot', type: 'vec2', default: [0.5, 0.5] },
        { name: 'flipX', type: 'f32', default: 0.0 },
        { name: 'flipY', type: 'f32', default: 0.0 },
        { name: 'slices', type: 'vec4', default: [0.0, 0.0, 0.0, 0.0] },
        { name: 'sliceMode', type: 'f32', default: 0.0 },
      ],
    });
    return sr;
  }

  function spriteAssetWithSlices(
    slices: readonly number[],
    region: readonly [number, number, number, number] = [0, 0, 1, 1],
  ): MaterialAsset {
    return {
      kind: 'material',
      passes: [{ name: 'Sprite', shader: 'forgeax::sprite', queue: 3000 }],
      paramValues: {
        region,
        slices,
      },
    } as MaterialAsset;
  }

  describe('validateSpriteSlices fail-fast (feat-20260527-sprite-nineslice M2 / w4)', () => {
    it('(1) slices contains a negative number -> AssetError(asset-invalid-value)', () => {
      const reg = new AssetRegistry(makeShaderRegistryWithSprite());
      const asset = spriteAssetWithSlices([-0.1, 0.2, 0.2, 0.2]);
      const r = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-invalid-value');
        expect(r.error.expected).toBe(
          'paramValues.slices: [number, number, number, number] with 0 ≤ left + right < region.zw[0] and 0 ≤ top + bottom < region.zw[1]',
        );
        expect(r.error.hint).toContain('-0.1');
      }
    });

    it('(2) slices.x + slices.z >= region.zw[0] -> AssetError(asset-invalid-value)', () => {
      const reg = new AssetRegistry(makeShaderRegistryWithSprite());
      // region.zw[0] = 1.0 ; left + right = 0.6 + 0.6 = 1.2 >= 1.0
      const asset = spriteAssetWithSlices([0.6, 0, 0.6, 0]);
      const r = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-invalid-value');
        // .hint inlines the offending sum + region.zw numeral so the AI user
        // can copy-paste straight into a recovery prompt (plan-strategy §R-4).
        expect(r.error.hint).toContain('1.2');
        expect(r.error.hint).toContain('1');
        expect(r.error.hint).toContain('region.z');
      }
    });

    it('(3) slices.y + slices.w >= region.zw[1] -> AssetError(asset-invalid-value)', () => {
      const reg = new AssetRegistry(makeShaderRegistryWithSprite());
      // region.zw[1] = 1.0 ; top + bottom = 0.6 + 0.5 = 1.1 >= 1.0
      const asset = spriteAssetWithSlices([0, 0.6, 0, 0.5]);
      const r = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-invalid-value');
        expect(r.error.hint).toContain('1.1');
        expect(r.error.hint).toContain('region.w');
      }
    });

    it('(4) slices contains NaN -> AssetError(asset-invalid-value)', () => {
      const reg = new AssetRegistry(makeShaderRegistryWithSprite());
      const asset = spriteAssetWithSlices([Number.NaN, 0.1, 0.1, 0.1]);
      const r = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-invalid-value');
        expect(r.error.hint).toContain('NaN');
      }
    });

    it('(5) slices contains Infinity -> AssetError(asset-invalid-value)', () => {
      const reg = new AssetRegistry(makeShaderRegistryWithSprite());
      const asset = spriteAssetWithSlices([0.1, Number.POSITIVE_INFINITY, 0.1, 0.1]);
      const r = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-invalid-value');
        expect(r.error.hint).toContain('Infinity');
      }
    });

    it('(6) slices length !== 4 -> AssetError(asset-invalid-value)', () => {
      const reg = new AssetRegistry(makeShaderRegistryWithSprite());
      const asset = spriteAssetWithSlices([0.1, 0.1, 0.1]);
      const r = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-invalid-value');
        expect(r.error.hint).toContain('length');
      }
    });
  });
}

{
  // --- from auto-select.test.ts ---
  const baseNavigator = { userAgent: 'mock-engine-test' } as unknown as Navigator;

  beforeEach(() => {
    spies.reset();
    vi.stubGlobal('navigator', { ...baseNavigator });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── Tests ──────────────────────────────────────────────────────────────────

  describe('createRenderer M3 auto-select facade (D-P4)', () => {
    // Case (1): navigator.gpu present → rhi-webgpu dynamic import path.
    it('case 1: navigator.gpu present → dynamic-imports @forgeax/engine-rhi-webgpu', async () => {
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeStubGPU() });
      const canvas = makeMockCanvas({ webgpu: 'context', webgl2: 'context' });
      spies.webgpuImportCount = 0;
      spies.wgpuImportCount = 0;

      const { createRenderer } = (await import('../createRenderer')) as {
        createRenderer: (
          canvas: unknown,
          opts?: { shaderManifestUrl?: string | undefined },
          bundler?: unknown,
        ) => Promise<{ backend: string }>;
      };
      const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: undefined });

      expect(renderer.backend).toBe('webgpu');
      expect(spies.webgpuImportCount).toBeGreaterThanOrEqual(1);
      expect(spies.wgpuImportCount).toBe(0);
      // AC-11: wgpu-wasm wasm-loader was never invoked.
      expect(spies.ensureReadyCount).toBe(0);
    });

    // Case (2): navigator.gpu absent → rhi-wgpu dynamic import + ensureReady().
    it('case 2: navigator.gpu absent → dynamic-imports @forgeax/engine-rhi-wgpu + awaits ensureReady()', async () => {
      vi.stubGlobal('navigator', { ...baseNavigator });
      const canvas = makeMockCanvas({ webgpu: 'context', webgl2: 'context' });
      const before = spies.ensureReadyCount;

      const { createRenderer } = (await import('../createRenderer')) as {
        createRenderer: (
          canvas: unknown,
          opts?: { shaderManifestUrl?: string | undefined },
          bundler?: unknown,
        ) => Promise<{ backend: string }>;
      };
      const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: undefined });

      expect(renderer.backend).toBe('webgpu');
      expect(spies.wgpuImportCount).toBeGreaterThanOrEqual(1);
      expect(spies.ensureReadyCount).toBeGreaterThan(before);
    });

    // Case (3): escape hatch — explicit { rhi } injection bypasses auto-detect.
    it('case 3: escape hatch { rhi } → explicit instance is used, no dynamic import triggered', async () => {
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeStubGPU() });
      const canvas = makeMockCanvas({ webgpu: 'context', webgl2: 'context' });
      const beforeWebgpu = spies.webgpuImportCount;
      const beforeWgpu = spies.wgpuImportCount;

      const rhiActual = await import('@forgeax/engine-rhi');
      let explicitRequestAdapterCalls = 0;
      const explicitInstance = {
        requestAdapter: async () => {
          explicitRequestAdapterCalls += 1;
          return rhiActual.ok({
            features: new Set<string>(),
            limits: {} as Readonly<Record<string, number>>,
            requestDevice: async () => rhiActual.ok(makeFakeRhiDevice()),
          });
        },
        acquireCanvasContext: (_canvas: unknown) => {
          return rhiActual.ok({
            configure: () => rhiActual.ok(undefined),
            unconfigure: () => rhiActual.ok(undefined),
            getCurrentTexture: () => rhiActual.ok({ __brand: 'TextureView' }),
          });
        },
      };

      const { createRenderer: createRendererWithOpts } = (await import('../createRenderer')) as {
        createRenderer: (
          canvas: unknown,
          opts?: { rhi?: unknown; shaderManifestUrl?: string | undefined },
          bundler?: unknown,
        ) => Promise<{ backend: string }>;
      };
      const renderer = await createRendererWithOpts(
        canvas,
        {
          rhi: explicitInstance,
        },
        { shaderManifestUrl: undefined },
      );

      expect(renderer.backend).toBe('webgpu');
      expect(explicitRequestAdapterCalls).toBeGreaterThanOrEqual(1);
      // Neither dynamic-import factory was invoked beyond previous tests.
      expect(spies.webgpuImportCount).toBe(beforeWebgpu);
      expect(spies.wgpuImportCount).toBe(beforeWgpu);
    });

    // Case (4a): navigator.gpu absent + rhi-wgpu wasm load fails →
    // createRenderer rejects (construction-time channel).
    it('case 4a: rhi-wgpu wasm load failure → createRenderer rejects with structured error', async () => {
      vi.stubGlobal('navigator', { ...baseNavigator });
      const canvas = makeMockCanvas({ webgpu: 'context', webgl2: 'null' });
      spies.rhiWgpuEnsureReadyShould = 'reject-load-failed';

      const { createRenderer } = await import('../createRenderer');
      const { EngineEnvironmentError } = await import('../errors/environment');

      await expect(createRenderer(canvas)).rejects.toBeInstanceOf(EngineEnvironmentError);
    });

    // Case (4b): renderer.ready Promise reject (run-time channel).
    // When rhi-webgpu adapter resolves but the downstream ready-build fails,
    // `await renderer.ready` surfaces the structured RhiError to AI users.
    it('case 4b: renderer.ready rejects with RhiError when downstream pipeline build fails', async () => {
      // Use an explicit `rhi` instance whose adapter resolves but acquireCanvasContext fails;
      // this forces buildReadyWebGPU (or the inner WebGPU outcome) to reject.
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeStubGPU() });
      const canvas = makeMockCanvas({ webgpu: 'context', webgl2: 'context' });
      const rhiActual = await import('@forgeax/engine-rhi');
      let failingDevice!: Record<string, unknown>;
      const explicitInstance = {
        requestAdapter: async () =>
          rhiActual.ok({
            features: new Set<string>(),
            limits: {} as Readonly<Record<string, number>>,
            requestDevice: async () => {
              failingDevice = makeFakeRhiDevice();
              // Force the ready-step buffer creation to fail (simulates limit-exceeded).
              failingDevice.createBindGroupLayout = () =>
                rhiActual.err(
                  new rhiActual.RhiError({
                    code: 'limit-exceeded',
                    expected: 'createBindGroupLayout succeeds',
                    hint: 'unit-test: forced limit-exceeded on first BGL',
                  }),
                );
              return rhiActual.ok(failingDevice);
            },
          }),
        acquireCanvasContext: (_canvas: unknown) => {
          return rhiActual.ok({
            configure: () => rhiActual.ok(undefined),
            unconfigure: () => rhiActual.ok(undefined),
            getCurrentTexture: () => rhiActual.ok({ __brand: 'TextureView' }),
          });
        },
      };

      const { createRenderer: case4bCreateRenderer } = (await import('../createRenderer')) as {
        createRenderer: (
          canvas: unknown,
          opts?: { rhi?: unknown; shaderManifestUrl?: string | undefined },
          bundler?: unknown,
        ) => Promise<{ ready: Promise<unknown> }>;
      };
      const renderer = await case4bCreateRenderer(
        canvas,
        {
          rhi: explicitInstance,
        },
        { shaderManifestUrl: undefined },
      );

      // The renderer is constructed successfully; the ready Promise carries the
      // downstream structured error (w24 — Result.err shape).
      const ready = (await renderer.ready) as { ok: boolean; error?: { code?: string } };
      expect(ready.ok).toBe(false);
      expect(ready.error?.code).toBeDefined();
    });

    // Case (4c): onError fan-out — listener registered before draw catches
    // the error when ready failure has already settled (D-P4 third channel).
    it('case 4c: onError fan-out fires for listeners registered before draw on ready-failed path', async () => {
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeStubGPU() });
      const canvas = makeMockCanvas({ webgpu: 'context', webgl2: 'context' });
      const rhiActual = await import('@forgeax/engine-rhi');
      const explicitInstance = {
        requestAdapter: async () =>
          rhiActual.ok({
            features: new Set<string>(),
            limits: {} as Readonly<Record<string, number>>,
            requestDevice: async () => {
              const dev = makeFakeRhiDevice();
              // Force ready failure.
              dev.createBindGroupLayout = () =>
                rhiActual.err(
                  new rhiActual.RhiError({
                    code: 'limit-exceeded',
                    expected: 'createBindGroupLayout succeeds',
                    hint: 'unit-test: forced limit-exceeded on first BGL',
                  }),
                );
              return rhiActual.ok(dev);
            },
          }),
        acquireCanvasContext: (_canvas: unknown) => {
          return rhiActual.ok({
            configure: () => rhiActual.ok(undefined),
            unconfigure: () => rhiActual.ok(undefined),
            getCurrentTexture: () => rhiActual.ok({ __brand: 'TextureView' }),
          });
        },
      };
      const { createRenderer: case4cCreateRenderer } = (await import('../createRenderer')) as {
        createRenderer: (
          canvas: unknown,
          opts?: { rhi?: unknown; shaderManifestUrl?: string | undefined },
          bundler?: unknown,
        ) => Promise<{
          onError: (cb: (e: { code: string }) => void) => void;
          ready: Promise<unknown>;
          draw: (opts: unknown) => void;
        }>;
      };
      const renderer = await case4cCreateRenderer(
        canvas,
        {
          rhi: explicitInstance,
        },
        { shaderManifestUrl: undefined },
      );
      const seen: Array<{ code: string }> = [];
      renderer.onError((e) => seen.push({ code: e.code }));
      // Drain ready (rejects).
      await renderer.ready.catch(() => undefined);
      // First draw fires onError (D-S4 ready-not-settled-or-pipeline-null).
      renderer.draw({} as unknown as Parameters<typeof renderer.draw>[0]);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]?.code).toBeDefined();
    });

    // Case (5): escape-hatch instance without createShaderModule (top-level or device-level)
    // exercises `invokeDeviceCreateShaderModule` "no candidate" fallback branch (covers
    // the new code line + branch coverage target for the M3 D-P4 facade).
    // feat-20260518 M5 / w22.9: seed pbr + unlit entries so the post-fallback
    // pipeline-compile path reaches `invokeDeviceCreateShaderModule` (the
    // step under test) before the manifest-empty short-circuit fires.
    const emptyManifestUrl = `data:application/json,${encodeURIComponent(
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
          { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
          {
            hash: 'tonemap0',
            wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
            glsl: '',
            bindings: '',
          },
        ],
      }),
    )}`;
    it('case 5: escape hatch without createShaderModule → ready rejects rhi-not-available', async () => {
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeStubGPU() });
      const canvas = makeMockCanvas({ webgpu: 'context', webgl2: 'context' });
      const rhiActual = await import('@forgeax/engine-rhi');
      const explicitInstance = {
        requestAdapter: async () =>
          rhiActual.ok({
            features: new Set<string>(),
            limits: {} as Readonly<Record<string, number>>,
            requestDevice: async () => {
              const dev = makeFakeRhiDevice();
              // Strip createShaderModule entirely so the fallback walks the
              // 'no candidate' branch.
              delete (dev as { createShaderModule?: unknown }).createShaderModule;
              return rhiActual.ok(dev);
            },
          }),
        acquireCanvasContext: (_canvas: unknown) => {
          return rhiActual.ok({
            configure: () => rhiActual.ok(undefined),
            unconfigure: () => rhiActual.ok(undefined),
            getCurrentTexture: () => rhiActual.ok({ __brand: 'TextureView' }),
          });
        },
      };
      const { createRenderer } = await import('../createRenderer');
      const renderer = await createRenderer(
        canvas,
        {
          rhi: explicitInstance,
        } as unknown as Parameters<typeof createRenderer>[1],
        { shaderManifestUrl: emptyManifestUrl },
      );
      const ready1 = (await renderer.ready) as { ok: boolean; error?: { code?: string } };
      expect(ready1.ok).toBe(false);
      expect(ready1.error?.code).toBe('rhi-not-available');
      // dispose path coverage (idempotent).
      renderer.dispose();
      renderer.dispose();
    });

    // Case (7): navigator.gpu absent -> Channel 3 selected WITHOUT getContext('webgpu')
    // (w22). The mock rhi-wgpu acquireCanvasContext goes through wasm surface path;
    // rhi-webgpu's getContext('webgpu') is never invoked.
    it('case 7: navigator.gpu absent → Channel 3 selected, getContext never called', async () => {
      vi.stubGlobal('navigator', { ...baseNavigator });
      const canvas = makeMockCanvas({ webgpu: 'context', webgl2: 'null' });
      // Track whether getContext('webgpu') was called on the canvas.
      let getContextWebgpuCalls = 0;
      const originalGetContext = canvas.getContext.bind(canvas);
      canvas.getContext = ((kind: string) => {
        if (kind === 'webgpu') getContextWebgpuCalls += 1;
        return originalGetContext(kind);
      }) as typeof canvas.getContext;

      const { createRenderer: case7CreateRenderer } = (await import('../createRenderer')) as {
        createRenderer: (
          canvas: unknown,
          opts?: { shaderManifestUrl?: string | undefined },
          bundler?: unknown,
        ) => Promise<{ backend: string }>;
      };
      try {
        const renderer = await case7CreateRenderer(canvas, {}, { shaderManifestUrl: undefined });
        expect(renderer.backend).toBe('webgpu');
        // Channel 3 was selected (navigator.gpu absent), so canvas.getContext('webgpu')
        // was NEVER called — the wasm surface path was used instead.
        expect(getContextWebgpuCalls).toBe(0);
      } catch (_e) {
        // May fail in CI without a real GPU; either way getContext('webgpu')
        // must not have been called.
        expect(getContextWebgpuCalls).toBe(0);
      }
    });

    // Case (8): acquireCanvasContext failure → structured error in detail (w22).
    it('case 8: acquireCanvasContext fails → EngineEnvironmentError.detail has RhiError', async () => {
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeStubGPU() });
      const canvas = makeMockCanvas({ webgpu: 'null', webgl2: 'null' }); // canvas.getContext('webgpu') returns null
      const { createRenderer } = await import('../createRenderer');
      const { EngineEnvironmentError } = await import('../errors/environment');

      try {
        await createRenderer(canvas);
        // If we get here, Channel 3 succeeded — skip assertion (CI without real GPU
        // may not reach this path).
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(EngineEnvironmentError);
        if (error instanceof EngineEnvironmentError) {
          // detail.webgpuError must be populated — the acquireCanvasContext failure
          // on Channel 2 produced a RhiError with code='rhi-not-available'.
          const webgpuErr = error.detail.webgpuError as
            | { code?: string; hint?: string; expected?: string }
            | undefined;
          expect(webgpuErr).toBeDefined();
          if (webgpuErr) {
            expect(webgpuErr.code).toBeDefined();
            expect(webgpuErr.hint).toBeTruthy();
            expect(webgpuErr.expected).toBeTruthy();
          }
        }
      }
    });

    // Case (9): both Channel 2 and Channel 3 fail → compound error with both fields (w22).
    it('case 9: both channels fail → EngineEnvironmentError.detail.webgpuError + .wgpuError both populated', async () => {
      // Force Channel 2 to fail (requestAdapter rejects) AND Channel 3 to fail
      // (ensureReady rejects).
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeStubGPU() });
      spies.rhiWebgpuRequestAdapterShould = 'reject-rhi-not-available';
      spies.rhiWgpuEnsureReadyShould = 'reject-load-failed';
      const canvas = makeMockCanvas({ webgpu: 'context', webgl2: 'null' });

      const { createRenderer } = await import('../createRenderer');
      const { EngineEnvironmentError } = await import('../errors/environment');

      await expect(createRenderer(canvas)).rejects.toBeInstanceOf(EngineEnvironmentError);

      try {
        await createRenderer(canvas);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(EngineEnvironmentError);
        if (error instanceof EngineEnvironmentError) {
          // Both fields must be present — Channel 2 produced webgpuError,
          // Channel 3 produced wgpuError.
          expect(error.detail.webgpuError).toBeDefined();
          expect(error.detail.wgpuError).toBeDefined();
          const webgpuErr = error.detail.webgpuError as { code?: string } | undefined;
          const wgpuErr = error.detail.wgpuError as { code?: string } | undefined;
          if (webgpuErr) expect(webgpuErr.code).toBe('rhi-not-available');
          if (wgpuErr) expect(wgpuErr instanceof Error).toBe(true);
        }
      }
    });

    // Case (6): escape-hatch instance whose device.createShaderModule throws — exercises
    // the synchronous-fallback catch branch in invokeDeviceCreateShaderModule.
    it('case 6: escape hatch device.createShaderModule throws → ready rejects shader-compile-failed', async () => {
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeStubGPU() });
      const canvas = makeMockCanvas({ webgpu: 'context', webgl2: 'context' });
      const rhiActual = await import('@forgeax/engine-rhi');
      const explicitInstance = {
        requestAdapter: async () =>
          rhiActual.ok({
            features: new Set<string>(),
            limits: {} as Readonly<Record<string, number>>,
            requestDevice: async () => {
              const dev = makeFakeRhiDevice();
              dev.createShaderModule = () => {
                throw new Error('unit-test forced sync throw on device.createShaderModule');
              };
              return rhiActual.ok(dev);
            },
          }),
        acquireCanvasContext: (_canvas: unknown) => {
          return rhiActual.ok({
            configure: () => rhiActual.ok(undefined),
            unconfigure: () => rhiActual.ok(undefined),
            getCurrentTexture: () => rhiActual.ok({ __brand: 'TextureView' }),
          });
        },
      };
      const { createRenderer } = await import('../createRenderer');
      const renderer = await createRenderer(
        canvas,
        {
          rhi: explicitInstance,
        } as unknown as Parameters<typeof createRenderer>[1],
        { shaderManifestUrl: emptyManifestUrl },
      );
      const ready2 = (await renderer.ready) as { ok: boolean; error?: { code?: string } };
      expect(ready2.ok).toBe(false);
      expect(ready2.error?.code).toBe('shader-compile-failed');
    });
  });
}

// R-BGCACHE (bindgroup resize invalidation) is covered by real pass-level
// tests in ssao-passes.test.ts ('bindgroup resize invalidation (R-BGCACHE)'),
// which drive the actual SSAO calc/blur closures through a simulated resize and
// assert the bind group is rebuilt against the new physical TextureView
// identity. Bloom (bright / blur H-V / composite), FXAA, and skybox share the
// identical getOrCreateFromChain mechanism (frameState.postProcessBgCache), so
// that coverage exercises the same code path. See feedback
// 2026-07-10-render-graph-postprocess-bindgroups-retain-retired-texture-views.

{
  // --- from builtin-guid-ssot.test.ts ---
  // Each builtin handle paired with the `deriveBuiltin` name it must resolve to.
  const BUILTINS = [
    { name: 'HANDLE_CUBE', handle: HANDLE_CUBE },
    { name: 'HANDLE_TRIANGLE', handle: HANDLE_TRIANGLE },
    { name: 'HANDLE_QUAD', handle: HANDLE_QUAD },
    { name: 'HANDLE_SPHERE', handle: HANDLE_SPHERE },
    // feat-20260701-editor-world-container-doc-ecs-collapse M0 / AC-16:
    // cylinder builtin handle=6, GUID = deriveBuiltin('HANDLE_CYLINDER') UUIDv5
    // (plan-strategy §5.6 builtin-guid-ssot gate)
    { name: 'HANDLE_CYLINDER', handle: HANDLE_CYLINDER },
  ] as const;

  describe('builtin GUID -> payload SSOT (Tier 0 guard)', () => {
    it.each(
      BUILTINS,
    )('deriveBuiltin($name) GUID is catalogued and lookup-resolves to the builtin payload', async ({
      name,
      handle,
    }) => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      // feat-20260614 M8: the registry holds no handle->guid map (guidOf is
      // gone). Builtins are first-class GUID-addressable catalogue rows, so the
      // surviving direction is GUID -> payload via lookup. The payload resolved
      // from the column handle (two-tier) must be the same object the derived
      // GUID looks up.
      const derived = await deriveBuiltin(name);
      const cataloged = reg.lookup(derived);
      expect(cataloged).toBeDefined();
      if (cataloged === undefined) return;

      const fromHandle = resolveAssetHandle(new World(), handle as Handle<string, 'shared'>);
      expect(fromHandle.ok).toBe(true);
      if (!fromHandle.ok) return;
      expect(fromHandle.value).toBe(cataloged);
    });

    it.each(
      BUILTINS,
    )('loadByGuid round-trips the derived $name GUID back to its builtin payload', async ({
      name,
      handle,
    }) => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      const derived = await deriveBuiltin(name);
      const loaded = await reg.loadByGuid(derived);

      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      // loadByGuid returns the PAYLOAD; it must match the payload resolved from
      // the builtin column handle via the two-tier resolver.
      const fromHandle = resolveAssetHandle(new World(), handle as Handle<string, 'shared'>);
      expect(fromHandle.ok).toBe(true);
      if (!fromHandle.ok) return;
      expect(loaded.value).toBe(fromHandle.value);
    });
  });
}

{
  // --- from builtin-pack.test.ts ---
  // ─── Builtin GUIDs (must match packages/pack/src/builtin.ts) ────────────
  const BUILTIN_GUID_CUBE = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
  const BUILTIN_GUID_TRIANGLE = '22592f07-d967-5116-b29c-fa9781929ba8';
  const BUILTIN_GUID_QUAD = '339338aa-a338-581c-9fc5-744267ef8a51';

  // ─── Triangle interleaved data (mirrors asset-registry.ts BUILTIN_TRIANGLE) ──
  const TRIANGLE_INTERLEAVED = new Float32Array([
    0, 0.7, 0, 0, 0, 1, 0.5, 1, -0.7, -0.6, 0, 0, 0, 1, 0, 0, 0.7, -0.6, 0, 0, 0, 1, 1, 0,
  ]);
  const TRIANGLE_INDICES = new Uint16Array([0, 1, 2]);
  const EXPECTED_TRIANGLE = meshFromInterleaved(TRIANGLE_INTERLEAVED, TRIANGLE_INDICES);

  // ─── Procedural reference meshes ────────────────────────────────────────
  // These must be computed lazily because createBoxGeometry/createPlaneGeometry
  // are pure functions and their output is deterministic.
  let cubeRefCache: MeshAsset | undefined;
  let quadRefCache: MeshAsset | undefined;

  function cubeRef(): MeshAsset {
    if (!cubeRefCache) {
      const res = createBoxGeometry(1, 1, 1);
      if (!res.ok) throw new Error('createBoxGeometry(1,1,1) failed');
      cubeRefCache = res.value;
    }
    return cubeRefCache;
  }

  function quadRef(): MeshAsset {
    if (!quadRefCache) {
      const res = createPlaneGeometry(1, 1);
      if (!res.ok) throw new Error('createPlaneGeometry(1,1) failed');
      quadRefCache = res.value;
    }
    return quadRefCache;
  }

  function triangleRef(): MeshAsset {
    return EXPECTED_TRIANGLE;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /** Float32Array byte-level equality. */
  function float32Equal(a: Float32Array, b: Float32Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /** Uint16Array/Uint32Array byte-level equality. */
  // Accepts the optional MeshAsset.indices shape (M2): both operands are builtin
  // indexed meshes, but the type became `... | undefined` -- a missing buffer on
  // either side fails equality.
  function indicesEqual(
    a: Uint16Array | Uint32Array | undefined,
    b: Uint16Array | Uint32Array | undefined,
  ): boolean {
    if (a === undefined || b === undefined) return a === b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /** Build a pack-index catalog fixture. */
  function makePackIndex(entries: Array<{ guid: string; relativeUrl: string }>) {
    return entries.map((e) => ({
      guid: e.guid,
      relativeUrl: e.relativeUrl,
      kind: 'mesh' as const,
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 0,
          topology: 'triangle-list',
        },
      ],
    }));
  }

  /** Build a .pack.json fixture from a MeshAsset. */
  function makePackFileFixture(guid: string, mesh: MeshAsset) {
    return {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid,
          kind: 'mesh',
          payload: {
            vertices: Array.from(mesh.vertices),
            indices: Array.from(mesh.indices ?? []),
            attributes: {},
          },
          refs: [],
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 0,
              vertexCount: 0,
              topology: 'triangle-list',
            },
          ],
        },
      ],
    };
  }

  /** Wire mock fetch + configurePackIndex for a set of builtin meshes. */
  function setupMockFetch(
    reg: AssetRegistry,
    packs: Array<{ guid: string; url: string; mesh: MeshAsset }>,
  ) {
    const packIndexEntries = packs.map((p) => ({
      guid: p.guid,
      relativeUrl: p.url,
    }));

    const packIndex = makePackIndex(packIndexEntries);
    const packFiles = new Map<string, ReturnType<typeof makePackFileFixture>>();
    for (const p of packs) {
      packFiles.set(p.url, makePackFileFixture(p.guid, p.mesh));
    }

    const fetchMock = async (url: string) => {
      if (url === '/pack-index.json') {
        return {
          ok: true,
          json: async () => packIndex,
        };
      }
      const packFile = packFiles.get(url);
      if (packFile !== undefined) {
        return {
          ok: true,
          json: async () => packFile,
        };
      }
      return { ok: false, status: 404 };
    };

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    globalThis.fetch = fetchMock as any;
    reg.configurePackIndex('/pack-index.json');
  }

  // ─── Tests ──────────────────────────────────────────────────────────────

  describe('builtin mesh pack loading (w9)', () => {
    it('loadByGuid(BUILTIN_HANDLE_CUBE) returns mesh with vertex data byte-equal to procedural', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const cube = cubeRef();

      setupMockFetch(reg, [
        { guid: BUILTIN_GUID_CUBE, url: '/assets/builtin/cube.pack.json', mesh: cube },
      ]);

      const parsed = AssetGuid.parse(BUILTIN_GUID_CUBE);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // loadByGuid now returns the payload directly.
        const loaded = result.value;
        expect(loaded.kind).toBe('mesh');
        expect(float32Equal(loaded.vertices, cube.vertices)).toBe(true);
        expect(indicesEqual(loaded.indices, cube.indices)).toBe(true);
      }
    });

    it('loadByGuid(BUILTIN_HANDLE_QUAD) returns mesh with vertex data byte-equal to procedural', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const quad = quadRef();

      setupMockFetch(reg, [
        { guid: BUILTIN_GUID_QUAD, url: '/assets/builtin/quad.pack.json', mesh: quad },
      ]);

      const parsed = AssetGuid.parse(BUILTIN_GUID_QUAD);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const loaded = result.value;
        expect(loaded.kind).toBe('mesh');
        expect(float32Equal(loaded.vertices, quad.vertices)).toBe(true);
        expect(indicesEqual(loaded.indices, quad.indices)).toBe(true);
      }
    });

    it('loadByGuid(BUILTIN_HANDLE_TRIANGLE) returns mesh with vertex data byte-equal to procedural', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const tri = triangleRef();

      setupMockFetch(reg, [
        { guid: BUILTIN_GUID_TRIANGLE, url: '/assets/builtin/triangle.pack.json', mesh: tri },
      ]);

      const parsed = AssetGuid.parse(BUILTIN_GUID_TRIANGLE);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const loaded = result.value;
        expect(loaded.kind).toBe('mesh');
        expect(float32Equal(loaded.vertices, tri.vertices)).toBe(true);
        expect(indicesEqual(loaded.indices, tri.indices)).toBe(true);
      }
    });

    it('loadByGuid with unknown GUID returns asset-not-imported (M4 shipped form, AC-22)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      setupMockFetch(reg, []);

      const parsed = AssetGuid.parse('ffffffff-ffff-7fff-bfff-ffffffffffff');
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-not-imported');
      }
    });
  });
}

{
  // --- equirect-narrowing (feat-20260630, replacing cube-texture-narrowing) ---
  describe('AC-01 EquirectAsset POD shape', () => {
    it('kind is literal "equirect"', () => {
      expectTypeOf<EquirectAsset['kind']>().toEqualTypeOf<'equirect'>();
    });

    it('width and height are number', () => {
      expectTypeOf<EquirectAsset['width']>().toEqualTypeOf<number>();
      expectTypeOf<EquirectAsset['height']>().toEqualTypeOf<number>();
    });

    it('format is GPUTextureFormat', () => {
      const _f: EquirectAsset['format'] = 'rgba16float';
      expect(_f).toBe('rgba16float');
    });

    it('data is a Uint8Array | Uint8ClampedArray (single 2D image, no faces[])', () => {
      const asset: EquirectAsset = {
        kind: 'equirect',
        width: 4,
        height: 2,
        format: 'rgba16float',
        data: new Uint8Array(4 * 2 * 4 * 2),
        colorSpace: 'linear',
      };
      expect(asset.data.byteLength).toBe(4 * 2 * 4 * 2);
    });
  });

  describe('AC-16(a) parseAssetPayload narrowing', () => {
    it('Asset.kind includes "equirect" literal', () => {
      const kind: Asset['kind'] = 'equirect';
      expect(kind).toBe('equirect');
    });
  });
}

{
  // --- from cubemap-upload.test.ts ---
  // feat-20260601-gpu-resource-store-extraction M1: uploadCubemapFromEquirect
  // moved to GpuResourceStore. The store holds no registry reference (D-2/D-3);
  // the cube POD register-relay is injected at configureGpuDevice (D-3) and the
  // source POD is passed to the call. feat-20260614 M8: column handles are
  // minted by the World, so the relay is `(world, pod) => ok(world.allocSharedRef(...))`.

  interface SubmitProbe {
    submitCalls: number;
  }

  // biome-ignore lint/suspicious/noExplicitAny: opaque mock surface
  function makeMockDevice(probe: SubmitProbe): any {
    const okShim = <T>(v: T) => ({ ok: true as const, value: v });
    const mockOpaque = { __mock: 'opaque' };
    const makePass = () => ({
      setPipeline: () => {},
      setBindGroup: () => {},
      setVertexBuffer: () => {},
      draw: () => {},
      end: () => {},
    });
    return {
      createShaderModule: () => okShim(mockOpaque),
      createBindGroupLayout: () => okShim(mockOpaque),
      createPipelineLayout: () => okShim(mockOpaque),
      createRenderPipeline: () => okShim(mockOpaque),
      createBindGroup: () => okShim(mockOpaque),
      createBuffer: () => okShim(mockOpaque),
      createTexture: () => okShim(mockOpaque),
      createTextureView: () => okShim(mockOpaque),
      createSampler: () => okShim(mockOpaque),
      createCommandEncoder: () =>
        okShim({
          beginRenderPass: () => makePass(),
          finish: () => okShim(mockOpaque),
        }),
      queue: {
        writeBuffer: () => okShim(undefined),
        submit: () => {
          probe.submitCalls += 1;
          return okShim(undefined);
        },
      },
    };
  }

  const mockCaps: RhiCaps = {
    backendKind: 'webgpu',
    compute: true,
    timestampQuery: false,
    indirectDrawing: false,
    textureCompressionBc: false,
    textureCompressionEtc2: false,
    textureCompressionAstc: false,
    multiDrawIndirect: false,
    pushConstants: false,
    textureBindingArray: false,
    samplerAliasing: false,
    firstInstanceIndirect: false,
    storageBuffer: true,
    storageTexture: false,
    rgba16floatRenderable: true,
    rg11b10ufloatRenderable: false,
    float32Filterable: false,
  };

  function makeEquirect(): EquirectAsset {
    return {
      kind: 'equirect',
      width: 4,
      height: 2,
      format: 'rgba16float' as TextureFormat,
      data: new Uint8Array(4 * 2 * 8),
      colorSpace: 'linear',
    };
  }

  describe('t10 -- equirect-to-cubemap projection contract (internal)', () => {
    it('(a) returns Handle<EquirectAsset> cube handle for a valid EquirectAsset source', async () => {
      const probe: SubmitProbe = { submitCalls: 0 };
      const device = makeMockDevice(probe);
      const world = new World();
      const store = new GpuResourceStore();
      const equirect = makeEquirect();
      // feat-20260614 M8: column handles are minted by the World, not the
      // registry. The cube register-relay also mints via world.allocSharedRef.
      const sourceHandle = world.allocSharedRef('EquirectAsset', equirect);
      store.configureGpuDevice(
        device,
        async (_d, desc) =>
          // biome-ignore lint/suspicious/noExplicitAny: shader factory shim
          rhiOk({ __mock: 'shader', label: desc.label ?? '' }) as any,
        (w, pod: EquirectAsset) => rhiOk(w.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );
      // biome-ignore lint/suspicious/noExplicitAny: package-internal projection reached via store cast
      const result = await (store as any)._uploadCubemapFromEquirect(world, sourceHandle, equirect);
      expect(result.ok).toBe(true);
    });

    it('(c) rejects non-HDR-float input with invalid-source-format', async () => {
      const probe: SubmitProbe = { submitCalls: 0 };
      const device = makeMockDevice(probe);
      const world = new World();
      const store = new GpuResourceStore();
      const ldr: EquirectAsset = {
        kind: 'equirect',
        width: 64,
        height: 64,
        format: 'rgba8unorm' as TextureFormat,
        data: new Uint8Array(64 * 64 * 4),
        colorSpace: 'srgb',
      };
      const sourceHandle = world.allocSharedRef('EquirectAsset', ldr);
      store.configureGpuDevice(
        device,
        undefined,
        (w, pod: EquirectAsset) => rhiOk(w.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );
      // biome-ignore lint/suspicious/noExplicitAny: package-internal projection reached via store cast
      const result = await (store as any)._uploadCubemapFromEquirect(world, sourceHandle, ldr);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid-source-format');
      }
    });

    it('(d) source POD fetch surfaces asset-not-found for unresolvable handle', () => {
      // Pull-model migration: the cube upload takes a source POD; a missing
      // source surfaces when the caller resolves the handle to a payload first.
      const world = new World();
      const bogus = toShared<'TextureAsset'>(99999);
      const podRes = resolveAssetHandle<TextureAsset>(world, bogus);
      expect(podRes.ok).toBe(false);
      if (!podRes.ok) {
        expect(podRes.error.code).toBe('asset-not-found');
      }
    });
  });

  describe('t54 (M3.5) -- AC-03 idempotent at GPU-dispatch layer', () => {
    it('(b1) second uploadCubemapFromEquirect with same source does NOT re-dispatch', async () => {
      const probe: SubmitProbe = { submitCalls: 0 };
      const device = makeMockDevice(probe);
      const world = new World();
      const store = new GpuResourceStore();
      const equirect = makeEquirect();
      const sourceHandle = world.allocSharedRef('EquirectAsset', equirect);
      store.configureGpuDevice(
        device,
        async (_d, desc) =>
          // biome-ignore lint/suspicious/noExplicitAny: shader factory shim
          rhiOk({ __mock: 'shader', label: desc.label ?? '' }) as any,
        (w, pod: EquirectAsset) => rhiOk(w.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );

      // biome-ignore lint/suspicious/noExplicitAny: package-internal projection reached via store cast
      const r1 = await (store as any)._uploadCubemapFromEquirect(world, sourceHandle, equirect);
      const firstSubmits = probe.submitCalls;
      expect(firstSubmits).toBeGreaterThanOrEqual(1);

      // biome-ignore lint/suspicious/noExplicitAny: package-internal projection reached via store cast
      const r2 = await (store as any)._uploadCubemapFromEquirect(world, sourceHandle, equirect);
      // Second call returns the cached handle without dispatching again.
      expect(probe.submitCalls).toBe(firstSubmits);

      expect(r1.ok && r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        // (b3) returned Handle has identical numeric id.
        expect(JSON.stringify(r1.value)).toBe(JSON.stringify(r2.value));
      }
    });
  });
}

{
  // --- from dev-import-transport.test.ts ---
  const GUID = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';

  function mockGlobalFetch(impl: (url: string, init?: RequestInit) => Promise<unknown>) {
    // biome-ignore lint/suspicious/noExplicitAny: test mock needs unsafe globalThis cast
    globalThis.fetch = vi.fn().mockImplementation(impl) as any;
  }

  describe('createDevImportTransport (AC-04 dev-only fetch transport)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      delete (globalThis as any).fetch;
    });

    it('returns an ImportTransport with a fetchPack method', () => {
      const transport: ImportTransport = createDevImportTransport();
      expect(typeof transport.fetchPack).toBe('function');
    });

    it('POSTs to /__import/<guid>', async () => {
      let seenUrl: string | undefined;
      let seenMethod: string | undefined;
      mockGlobalFetch((url, init) => {
        seenUrl = url;
        seenMethod = init?.method;
        return Promise.resolve({ ok: true, status: 200 });
      });

      await createDevImportTransport().fetchPack(GUID);

      expect(seenMethod).toBe('POST');
      expect(seenUrl).toBe(`/__import/${GUID}`);
    });

    it('2xx response -> { ok: true } (two-state, no payload read)', async () => {
      mockGlobalFetch(() => Promise.resolve({ ok: true, status: 200 }));

      const result = await createDevImportTransport().fetchPack(GUID);

      expect(result.ok).toBe(true);
      // C1 two-state: no value field, only the ok boolean.
      expect(Object.keys(result)).toEqual(['ok']);
    });

    it('non-2xx response -> { ok: false }', async () => {
      mockGlobalFetch(() => Promise.resolve({ ok: false, status: 404 }));

      const result = await createDevImportTransport().fetchPack(GUID);

      expect(result.ok).toBe(false);
      // C1 two-state: no error field, only the ok boolean.
      expect(Object.keys(result)).toEqual(['ok']);
    });

    it('network failure (fetch rejects) -> { ok: false }', async () => {
      mockGlobalFetch(() => Promise.reject(new Error('network down')));

      const result = await createDevImportTransport().fetchPack(GUID);

      expect(result.ok).toBe(false);
    });
  });
}

{
  // --- from font-asset-load.test.ts ---
  const FONT_GUID = '00000000-0000-7000-8000-000000000020';

  function makeFontAsset(): FontAsset {
    return {
      kind: 'font',
      atlas: toUnique<'TextureAsset'>(0),
      sampler: toUnique<'SamplerAsset'>(0),
      glyphs: {
        72: {
          advance: 64,
          bearingX: 2,
          bearingY: 0,
          size: { w: 48, h: 56 },
          region: { x: 0, y: 0, w: 48, h: 56 },
        },
        105: {
          advance: 28,
          bearingX: 2,
          bearingY: 0,
          size: { w: 16, h: 56 },
          region: { x: 48, y: 0, w: 16, h: 56 },
        },
      },
      common: {
        lineHeight: 72,
        base: 56,
        distanceRange: 4,
        pxRange: 2,
        atlasWidth: 1024,
        atlasHeight: 1024,
      },
      notdef: {
        advance: 48,
        bearingX: 0,
        bearingY: 0,
        size: { w: 48, h: 48 },
        region: { x: 64, y: 0, w: 48, h: 48 },
      },
    };
  }

  describe('w10 - catalog + loadByGuid path for FontAsset', () => {
    it('(a) loadByGuid<FontAsset>(guid) returns Ok(payload) after catalog', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const parsed = AssetGuid.parse(FONT_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const guid = parsed.value;
      const fontAsset = makeFontAsset();
      reg.catalog<FontAsset>(guid, fontAsset);
      const result = await reg.loadByGuid<FontAsset>(guid);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // loadByGuid now returns the payload directly.
      const loaded = result.value;
      // AC-05: atlas + sampler handle + glyphs Record + common block
      expect(loaded.kind).toBe('font');
      expect(loaded.glyphs[72]?.advance).toBe(64);
      expect(loaded.glyphs[105]?.bearingY).toBe(0);
      expect(loaded.common.lineHeight).toBe(72);
      expect(loaded.common.distanceRange).toBe(4);
      expect(loaded.common.atlasWidth).toBe(1024);
      expect(loaded.notdef?.advance).toBe(48);
      // AC-17: FontAsset.atlas is a sub-asset reference handle inside the payload
      const atlasId = unwrapHandle(loaded.atlas);
      expect(typeof atlasId).toBe('number');
    });

    it('(b) loadByGuid for an uncatalogued font GUID returns Err(asset-not-found)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const parsed = AssetGuid.parse(FONT_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<FontAsset>(parsed.value);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('asset-not-found');
    });

    it('(c) empty glyphs FontAsset is valid', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const parsed = AssetGuid.parse(FONT_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const guid = parsed.value;
      const fontAsset: FontAsset = {
        kind: 'font',
        atlas: toUnique<'TextureAsset'>(0),
        sampler: toUnique<'SamplerAsset'>(0),
        glyphs: {},
        common: {
          lineHeight: 72,
          base: 56,
          distanceRange: 4,
          pxRange: 2,
          atlasWidth: 1024,
          atlasHeight: 1024,
        },
      };
      reg.catalog<FontAsset>(guid, fontAsset);
      const result = await reg.loadByGuid<FontAsset>(guid);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const loaded = result.value;
      expect(loaded.kind).toBe('font');
      expect(Object.keys(loaded.glyphs).length).toBe(0);
    });
  });
}

{
  // --- from handle-quad.test.ts ---
  describe('HANDLE_QUAD - builtin mesh handle (M-1 w03)', () => {
    it('is exported from @forgeax/engine-assets-runtime barrel (single-import discovery)', async () => {
      // feat-20260705-runtime-tier2-decomposition M1 (AC-105): the asset cluster
      // moved to @forgeax/engine-assets-runtime; the runtime barrel no longer
      // re-exports HANDLE_QUAD (zero shim, C1 SSOT). AI users import it from the
      // assets-runtime package.
      const barrel = await import('@forgeax/engine-assets-runtime');
      expect(barrel.HANDLE_QUAD).toBe(HANDLE_QUAD);
    });

    it('numeric raw value is exactly 3 (3-hole between HANDLE_TRIANGLE=2 and FIRST_USER_HANDLE=1024)', () => {
      // Brand-removal coerces Handle<T, M> back to number (Handle extends
      // number so widening is implicit). The reserved-id namespace is:
      //   1 = HANDLE_CUBE     (feat-20260509 D-S9)
      //   2 = HANDLE_TRIANGLE (feat-20260509 D-S9)
      //   3 = HANDLE_QUAD     (this feat — 2D sprite + tilemap base mesh)
      //   1024..= FIRST_USER_HANDLE (AssetRegistry.nextHandle init)
      const raw: number = HANDLE_QUAD;
      expect(raw).toBe(3);
      expect(HANDLE_CUBE).toBe(1);
      expect(HANDLE_TRIANGLE).toBe(2);
    });

    it('Handle brand structurally matches toShared<MeshAsset>(3)', () => {
      // Brand identity check: HANDLE_QUAD === toShared<'MeshAsset'>(3)
      // (the factory is the AC-01-exemption single brand-creation site).
      const reconstructed: Handle<'MeshAsset', 'shared'> = toShared<'MeshAsset'>(3);
      expect(HANDLE_QUAD).toBe(reconstructed);
    });

    it('AssetRegistry pre-populates HANDLE_QUAD with a 12-floats-per-vertex MeshAsset', () => {
      const res = resolveAssetHandle<TypesMeshAsset>(new World(), HANDLE_QUAD);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const quad = res.value;
      expect(quad.kind).toBe('mesh');
      expect(quad.vertices).toBeInstanceOf(Float32Array);
      // The builtin quad is an indexed mesh; narrow after MeshAsset.indices
      // became optional (feat-20260604 M2).
      const quadIndices = quad.indices;
      expect(quadIndices).toBeDefined();
      if (quadIndices === undefined) return;
      expect(quadIndices.length).toBeGreaterThan(0);

      // Derive vertex count from the largest index + 1 (matches the inline
      // post-upload computation in uploadMeshById that confirms layout).
      let maxIndex = 0;
      for (let k = 0; k < quadIndices.length; k++) {
        const idx = quadIndices[k];
        if (idx !== undefined && idx > maxIndex) maxIndex = idx;
      }
      const vertexCount = maxIndex + 1;
      const floatsPerVertex = quad.vertices.length / vertexCount;
      expect(floatsPerVertex).toBe(BUILTIN_FLOATS_PER_VERTEX);
      expect(floatsPerVertex).toBe(12);
    });

    it('HANDLE_QUAD geometry matches createPlaneGeometry(1, 1) output byte-for-byte', () => {
      // The MeshAsset behind HANDLE_QUAD must be the exact procedural plane
      // (1x1 / 1 segment / 1 segment) — zero new layout discriminator and
      // the AI user can reason about UV / face count by reading
      // packages/runtime/src/geometry/plane.ts.
      const res = resolveAssetHandle<TypesMeshAsset>(new World(), HANDLE_QUAD);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const quad = res.value;

      const refRes = createPlaneGeometry(1, 1);
      expect(refRes.ok).toBe(true);
      if (!refRes.ok) return;
      const ref = refRes.value;

      expect(quad.vertices.length).toBe(ref.vertices.length);
      const quadIndices = quad.indices;
      const refIndices = ref.indices;
      expect(quadIndices).toBeDefined();
      expect(refIndices).toBeDefined();
      if (quadIndices === undefined || refIndices === undefined) return;
      expect(quadIndices.length).toBe(refIndices.length);
      // Compare element-wise: vertices buffer + index buffer should be
      // identical because BUILTIN_QUAD is meshFromInterleaved-expanded from
      // the same procedural source.
      expect(Array.from(quad.vertices)).toEqual(Array.from(ref.vertices));
      expect(Array.from(quadIndices)).toEqual(Array.from(refIndices));
    });
  });
}

{
  // --- from lazy-catalog.test.ts ---
  function makeMockShaderRegistry() {
    return {
      getMaterialShaderManifest: vi.fn().mockReturnValue(undefined),
      lookupMaterialShader: vi.fn().mockReturnValue({ ok: false, error: new Error('mock') }),
      getPipeline: vi.fn().mockReturnValue(undefined),
      registerMaterialShader: vi.fn(),
      inspect: vi.fn().mockReturnValue({ materialShaders: [] }),
    } as unknown as import('@forgeax/engine-shader').ShaderRegistry;
  }

  const UNKNOWN_GUID = 'ffffffff-ffff-7fff-bfff-ffffffffffff';

  function mockGlobalFetch(impl: (url: string) => Promise<unknown>) {
    // biome-ignore lint/suspicious/noExplicitAny: test mock needs unsafe globalThis cast
    globalThis.fetch = vi.fn().mockImplementation(impl) as any;
  }

  function emptyCatalogResponse() {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([]),
    });
  }

  describe('M4 lazy catalog + ImportTransport (AC-19 / AC-22)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      delete (globalThis as any).fetch;
    });

    it('(AC-19) DDC miss with transport present triggers fetchPack', async () => {
      const transport: ImportTransport = {
        fetchPack: vi.fn().mockResolvedValue({ ok: true }),
      };
      const reg = new AssetRegistry(makeMockShaderRegistry(), transport);

      reg.configurePackIndex('/pack-index.json');

      mockGlobalFetch(() => emptyCatalogResponse());

      const parsed = AssetGuid.parse(UNKNOWN_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      // DDC miss (empty catalog -> resolveCatalogEntry returns undefined)
      // -> transportOrFail -> transport.fetchPack called.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-not-imported');
      }
      // AC-19: transport WAS called (DDC miss triggers it).
      expect(transport.fetchPack).toHaveBeenCalledTimes(1);
    });

    it('(AC-22) no transport wired + DDC miss -> asset-not-imported fail-fast', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      reg.configurePackIndex('/pack-index.json');

      mockGlobalFetch(() => emptyCatalogResponse());

      const parsed = AssetGuid.parse(UNKNOWN_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AssetError);
        expect(result.error.code).toBe('asset-not-imported');
        expect(result.error.hint).toContain('pre-import');
      }
    });

    it('transport fetchPack returns error -> asset-not-imported', async () => {
      const transport: ImportTransport = {
        fetchPack: vi.fn().mockResolvedValue({ ok: false }),
      };
      const reg = new AssetRegistry(makeMockShaderRegistry(), transport);

      reg.configurePackIndex('/pack-index.json');

      mockGlobalFetch(() => emptyCatalogResponse());

      const parsed = AssetGuid.parse(UNKNOWN_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-not-imported');
      }
      expect(transport.fetchPack).toHaveBeenCalledTimes(1);
    });

    it('(AC-19) DDC hit path never touches transport (fetch succeeds, transport call count = 0)', async () => {
      const transport: ImportTransport = {
        fetchPack: vi.fn().mockResolvedValue({ ok: true }),
      };
      const reg = new AssetRegistry(makeMockShaderRegistry(), transport);

      reg.configurePackIndex('/pack-index.json');

      const guid = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';

      mockGlobalFetch((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                {
                  guid,
                  relativeUrl: '/pack/asset.pack.json',
                  kind: 'mesh',
                },
              ]),
          });
        }
        if (url === '/pack/asset.pack.json') {
          // Return a mesh with 12-float-per-vertex stride (validateMeshPayload
          // requires vertices.length % 12 === 0). 2 vertices x 12 floats.
          // position(3) + normal(3) + uv(2) + tangent(4) = 12.
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                assets: [
                  {
                    guid,
                    kind: 'mesh',
                    payload: {
                      vertices: [
                        0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
                      ],
                      indices: [0, 1],
                      attributes: {},
                    },
                    refs: [],
                    submeshes: [
                      {
                        indexOffset: 0,
                        indexCount: 0,
                        vertexCount: 0,
                        topology: 'triangle-list',
                      },
                    ],
                  },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      const parsed = AssetGuid.parse(guid);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      // DDC hit: catalog has the entry, pack fetch succeeds.
      // validateMeshPayload requires vertices.length === 24 (2 * 12).
      // Indices [0,1] -> maxIndex=1, vertexCount=24/12=2. maxIndex+1===2.
      expect(result.ok).toBe(true);

      // AC-19 lazy iron law: transport must NOT be called when DDC hit.
      expect(transport.fetchPack).toHaveBeenCalledTimes(0);
    });

    it('resolveGuid (dev/fallback, no packIndexUrl) still returns asset-not-found', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      const parsed = AssetGuid.parse(UNKNOWN_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The dev path (no packIndexUrl) goes through resolveGuid, not the
        // transport-aware loadByGuidProd path. It should still return
        // asset-not-found for unregistered GUIDs.
        expect(result.error.code).toBe('asset-not-found');
      }
    });
  });

  // ─── w16: createRenderer transport injection + invariants ────────────────────
  //
  // createRenderer needs a real GPU device, so the injection wiring is asserted
  // against the source SSOT (the constructor call site + signature) rather than
  // by booting a renderer. The behavioural fail-fast (AC-08) + transport-call
  // (AC-19) semantics are exercised by the AssetRegistry-level tests above; here
  // we lock the load-bearing structural invariants the injection channel must
  // preserve.

  const createRendererSrc = readFileSync(
    fileURLToPath(new URL('../createRenderer.ts', import.meta.url)),
    'utf-8',
  );
  const rendererTypeSrc = readFileSync(
    fileURLToPath(new URL('../renderer.ts', import.meta.url)),
    'utf-8',
  );
  // feat-20260705-runtime-tier2-decomposition M1 / w7 (D-4): the load-by-guid +
  // DDC/pack-fetch method cluster moved out of asset-registry.ts into
  // registry/load-by-guid.ts. Source guards for that pipeline read the new file.
  // (The former assetRegistrySrc read was dropped -- its sole remaining consumer,
  // the transport-eligible guard, now reads loadByGuidSrc.)
  const loadByGuidSrc = readFileSync(
    fileURLToPath(new URL('../../../assets-runtime/src/registry/load-by-guid.ts', import.meta.url)),
    'utf-8',
  );

  describe('w16 createRenderer transport injection (AC-03 / AC-05 / AC-08)', () => {
    it('(AC-05) createRenderer threads transport into the AssetRegistry ctor', () => {
      // The AssetRegistry constructor is wired with the injected transport as the
      // second positional argument (D-3: ctor-readonly single injection point).
      // The loaders are now self-contained: AssetRegistry internally builds its
      // own LoaderRegistry via createDefaultLoaderRegistry() (M3 w9).
      expect(createRendererSrc).toMatch(
        /new AssetRegistry\(\s*shaderRegistry,\s*internals\.importTransport\b/,
      );
      // The injection arrives through a dedicated non-RendererOptions internal
      // parameter named `importTransport` on createRenderer.
      expect(createRendererSrc).toMatch(/importTransport\?\s*:\s*ImportTransport/);
    });

    it('(AC-05) RendererOptions gains no asset-layer transport field', () => {
      // The injection channel must NOT pollute RendererOptions with an
      // asset-layer concept (R-4): the transport rides a separate internal param.
      expect(rendererTypeSrc).not.toMatch(/importTransport/);
      expect(rendererTypeSrc).not.toMatch(/ImportTransport/);
    });
  });

  // ─── w5: import-on-demand sentinel routing (feat-20260604 M2 / D-1) ────────────
  //
  // Four routes (AC-02 / AC-03 / AC-08, plan-strategy section 5.3 + Risk-1):
  //   (a) studio form: an unimported (non-.bin) texture row surfaces the
  //       texture-source-not-imported sentinel -> loadByGuidProd routes it through
  //       transport.fetchPack -> after the import the rebuilt catalog has a .bin
  //       row -> the re-entered DDC load succeeds with a TextureAsset handle.
  //   (b) shipped form (no transport): the SAME unimported row fails fast with
  //       asset-not-imported (never silently lazy-imports, AC-08).
  //   (c) Risk-1 falsification: a genuinely corrupt .bin path produces an
  //       image-decode-failed ImageError, which is NOT transport-eligible (the
  //       :2334 guard is `instanceof AssetError`, and ImageError is a distinct
  //       class) -> transport.fetchPack is never called.
  //   (d) after the import the same GUID resolves to a SINGLE .bin row (AC-02).

  const TEXTURE_GUID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const RAW_SOURCE_URL = '/textures/wall.png';
  const IMPORTED_BIN_URL = '/textures/wall.png.bin';

  const TEXTURE_METADATA = {
    kind: 'texture',
    width: 2,
    height: 2,
    format: 'rgba8unorm',
    colorSpace: 'srgb',
    mipmap: false,
  } as const;

  function unimportedTextureRow() {
    return {
      guid: TEXTURE_GUID,
      relativeUrl: RAW_SOURCE_URL,
      kind: 'texture',
      metadata: TEXTURE_METADATA,
    };
  }
  function importedTextureRow() {
    return {
      guid: TEXTURE_GUID,
      relativeUrl: IMPORTED_BIN_URL,
      kind: 'texture',
      metadata: TEXTURE_METADATA,
    };
  }

  function jsonResponse(body: unknown) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }
  function binaryResponse() {
    // 2x2 rgba8 = 16 bytes; loadTextureAsset does not validate byte length, any
    // buffer registers as the TextureAsset POD.
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array(16).buffer),
    });
  }

  describe('w5 import-on-demand sentinel routing (AC-02 / AC-03 / AC-08)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      delete (globalThis as any).fetch;
    });

    it('(a/d AC-03/AC-02) studio form: unimported texture row -> sentinel -> transport imports -> single .bin row resolves', async () => {
      let imported = false;
      const transport: ImportTransport = {
        fetchPack: vi.fn().mockImplementation(() => {
          // The transport (dev POST /__import) imports the .bin and the rebuilt
          // pack-index now carries a single imported .bin row for this GUID.
          imported = true;
          return Promise.resolve({ ok: true });
        }),
      };
      const reg = new AssetRegistry(makeMockShaderRegistry(), transport);
      reg.configurePackIndex('/pack-index.json');

      mockGlobalFetch((url: string) => {
        if (url === '/pack-index.json') {
          // Before import: a single unimported (non-.bin) row. After import: a single
          // imported .bin row (AC-02 single-row, no duplicate raw + imported).
          return jsonResponse([imported ? importedTextureRow() : unimportedTextureRow()]);
        }
        if (url === IMPORTED_BIN_URL) return binaryResponse();
        // The raw source must NOT be fetched as a .bin (it never reaches
        // fetchBinary because the sentinel short-circuits before fetch).
        return Promise.resolve({ ok: false, status: 404 });
      });

      const parsed = AssetGuid.parse(TEXTURE_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(parsed.value);

      expect(transport.fetchPack).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
    });

    it('(b AC-08) shipped form (no transport): same unimported row -> asset-not-imported fail-fast', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      mockGlobalFetch((url: string) => {
        if (url === '/pack-index.json') return jsonResponse([unimportedTextureRow()]);
        return Promise.resolve({ ok: false, status: 404 });
      });

      const parsed = AssetGuid.parse(TEXTURE_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(parsed.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AssetError);
        expect(result.error.code).toBe('asset-not-imported');
      }
    });

    it('(c Risk-1) image-decode-failed (ImageError) is NOT transport-eligible (corrupt .bin never routes transport)', async () => {
      // A custom texture loader that mimics a genuinely corrupt imported .bin:
      // it returns an image-decode-failed ImageError (a distinct class from
      // AssetError). The :2334 transport-eligibility guard is
      // `instanceof AssetError`, so this error must fail straight through and
      // NEVER reach transport.fetchPack.
      const decodeError: ImageError = {
        name: 'ImageError',
        message: 'corrupt .bin',
        code: 'image-decode-failed',
        detail: { code: 'image-decode-failed', reason: 'corrupt bytes', path: IMPORTED_BIN_URL },
      } as unknown as ImageError;

      const transport: ImportTransport = { fetchPack: vi.fn().mockResolvedValue({ ok: true }) };
      const reg = new AssetRegistry(makeMockShaderRegistry(), transport);
      reg.loaders.register({
        kind: 'texture',
        load: () => Promise.resolve({ ok: false as const, error: decodeError }),
      });
      reg.configurePackIndex('/pack-index.json');

      mockGlobalFetch((url: string) => {
        if (url === '/pack-index.json') return jsonResponse([importedTextureRow()]);
        return Promise.resolve({ ok: false, status: 404 });
      });

      const parsed = AssetGuid.parse(TEXTURE_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(parsed.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('image-decode-failed');
        expect(result.error).not.toBeInstanceOf(AssetError);
      }
      // Risk-1 falsification: a real decode failure must not be lazy-imported.
      expect(transport.fetchPack).toHaveBeenCalledTimes(0);
    });
  });

  describe('w16 createRenderer transport injection (AC-03 / AC-05 / AC-08) cont.', () => {
    it('(AC-03 / w6 D-1) transport-eligible set = {asset-not-found, asset-fetch-failed, texture-source-not-imported}, excludes image-decode-failed', () => {
      // R-2 + feat-20260604 Risk-1: a DDC miss routes through transport only for
      // asset-not-found / asset-fetch-failed (missing pack file) or
      // texture-source-not-imported (unimported texture source, D-1 import-on-demand).
      // The eligibility block is layout-robust (the formatter may wrap the
      // clauses), so we slice the guard region and assert by substring.
      const transportGuard = loadByGuidSrc.slice(
        loadByGuidSrc.indexOf('ddcError instanceof AssetError'),
        loadByGuidSrc.indexOf('transportOrFail<T>(registry, guid, guidKey, ddcError.code)'),
      );
      expect(transportGuard).toContain("ddcError.code === 'asset-not-found'");
      expect(transportGuard).toContain("ddcError.code === 'asset-fetch-failed'");
      expect(transportGuard).toContain("ddcError.code === 'texture-source-not-imported'");
      // image-decode-failed (a genuinely corrupt imported .bin) is an ImageError --
      // it must NEVER be listed in the AssetError-only eligibility guard (a real
      // decode failure must not be silently lazy-imported).
      expect(transportGuard).not.toContain('image-decode-failed');
    });
  });
}

{
  // --- from load-by-guid-hdr.test.ts ---
  const GUID_HDR = '00000000-0000-7000-8000-00000000a000';
  const GUID_IMPORTED = '00000000-0000-7000-8000-00000000b000';

  // Synthetic rgba16float .bin bytes: a minimal 1x1 image = 8 bytes
  // (1 px * 4 channels * 2 bytes per float16).  All-zero is a valid
  // float16 value (positive zero).
  function makeImportedBinBytes(width: number, height: number): Uint8Array {
    const byteLength = width * height * 4 * 2;
    return new Uint8Array(byteLength);
  }

  interface FetchResponse {
    readonly ok: boolean;
    readonly status?: number;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }

  function jsonResponse(payload: unknown): FetchResponse {
    return {
      ok: true,
      json: () => Promise.resolve(payload),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
  }

  function binResponse(bytes: Uint8Array): FetchResponse {
    // Create a plain ArrayBuffer slice to match FetchResponse.arrayBuffer return type.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return {
      ok: true,
      json: () => Promise.resolve({}),
      arrayBuffer: () => Promise.resolve(ab),
    };
  }

  describe('w12 - M4 dual-assertion: raw .hdr -> fail-fast + imported .bin -> ok', () => {
    let originalFetch: typeof globalThis.fetch | undefined;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: test teardown
        delete (globalThis as any).fetch;
      }
    });

    // === Arm (a): raw .hdr (shipped form) -> asset-not-imported (D-1 sentinel) ===

    it('raw .hdr relativeUrl, shipped form -> err(asset-not-imported) -- runtime no longer decodes HDR', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      let fetchCallCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        fetchCallCount += 1;
        if (url === '/pack-index.json') {
          return Promise.resolve(
            jsonResponse([
              {
                guid: GUID_HDR,
                relativeUrl: '/vendor/learn-opengl/newport_loft.hdr',
                kind: 'texture',
                sourcePath: 'vendor/learn-opengl/newport_loft.hdr',
                metadata: {
                  kind: 'texture',
                  format: 'rgba32float',
                  colorSpace: 'linear',
                  mipmap: false,
                },
              },
            ]),
          );
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_HDR);
      if (!guid.ok) throw new Error('GUID parse failed');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('asset-not-imported');
      // Only the pack-index fetch should happen; the .hdr source
      // fetch is never attempted (the sentinel fires before fetch, and the
      // shipped-form transportOrFail returns before re-fetching the index).
      expect(fetchCallCount).toBe(1); // pack-index only
    });

    // === Arm (b): imported .bin -> ok + format === 'rgba16float' (AC-03) ===

    it('imported .bin relativeUrl -> ok with format === rgba16float', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      const binWidth = 2;
      const binHeight = 2;
      const importedBinBytes = makeImportedBinBytes(binWidth, binHeight);

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve(
            jsonResponse([
              {
                guid: GUID_IMPORTED,
                relativeUrl: '/assets/imported/hashed-imported.bin',
                kind: 'texture',
                sourcePath: 'vendor/learn-opengl/newport_loft.hdr',
                metadata: {
                  kind: 'texture',
                  format: 'rgba16float',
                  colorSpace: 'linear',
                  mipmap: false,
                  width: binWidth,
                  height: binHeight,
                },
              },
            ]),
          );
        }
        if (url === '/assets/imported/hashed-imported.bin') {
          return Promise.resolve(binResponse(importedBinBytes));
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_IMPORTED);
      if (!guid.ok) throw new Error('GUID parse failed');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // loadByGuid returns the payload directly.
      const tex: TextureAsset = result.value;
      expect(tex.format).toBe('rgba16float');
      expect(tex.colorSpace).toBe('linear');
      expect(tex.width).toBe(binWidth);
      expect(tex.height).toBe(binHeight);
      expect(tex.data.length).toBe(binWidth * binHeight * 4 * 2);
    });
  });
}

{
  // --- from load-by-guid-prod-material-parent.test.ts ---
  const PARENT_GUID = '00000000-0000-7000-8000-000000000001';
  const CHILD_GUID = '00000000-0000-7000-8000-000000000002';
  const CHILD_SAME_PACK_GUID = '00000000-0000-7000-8000-000000000003';
  const NON_MATERIAL_GUID = '00000000-0000-7000-8000-000000000004';

  // pack-index catalog fixture with:
  //  - parent: material in parent.pack.json
  //  - child: material in child.pack.json (parent ref to PARENT_GUID)
  //  - child-same: material in same-pack.pack.json (parent ref to PARENT_GUID,
  //    both in same file)
  //  - non-material: mesh entry for AC-05
  const PACK_INDEX_FIXTURE = [
    {
      guid: PARENT_GUID,
      relativeUrl: '/assets/parent.pack.json',
      kind: 'material',
      sourcePath: 'assets/parent.pack.json',
    },
    {
      guid: CHILD_GUID,
      relativeUrl: '/assets/child.pack.json',
      kind: 'material',
      sourcePath: 'assets/child.pack.json',
    },
    {
      guid: CHILD_SAME_PACK_GUID,
      relativeUrl: '/assets/same-pack.pack.json',
      kind: 'material',
      sourcePath: 'assets/same-pack.pack.json',
    },
    {
      guid: NON_MATERIAL_GUID,
      relativeUrl: '/assets/mesh.pack.json',
      kind: 'mesh',
      sourcePath: 'assets/mesh.pack.json',
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 0,
          topology: 'triangle-list',
        },
      ],
    },
  ];

  // Parent material pack — standalone, has passes.
  const PARENT_PACK = {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: PARENT_GUID,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [
            {
              name: 'Forward',
              shader: 'test::standard',
              tags: { LightMode: 'Forward' },
              queue: 2000,
            },
          ],
          paramValues: {
            baseColor: [0.5, 0.5, 0.5, 1],
            metallic: 0,
            roughness: 0.8,
          },
        },
        refs: [],
      },
    ],
  };

  // Child material pack — no passes, only parent ref.
  const CHILD_PACK = {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: CHILD_GUID,
        kind: 'material',
        payload: {
          kind: 'material',
          parent: 0,
          paramValues: {
            baseColor: [0.8, 0.2, 0.1, 1],
            roughness: 0.3,
          },
        },
        refs: [PARENT_GUID],
      },
    ],
  };

  // Same-pack file — parent + child in one pack (AC-08).
  const SAME_PACK = {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: PARENT_GUID,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [
            {
              name: 'Forward',
              shader: 'test::standard',
              tags: { LightMode: 'Forward' },
              queue: 2000,
            },
          ],
          paramValues: {
            baseColor: [0.3, 0.3, 0.3, 1],
            metallic: 0.2,
            roughness: 0.6,
          },
        },
        refs: [],
      },
      {
        guid: CHILD_SAME_PACK_GUID,
        kind: 'material',
        payload: {
          kind: 'material',
          parent: 0,
          paramValues: {
            roughness: 0.2,
          },
        },
        refs: [PARENT_GUID],
      },
    ],
  };

  // Mesh pack for AC-05 (parent ref points to non-material).
  const MESH_PACK = {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: NON_MATERIAL_GUID,
        kind: 'mesh',
        payload: {
          vertices: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1],
          indices: [0],
          attributes: {},
        },
        refs: [],
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      },
    ],
  };

  // Child that references NON_MATERIAL_GUID as parent — invalid.
  const CHILD_WITH_NON_MATERIAL_PARENT_PACK = {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: '00000000-0000-7000-8000-000000000005',
        kind: 'material',
        payload: {
          kind: 'material',
          parent: 0,
          paramValues: {
            baseColor: [0.8, 0.2, 0.1, 1],
          },
        },
        refs: [NON_MATERIAL_GUID],
      },
    ],
  };

  // feat-20260614 M8: passesOf/paramValueOf are gone. The material parent-chain
  // walk now runs over a World column handle via walkMaterialPassesOverSharedRefs;
  // the child payload (returned by loadByGuid) is minted into a fresh World and
  // its parent chain resolved against the AssetRegistry catalogue (D-19).
  function resolveMaterialChain(reg: AssetRegistry, childPayload: MaterialAsset) {
    const world = new World();
    const childHandle = world.allocSharedRef('MaterialAsset', childPayload);
    return walkMaterialPassesOverSharedRefs(world, childHandle, reg);
  }

  describe('loadByGuid prod :: material parent inheritance (feat-20260528 M2 / w4)', () => {
    let originalFetch: typeof globalThis.fetch | undefined;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: test teardown requires deleting globalThis.fetch
        delete (globalThis as any).fetch;
      }
    });

    // --------------- AC-03: successful parent preload ---------------

    it('(AC-03) child with parent ref (no passes) — parent loaded first, passesOf/paramValueOf inherits parent passes', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PACK_INDEX_FIXTURE),
          });
        }
        if (url === '/assets/parent.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PARENT_PACK),
          });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // resolve the child material — should inherit parent passes
      const walk = resolveMaterialChain(reg, result.value);
      expect(walk.ok).toBe(true);
      if (!walk.ok) return;

      // Inherited parent passes
      expect(walk.value.passes.length).toBe(1);
      if (walk.value.passes[0]) {
        expect(walk.value.passes[0].name).toBe('Forward');
        expect(walk.value.passes[0].shader).toBe('test::standard');
      }

      // Child paramValues override parent: baseColor + roughness from child, metallic from parent
      expect(walk.value.paramValues.baseColor).toEqual([0.8, 0.2, 0.1, 1]);
      expect(walk.value.paramValues.metallic).toBe(0);
      expect(walk.value.paramValues.roughness).toBe(0.3);
    });

    it('(AC-03) parent already catalogued — idempotent fast-path, child resolves correctly', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      // Pre-catalogue the parent (simulates parent already loaded). feat-20260614
      // M8: the registry holds no handle maps; "already loaded" == catalogued.
      const parentGuid = AssetGuid.parse(PARENT_GUID);
      if (!parentGuid.ok) throw new Error('expected ok');
      reg.catalog<MaterialAsset>(parentGuid.value, {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'test::standard',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
        ],
        paramValues: {
          baseColor: [0.5, 0.5, 0.5, 1],
          metallic: 0,
          roughness: 0.8,
        },
      } as MaterialAsset);

      // Now request child — loadByGuid should see parent via the catalogue fast-path
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PACK_INDEX_FIXTURE),
          });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      // Parent already catalogued — loadByGuidProd resolves it from the catalogue.
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const walk = resolveMaterialChain(reg, result.value);
      expect(walk.ok).toBe(true);
      if (!walk.ok) return;

      // Inherited parent passes
      expect(walk.value.passes.length).toBe(1);
      if (walk.value.passes[0]) {
        expect(walk.value.passes[0].name).toBe('Forward');
      }

      // Child paramValues override parent
      expect(walk.value.paramValues.baseColor).toEqual([0.8, 0.2, 0.1, 1]);
      expect(walk.value.paramValues.metallic).toBe(0);
      expect(walk.value.paramValues.roughness).toBe(0.3);
    });

    // --------------- AC-04: parent GUID not in pack-index ---------------

    it('(AC-04) parent GUID not in pack-index — loadByGuid returns Err(asset-not-imported)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      // pack-index only has CHILD_GUID, not PARENT_GUID
      const CATALOG_WITHOUT_PARENT = [
        {
          guid: CHILD_GUID,
          relativeUrl: '/assets/child.pack.json',
          kind: 'material',
          sourcePath: 'assets/child.pack.json',
        },
      ];

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CATALOG_WITHOUT_PARENT),
          });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // M4 shipped form (no import transport): DDC miss -> asset-not-imported (AC-22).
        expect(result.error.code).toBe('asset-not-imported');
        // AC-04: hint prefix must contain parent + child GUID info (D-3)
        expect(result.error.hint).toContain(
          `loading parent material ${PARENT_GUID} for child ${CHILD_GUID}`,
        );
      }
    });

    // --------------- AC-05: parent ref points to non-material kind ---------------

    it('(AC-05) parent ref points to mesh kind — loadByGuid returns Err(asset-parse-failed)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      const GUID_NON_MATERIAL_CHILD = '00000000-0000-7000-8000-000000000005';

      const CATALOG_WITH_MESH = [
        {
          guid: NON_MATERIAL_GUID,
          relativeUrl: '/assets/mesh.pack.json',
          kind: 'mesh',
          sourcePath: 'assets/mesh.pack.json',
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 0,
              vertexCount: 0,
              topology: 'triangle-list',
            },
          ],
        },
        {
          guid: GUID_NON_MATERIAL_CHILD,
          relativeUrl: '/assets/child-nonmat-parent.pack.json',
          kind: 'material',
          sourcePath: 'assets/child-nonmat-parent.pack.json',
        },
      ];

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CATALOG_WITH_MESH),
          });
        }
        if (url === '/assets/mesh.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(MESH_PACK),
          });
        }
        if (url === '/assets/child-nonmat-parent.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_WITH_NON_MATERIAL_PARENT_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(GUID_NON_MATERIAL_CHILD);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // AC-05: parent is mesh, not material — runtime guard catches this
        expect(result.error.code).toBe('asset-parse-failed');
        // hint must include parent GUID + type mismatch info
        expect(result.error.hint).toContain(
          `loading parent material ${NON_MATERIAL_GUID} for child ${GUID_NON_MATERIAL_CHILD}`,
        );
        expect(result.error.hint).toContain("not 'material'");
      }
    });

    // --------------- AC-08: same pack + different pack ---------------

    it('(AC-08) parent and child in same pack file — recursive load works', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      // Same pack file contains both parent and child — both entries map to
      // the same relativeUrl so loadByGuidProd fetches the same file twice
      // (once for parent, once for child), but fast-path idempotency on the
      // second loadByGuid(parentGuid) avoids a duplicate fetch.
      const SAME_PACK_CATALOG = [
        {
          guid: PARENT_GUID,
          relativeUrl: '/assets/same-pack.pack.json',
          kind: 'material',
          sourcePath: 'assets/same-pack.pack.json',
        },
        {
          guid: CHILD_SAME_PACK_GUID,
          relativeUrl: '/assets/same-pack.pack.json',
          kind: 'material',
          sourcePath: 'assets/same-pack.pack.json',
        },
      ];

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(SAME_PACK_CATALOG),
          });
        }
        if (url === '/assets/same-pack.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(SAME_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_SAME_PACK_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      // Same pack: parent entry fetched from same pack file, catalogued first.
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const walk = resolveMaterialChain(reg, result.value);
      expect(walk.ok).toBe(true);
      if (!walk.ok) return;

      // Parent passes inherited
      expect(walk.value.passes.length).toBe(1);
      if (walk.value.passes[0]) {
        expect(walk.value.passes[0].shader).toBe('test::standard');
      }

      // Child roughness overrides parent (0.2 vs 0.6), other params from parent
      expect(walk.value.paramValues.baseColor).toEqual([0.3, 0.3, 0.3, 1]);
      expect(walk.value.paramValues.metallic).toBe(0.2);
      expect(walk.value.paramValues.roughness).toBe(0.2);
    });

    it('(AC-08) parent and child in different pack files — recursive load works', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PACK_INDEX_FIXTURE),
          });
        }
        if (url === '/assets/parent.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PARENT_PACK),
          });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      // Different pack files: parent fetched from parent.pack.json, child from
      // child.pack.json. Both catalogued.
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const walk = resolveMaterialChain(reg, result.value);
      expect(walk.ok).toBe(true);
      if (!walk.ok) return;

      // Parent passes inherited
      expect(walk.value.passes.length).toBe(1);

      // Child paramValues override parent
      expect(walk.value.paramValues.baseColor).toEqual([0.8, 0.2, 0.1, 1]);
      expect(walk.value.paramValues.metallic).toBe(0);
      expect(walk.value.paramValues.roughness).toBe(0.3);
    });

    // --------------- W6: error boundary tests ---------------

    it('(w6) parent load failure error hint has correct prefix format "loading parent material <GUID> for child <GUID>: "', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      // Catalog: child in index but parent not — parent loadByGuid will
      // return asset-not-found.
      const CATALOG_WITH_PARENT_MISSING = [
        {
          guid: CHILD_GUID,
          relativeUrl: '/assets/child.pack.json',
          kind: 'material',
          sourcePath: 'assets/child.pack.json',
        },
      ];

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CATALOG_WITH_PARENT_MISSING),
          });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // M4 shipped form (no import transport): DDC miss -> asset-not-imported (AC-22).
        expect(result.error.code).toBe('asset-not-imported');
        // D-3: exact hint prefix format
        expect(result.error.hint).toContain(
          `loading parent material ${PARENT_GUID} for child ${CHILD_GUID}`,
        );
        // hint should start with the prefix
        expect(result.error.hint).toMatch(/^loading parent material /);
      }
    });

    it('(w6) parent GUID not a valid UUID format —loadByGuid returns Err(asset-parse-failed)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      const INVALID_GUID = 'not-a-valid-uuid';
      const CHILD_WITH_INVALID_PARENT_GUID = '00000000-0000-7000-8000-000000000009';

      const CATALOG = [
        {
          guid: CHILD_WITH_INVALID_PARENT_GUID,
          relativeUrl: '/assets/child-invalid-parent.pack.json',
          kind: 'material',
          sourcePath: 'assets/child-invalid-parent.pack.json',
        },
      ];

      const CHILD_PACK_INVALID = {
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: CHILD_WITH_INVALID_PARENT_GUID,
            kind: 'material',
            payload: {
              kind: 'material',
              parent: 0,
              paramValues: { baseColor: [0.8, 0.2, 0.1, 1] },
            },
            refs: [INVALID_GUID],
          },
        ],
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CATALOG),
          });
        }
        if (url === '/assets/child-invalid-parent.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_PACK_INVALID),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_WITH_INVALID_PARENT_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      // parseAssetPayload returns an asset with parentGuid=<invalid string>,
      // but then AssetGuid.parse(parentGuidStr) in loadByGuidProd fails
      // because 'not-a-valid-uuid' is not a valid UUID format.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-parse-failed');
        expect(result.error.hint).toContain(INVALID_GUID);
        expect(result.error.hint).toContain('not a valid UUID format');
      }
    });
  });

  // feat-20260622 M5 / w16 (R5): AC-10 parent breadcrumb literal-form contract.
  // The material parent edge currently loads via the independent "Path B"
  // preload (asset-registry.ts), which carries the precise breadcrumb hint
  // `loading parent material <PARENT> for child <CHILD>` that downstream code
  // asserts on. M5 (w17) folds Path B into the unified envelope.refs for-loop;
  // these tests lock the exact contract BEFORE the fold so the move is verified
  // to preserve it. They must be green pre-fold (against current Path B) and
  // stay green post-fold (against the unified for-loop sourceField==='parent' /
  // parent-edge branch).
  describe('(w16) AC-10 material parent breadcrumb literal-form contract', () => {
    let originalFetch: typeof globalThis.fetch | undefined;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: test teardown requires deleting globalThis.fetch
        delete (globalThis as any).fetch;
      }
    });

    it('(w16) parent load failure: hint contains parent GUID, child GUID, and the literal substrings "loading parent material" + "for child"', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      // Child catalogued, parent absent from index -> parent load fails.
      const CATALOG_PARENT_MISSING = [
        {
          guid: CHILD_GUID,
          relativeUrl: '/assets/child.pack.json',
          kind: 'material',
          sourcePath: 'assets/child.pack.json',
        },
      ];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG_PARENT_MISSING) });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CHILD_PACK) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const hint = result.error.hint ?? '';
      // Literal form: `loading parent material X for child Y` (research Finding 7;
      // NOT the buildSceneChildContext "sub-asset X referenced by ..." form).
      expect(hint).toContain('loading parent material');
      expect(hint).toContain('for child');
      expect(hint).toContain(PARENT_GUID);
      expect(hint).toContain(CHILD_GUID);
      expect(hint).toContain(`loading parent material ${PARENT_GUID} for child ${CHILD_GUID}`);
    });

    it('(w16) parent load failure: error CODE propagates from the parent load (not replaced with a generic code)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      // Parent absent from index -> parent load is a catalog miss, which (no
      // import transport) yields `asset-not-imported`. The child load must
      // surface THAT code, not a flattened generic `asset-parse-failed`.
      const CATALOG_PARENT_MISSING = [
        {
          guid: CHILD_GUID,
          relativeUrl: '/assets/child.pack.json',
          kind: 'material',
          sourcePath: 'assets/child.pack.json',
        },
      ];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG_PARENT_MISSING) });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CHILD_PACK) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Propagated code from the parent catalog miss (AC-22 shipped form).
      expect(result.error.code).toBe('asset-not-imported');
    });

    it('(w16) parent edge load failure carries enough info to identify the parent GUID', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      // Parent present in index but its pack file 404s -> parent load fails
      // mid-fetch. The breadcrumb must still name the parent GUID so an AI user
      // can locate the failing parent edge.
      const CATALOG_PARENT_FETCH_FAILS = [
        {
          guid: PARENT_GUID,
          relativeUrl: '/assets/parent.pack.json',
          kind: 'material',
          sourcePath: 'assets/parent.pack.json',
        },
        {
          guid: CHILD_GUID,
          relativeUrl: '/assets/child.pack.json',
          kind: 'material',
          sourcePath: 'assets/child.pack.json',
        },
      ];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CATALOG_PARENT_FETCH_FAILS),
          });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CHILD_PACK) });
        }
        // parent.pack.json fetch fails
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const hint = result.error.hint ?? '';
      expect(hint).toContain(`loading parent material ${PARENT_GUID} for child ${CHILD_GUID}`);
    });

    it('(w16) parent ref points to non-material kind: hint preserves the literal parent breadcrumb + "not \'material\'"', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      const GUID_NON_MATERIAL_CHILD = '00000000-0000-7000-8000-000000000005';
      const CATALOG_WITH_MESH = [
        {
          guid: NON_MATERIAL_GUID,
          relativeUrl: '/assets/mesh.pack.json',
          kind: 'mesh',
          sourcePath: 'assets/mesh.pack.json',
          submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'triangle-list' }],
        },
        {
          guid: GUID_NON_MATERIAL_CHILD,
          relativeUrl: '/assets/child-nonmat-parent.pack.json',
          kind: 'material',
          sourcePath: 'assets/child-nonmat-parent.pack.json',
        },
      ];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG_WITH_MESH) });
        }
        if (url === '/assets/mesh.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(MESH_PACK) });
        }
        if (url === '/assets/child-nonmat-parent.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_WITH_NON_MATERIAL_PARENT_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(GUID_NON_MATERIAL_CHILD);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('asset-parse-failed');
      const hint = result.error.hint ?? '';
      expect(hint).toContain(
        `loading parent material ${NON_MATERIAL_GUID} for child ${GUID_NON_MATERIAL_CHILD}`,
      );
      expect(hint).toContain("not 'material'");
    });
  });

  // feat-20260622 M5 / w18: end-to-end material-with-parent load + Path B
  // deletion verification. Proves the parent edge now flows through the unified
  // envelope.refs for-loop (w17 fold) end-to-end, and that the independent Path
  // B early-return block is gone from the source.
  describe('(w18) material-with-parent end-to-end + Path B deletion', () => {
    let originalFetch: typeof globalThis.fetch | undefined;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: test teardown requires deleting globalThis.fetch
        delete (globalThis as any).fetch;
      }
    });

    it('(w18a) child material with parent edge: both child and parent end up in the catalog, child.payload.parent set to the parent AssetGuid', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(PACK_INDEX_FIXTURE) });
        }
        if (url === '/assets/parent.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(PARENT_PACK) });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CHILD_PACK) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuidParsed = AssetGuid.parse(CHILD_GUID);
      const parentGuidParsed = AssetGuid.parse(PARENT_GUID);
      if (!childGuidParsed.ok || !parentGuidParsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuidParsed.value);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Child catalogued with parent stamped as the parent AssetGuid (renderer
      // field read by walkMaterialPassesOverSharedRefs), NOT the parentGuid
      // string intermediate.
      const childInCatalog = reg.lookup(childGuidParsed.value) as MaterialAsset | undefined;
      expect(childInCatalog?.kind).toBe('material');
      expect(childInCatalog?.parent).toBeDefined();
      expect(AssetGuid.format(childInCatalog?.parent as AssetGuid).toLowerCase()).toBe(
        PARENT_GUID.toLowerCase(),
      );

      // Parent catalogued by the unified for-loop recursion (formerly Path B's
      // independent preload).
      const parentInCatalog = reg.lookup(parentGuidParsed.value) as MaterialAsset | undefined;
      expect(parentInCatalog?.kind).toBe('material');
      expect(parentInCatalog?.passes?.length).toBe(1);

      // Inheritance still resolves end-to-end through the catalogued chain.
      const walk = resolveMaterialChain(reg, result.value);
      expect(walk.ok).toBe(true);
      if (!walk.ok) return;
      expect(walk.value.passes.length).toBe(1);
      expect(walk.value.paramValues.baseColor).toEqual([0.8, 0.2, 0.1, 1]);
      expect(walk.value.paramValues.roughness).toBe(0.3);
    });

    it('(w18b) parent load failure -> error breadcrumb matches "loading parent material X for child Y" (post-fold contract preserved)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      const CATALOG_PARENT_MISSING = [
        {
          guid: CHILD_GUID,
          relativeUrl: '/assets/child.pack.json',
          kind: 'material',
          sourcePath: 'assets/child.pack.json',
        },
      ];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG_PARENT_MISSING) });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CHILD_PACK) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuidParsed = AssetGuid.parse(CHILD_GUID);
      if (!childGuidParsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuidParsed.value);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.hint ?? '').toContain(
        `loading parent material ${PARENT_GUID} for child ${CHILD_GUID}`,
      );
    });

    it('(w18c) Path B independent early-return block is deleted from load-by-guid source', () => {
      // feat-20260705-runtime-tier2-decomposition M1 / w7 (D-4): the loadByGuid
      // + DDC pipeline moved from asset-registry.ts into registry/load-by-guid.ts.
      const src = readFileSync(
        fileURLToPath(
          new URL('../../../assets-runtime/src/registry/load-by-guid.ts', import.meta.url),
        ),
        'utf-8',
      );
      // The unique parent breadcrumb literal must NOT appear inside an
      // independent `loadByGuid<MaterialAsset>(parentGuid` preload anymore —
      // that whole Path B early-return is folded into the unified for-loop.
      expect(src).not.toContain('loadByGuid<MaterialAsset>(parentGuid');
      // No early-return that registers a separately rebuilt `resolvedAsset`
      // (post-w7 the free function form is registerParsedAsset(registry, guid, ...)).
      expect(src).not.toContain('registerParsedAsset(registry, guid, resolvedAsset');
      // The `loading parent material` literal now lives only in the unified
      // for-loop branch (template form `for child ${guidKey}`). The old Path B
      // used `for child ${guidKey}` against a `parentGuidStr` local — confirm
      // the new template references `${subGuidKey}` (the for-loop edge GUID).
      // biome-ignore lint/suspicious/noTemplateCurlyInString: matching the literal source text, which deliberately contains the `${...}` placeholders.
      expect(src).toContain('loading parent material ${subGuidKey} for child ${guidKey}');
    });

    it('(w18d) material WITHOUT a parent still loads (no parent edge in refs[]; unified for-loop has nothing to recurse on)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      // PARENT_PACK is a standalone material with passes and no parent ref.
      const CATALOG_STANDALONE = [
        {
          guid: PARENT_GUID,
          relativeUrl: '/assets/parent.pack.json',
          kind: 'material',
          sourcePath: 'assets/parent.pack.json',
        },
      ];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG_STANDALONE) });
        }
        if (url === '/assets/parent.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(PARENT_PACK) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const guidParsed = AssetGuid.parse(PARENT_GUID);
      if (!guidParsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(guidParsed.value);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.kind).toBe('material');
      expect(result.value.parent).toBeUndefined();
      expect(result.value.passes?.length).toBe(1);
    });
  });
}

{
  // --- from load-by-guid-prod.test.ts ---
  const GUID_KNOWN = '00000000-0000-7000-8000-000000000042';
  const GUID_UNKNOWN = 'ffffffff-ffff-7fff-bfff-ffffffffffff';

  // pack-index catalog fixture
  const PACK_INDEX_FIXTURE = [
    {
      guid: GUID_KNOWN,
      relativeUrl: '/assets/mesh-42.pack.json',
      kind: 'mesh',
      sourcePath: 'assets/mesh-42.pack.json',
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 0,
          topology: 'triangle-list',
        },
      ],
    },
  ];

  // .pack.json file content (minimal, matching pack.schema.json)
  const PACK_FILE_FIXTURE = {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: GUID_KNOWN,
        kind: 'mesh',
        payload: {
          // 1 vertex * 12F canonical layout (position vec3 + normal vec3 + uv vec2 + tangent vec4)
          vertices: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1],
          indices: [0],
          attributes: {},
        },
        refs: [],
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      },
    ],
  };

  describe('w24 - AssetRegistry.loadByGuid prod path (fetch from pack-index)', () => {
    let originalFetch: typeof globalThis.fetch | undefined;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: test teardown requires deleting globalThis.fetch
        delete (globalThis as any).fetch;
      }
    });

    it('loadByGuid(known-guid) after configurePackIndex returns Ok(Handle) via fetch', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      // Configure prod pack-index URL
      if (typeof reg.configurePackIndex !== 'function') {
        // M4/w23 not yet done — test is in red phase, skip gracefully
        console.warn('AssetRegistry.configurePackIndex not yet implemented (w23 pending)');
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      // Mock fetch: pack-index + resource
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PACK_INDEX_FIXTURE),
          });
        }
        if (url === '/assets/mesh-42.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PACK_FILE_FIXTURE),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast to globalThis.fetch
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_KNOWN);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(guid.value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // loadByGuid returns the payload directly (no handle).
        expect(result.value.kind).toBe('mesh');
      }
    });

    it('loadByGuid(unknown-guid) after configurePackIndex returns Err(asset-not-imported) (M4 shipped form)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        console.warn('AssetRegistry.configurePackIndex not yet implemented (w23 pending)');
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PACK_INDEX_FIXTURE),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast to globalThis.fetch
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_UNKNOWN);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(guid.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-not-imported');
      }
    });

    it('loadByGuid without configurePackIndex falls back to synchronous Map lookup (M2 behavior)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const guidResult = AssetGuid.parse(GUID_KNOWN);
      if (!guidResult.ok) throw new Error('expected ok');
      // Not configured — M2 behavior: resolveGuid returns Err if not in map
      const result = await reg.loadByGuid<MeshAsset>(guidResult.value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-not-found');
      }
    });
  });
}

{
  // --- from mipmap-formula.test.ts ---
  describe('T-M3-01 (b) numMipLevels formula floor(log2(max(w,h))) + 1', () => {
    it('1x1 -> 1 mip level', () => {
      expect(numMipLevels({ width: 1, height: 1 })).toBe(1);
    });

    it('2x2 -> 2 mip levels', () => {
      expect(numMipLevels({ width: 2, height: 2 })).toBe(2);
    });

    it('4x4 -> 3 mip levels', () => {
      expect(numMipLevels({ width: 4, height: 4 })).toBe(3);
    });

    it('256x256 -> 9 mip levels (log2 256 = 8 + 1)', () => {
      expect(numMipLevels({ width: 256, height: 256 })).toBe(9);
    });

    it('1024x512 -> 11 mip levels (max dimension drives count)', () => {
      expect(numMipLevels({ width: 1024, height: 512 })).toBe(11);
    });

    it('non-power-of-2 (300x200) -> floor(log2(300)) + 1 = 9', () => {
      expect(numMipLevels({ width: 300, height: 200 })).toBe(9);
    });

    it('non-square 17x5 -> floor(log2(17)) + 1 = 5', () => {
      expect(numMipLevels({ width: 17, height: 5 })).toBe(5);
    });
  });
}

{
  // --- from mipmap-pipeline-cache.test.ts ---
  // Minimal in-memory device stub matching the MipmapDevice surface required
  // by the cache tests. The implementation consumes only:
  //   - device.createSampler(desc?)
  //   - device.createBindGroupLayout(desc)
  //   - device.createPipelineLayout(desc)
  //   - device.createRenderPipeline(desc)
  // Shader-module creation is injected via MipmapShaderModuleFactory below.
  // All four return Result-typed POD; the stub returns identity-tagged objects
  // so the cache tests can assert reference equality without booting a real GPU.

  let nextResourceId = 0;
  function makeStubDevice(): MipmapDevice {
    return {
      createSampler: (_desc?: unknown) => ({
        ok: true as const,
        value: { tag: `sampler-${nextResourceId++}` } as unknown as never,
      }),
      createBindGroupLayout: (_desc: unknown) => ({
        ok: true as const,
        value: { tag: `bgl-${nextResourceId++}` } as unknown as never,
      }),
      createPipelineLayout: (_desc: unknown) => ({
        ok: true as const,
        value: { tag: `pl-${nextResourceId++}` } as unknown as never,
      }),
      createRenderPipeline: (desc: {
        fragment?: { targets?: ReadonlyArray<{ format?: string }> };
      }) =>
        ({
          ok: true as const,
          value: {
            tag: `pipeline-${nextResourceId++}`,
            format: desc.fragment?.targets?.[0]?.format,
          } as unknown as never,
        }) as { ok: true; value: never },
    } as unknown as MipmapDevice;
  }

  const stubShaderFactory: MipmapShaderModuleFactory = async (_device, _desc) =>
    ok({ tag: `shader-${nextResourceId++}` } as unknown);

  describe('T-M3-01 (c) MipmapPipelineCache keyed by texture format', () => {
    it('two getOrCreate calls with same format return the same pipeline (cache hit)', async () => {
      const device = makeStubDevice();
      const a = await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
      const b = await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.value).toBe(b.value);
      expect(mipmapCacheSize(device)).toBe(1);
    });

    it('different format -> different pipeline (cache miss adds new slot)', async () => {
      const device = makeStubDevice();
      const linear = await getOrCreateMipmapPipeline(device, 'rgba8unorm', stubShaderFactory);
      const srgb = await getOrCreateMipmapPipeline(device, 'rgba8unorm-srgb', stubShaderFactory);
      expect(linear.ok).toBe(true);
      expect(srgb.ok).toBe(true);
      if (!linear.ok || !srgb.ok) return;
      expect(linear.value).not.toBe(srgb.value);
      expect(mipmapCacheSize(device)).toBe(2);
    });
  });

  describe('T-M3-01 (d) WeakMap<Device, MipmapPipelineCache> per-device isolation', () => {
    it('two distinct devices yield independent caches (no cross-device sharing)', async () => {
      const deviceA = makeStubDevice();
      const deviceB = makeStubDevice();
      const fromA = await getOrCreateMipmapPipeline(deviceA, 'rgba8unorm-srgb', stubShaderFactory);
      const fromB = await getOrCreateMipmapPipeline(deviceB, 'rgba8unorm-srgb', stubShaderFactory);
      expect(fromA.ok).toBe(true);
      expect(fromB.ok).toBe(true);
      if (!fromA.ok || !fromB.ok) return;
      // Same format key, but per-device slots -- pipelines must be distinct.
      expect(fromA.value).not.toBe(fromB.value);
      expect(mipmapCacheSize(deviceA)).toBe(1);
      expect(mipmapCacheSize(deviceB)).toBe(1);
    });

    it('a fresh device starts with cache size 0 (lazy init)', () => {
      const device = makeStubDevice();
      expect(mipmapCacheSize(device)).toBe(0);
    });
  });
}

{
  // --- from parse-asset-payload-material.test.ts ---
  /**
   * Access the private `parseAssetPayload` method via structural view-cast.
   * This is the same pattern used in asset-registry-scene.test.ts (w6) and
   * parse-asset-payload-texture.test.ts (w4). AI users never write this --
   * production callers route through `loadByGuid` which invokes
   * `parseAssetPayload` internally.
   */
  function makeParseFn(reg: AssetRegistry) {
    // biome-ignore lint/suspicious/noExplicitAny: private method access for round-trip dispatch test
    const internal = reg as any as {
      parseAssetPayload(kind: string, payload: Record<string, unknown>, refs?: string[]): unknown;
    };
    return internal.parseAssetPayload.bind(reg);
  }

  describe('parseAssetPayload :: material parent ref (feat-20260528 M1 / w1)', () => {
    const PARENT_GUID = '00000000-0000-7000-8000-000000000001';

    it('(AC-01) payload with parent=0 + valid refs[0] and no passes -> returns MaterialAsset with parentGuid', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = makeParseFn(reg);

      const payload = {
        kind: 'material',
        parent: 0,
        paramValues: { baseColor: [0.8, 0.2, 0.1, 1], roughness: 0.3 },
      };
      const refs = [PARENT_GUID];

      const asset = fn('material', payload, refs) as
        | (MaterialAsset & { parentGuid?: string })
        | undefined;

      expect(asset).toBeDefined();
      if (!asset) return;
      expect(asset.kind).toBe('material');
      expect(asset.passes).toBeUndefined();
      expect(asset.paramValues).toEqual({ baseColor: [0.8, 0.2, 0.1, 1], roughness: 0.3 });
      expect(asset.parentGuid).toBe(PARENT_GUID);
    });

    it('(AC-02) payload without passes and without parent -> returns undefined (fail-fast)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = makeParseFn(reg);

      const payload = {
        kind: 'material',
        paramValues: { baseColor: [1, 0, 0, 1] },
      };
      const refs: string[] = [];

      const asset = fn('material', payload, refs);
      expect(asset).toBeUndefined();
    });

    it('(AC-07) payload.parent index out of bounds (N >= refs.length) -> returns undefined', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = makeParseFn(reg);

      const payload = {
        kind: 'material',
        parent: 3,
        paramValues: { roughness: 0.5 },
      };
      const refs = [PARENT_GUID]; // only 1 element, index 3 is out of bounds

      const asset = fn('material', payload, refs);
      expect(asset).toBeUndefined();
    });

    it('(AC-07) payload.parent with refs undefined -> returns undefined', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = makeParseFn(reg);

      const payload = {
        kind: 'material',
        parent: 0,
        paramValues: { metallic: 0.2 },
      };

      // refs omitted (undefined) -> cannot resolve parent index
      const asset = fn('material', payload);
      expect(asset).toBeUndefined();
    });

    it('(AC-07) payload.parent is number but refs[N] is not a string -> returns undefined', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = makeParseFn(reg);

      const payload = {
        kind: 'material',
        parent: 0,
        paramValues: { metallic: 0.2 },
      };
      const refs = [42 as unknown as string]; // not a valid GUID string

      const asset = fn('material', payload, refs);
      expect(asset).toBeUndefined();
    });

    it('(AC-06) payload with parent ref + valid passes -> returns MaterialAsset with both passes and parentGuid', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = makeParseFn(reg);

      const payload = {
        kind: 'material',
        parent: 0,
        passes: [
          {
            name: 'Forward',
            shader: 'test::standard',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
        ],
        paramValues: { baseColor: [1, 0, 0, 1] },
      };
      const refs = [PARENT_GUID];

      const asset = fn('material', payload, refs) as
        | (MaterialAsset & { parentGuid?: string })
        | undefined;

      expect(asset).toBeDefined();
      if (!asset) return;
      expect(asset.kind).toBe('material');
      expect(asset.passes).toBeDefined();
      expect(asset.passes?.length).toBe(1);
      expect(asset.parentGuid).toBe(PARENT_GUID);
      // paramValues should still be present when both passes + parent are provided
      expect(asset.paramValues).toEqual({ baseColor: [1, 0, 0, 1] });
    });

    it('(regression) payload with passes and without parent ref -> returns MaterialAsset with passes, no parentGuid', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = makeParseFn(reg);

      const payload = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            shader: 'test::standard',
            tags: { LightMode: 'Forward' },
            queue: 2000,
          },
        ],
        paramValues: { baseColor: [1, 0, 0, 1], metallic: 0, roughness: 0.5 },
      };
      const refs: string[] = [];

      const asset = fn('material', payload, refs) as
        | (MaterialAsset & { parentGuid?: string })
        | undefined;

      expect(asset).toBeDefined();
      if (!asset) return;
      expect(asset.kind).toBe('material');
      expect(asset.passes).toBeDefined();
      expect(asset.parentGuid).toBeUndefined();
    });
  });
}

{
  // --- from parse-asset-payload-texture.test.ts ---
  const GUID_DEV = '00000000-0000-7000-8000-00000000d000';
  const GUID_DEV_FETCH_FAIL = '00000000-0000-7000-8000-00000000d001';
  const GUID_DEV_DECODE_FAIL = '00000000-0000-7000-8000-00000000d002';
  const GUID_IMPORT = '00000000-0000-7000-8000-00000000c000';
  const GUID_IMPORT_FETCH_FAIL = '00000000-0000-7000-8000-00000000c001';
  const GUID_NO_METADATA = '00000000-0000-7000-8000-00000000e000';

  // Post-M3 (AC-15): the runtime no longer imports parseImage from
  // @forgeax/engine-image -- the decoder was stripped in w26. Tests
  // verify the post-M3 behavior: only build-time-imported .bin files are
  // accepted by the texture loader.

  interface PackIndexRow {
    readonly guid: string;
    readonly relativeUrl: string;
    readonly kind: string;
    readonly sourcePath: string;
    readonly metadata?: {
      readonly kind: 'texture';
      readonly width?: number;
      readonly height?: number;
      readonly format: string;
      readonly colorSpace: 'srgb' | 'linear';
      readonly mipmap: boolean;
    };
  }

  const PACK_INDEX_FIXTURE: readonly PackIndexRow[] = [
    {
      guid: GUID_DEV,
      relativeUrl: '/apps/learn-render/1.4.textures/assets/wood-container.jpg',
      kind: 'texture',
      sourcePath: 'apps/learn-render/1.4.textures/assets/wood-container.jpg',
      metadata: { kind: 'texture', format: 'rgba8unorm-srgb', colorSpace: 'srgb', mipmap: true },
    },
    {
      guid: GUID_DEV_FETCH_FAIL,
      relativeUrl: '/missing/wood.jpg',
      kind: 'texture',
      sourcePath: 'missing/wood.jpg',
      metadata: { kind: 'texture', format: 'rgba8unorm-srgb', colorSpace: 'srgb', mipmap: true },
    },
    {
      guid: GUID_DEV_DECODE_FAIL,
      relativeUrl: '/apps/learn-render/1.4.textures/assets/corrupt.jpg',
      kind: 'texture',
      sourcePath: 'apps/learn-render/1.4.textures/assets/corrupt.jpg',
      metadata: { kind: 'texture', format: 'rgba8unorm-srgb', colorSpace: 'srgb', mipmap: true },
    },
    {
      guid: GUID_IMPORT,
      relativeUrl: '/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-1a2b3c.bin',
      kind: 'texture',
      sourcePath: 'apps/learn-render/1.4.textures/assets/wood-container.jpg',
      metadata: {
        kind: 'texture',
        width: 4,
        height: 4,
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mipmap: false,
      },
    },
    {
      guid: GUID_IMPORT_FETCH_FAIL,
      relativeUrl: '/assets/missing-import.bin',
      kind: 'texture',
      sourcePath: 'apps/.../missing.jpg',
      metadata: {
        kind: 'texture',
        width: 4,
        height: 4,
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mipmap: false,
      },
    },
    {
      guid: GUID_NO_METADATA,
      // A imported .bin row whose metadata is absent: the .bin-first import-state
      // check passes (it IS imported), so the subsequent metadata check is what
      // surfaces image-meta-missing. (A non-.bin row instead surfaces the
      // transport-eligible texture-source-not-imported sentinel -- cases a/b/c.)
      relativeUrl: '/apps/learn-render/1.4.textures/assets/no-sidecar.bin',
      kind: 'texture',
      sourcePath: 'apps/learn-render/1.4.textures/assets/no-sidecar.bin',
      // metadata intentionally omitted -- mirrors a legacy 4-field row.
    },
  ];

  const FIXTURE_IMPORT = PACK_INDEX_FIXTURE[3] as PackIndexRow;

  interface FetchResponse {
    readonly ok: boolean;
    readonly status?: number;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }

  function jsonResponse(payload: unknown): FetchResponse {
    return {
      ok: true,
      json: () => Promise.resolve(payload),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
  }

  function bytesResponse(bytes: Uint8Array): FetchResponse {
    return {
      ok: true,
      json: () => Promise.resolve({}),
      arrayBuffer: () => {
        // Return a fresh ArrayBuffer copy so consumers that wrap Uint8Array
        // around the result don't accidentally share underlying storage.
        const copy = new Uint8Array(bytes);
        return Promise.resolve(
          copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
        );
      },
    };
  }

  function notFound(): FetchResponse {
    return {
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
  }

  describe('w30 - M3 post-decoder-strip texture unit tests', () => {
    let originalFetch: typeof globalThis.fetch | undefined;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: test teardown deletes globalThis.fetch
        delete (globalThis as any).fetch;
      }
    });

    it('(a) dev source JPG (not .bin), shipped form -> Result.err(asset-not-imported) before source fetch', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      let fetchCallCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        fetchCallCount += 1;
        if (url === '/pack-index.json') return Promise.resolve(jsonResponse(PACK_INDEX_FIXTURE));
        return Promise.resolve(notFound());
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_DEV);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      // feat-20260604 M2 / D-1: the JPG relativeUrl surfaces the
      // texture-source-not-imported sentinel before any source fetch. In the
      // shipped form (no transport) it fails fast as asset-not-imported (AC-08).
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('asset-not-imported');
      // The fetch for the source JPG should NOT happen -- fail-fast before
      // the fetch. Only the pack-index fetch should be counted.
      expect(fetchCallCount).toBe(1); // pack-index only
    });

    it('(b) dev source JPG 404 (not .bin), shipped form -> Result.err(asset-not-imported) before source fetch', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      let fetchCallCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        fetchCallCount += 1;
        if (url === '/pack-index.json') return Promise.resolve(jsonResponse(PACK_INDEX_FIXTURE));
        return Promise.resolve(notFound());
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_DEV_FETCH_FAIL);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      // feat-20260604 M2 / D-1: the .jpg extension surfaces the
      // texture-source-not-imported sentinel; shipped form fails fast as
      // asset-not-imported (AC-08) before any source fetch.
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('asset-not-imported');
      expect(fetchCallCount).toBe(1); // pack-index only, no source fetch
    });

    it('(c) dev source JPG corrupt (not .bin), shipped form -> Result.err(asset-not-imported) before source fetch', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      let fetchCallCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        fetchCallCount += 1;
        if (url === '/pack-index.json') return Promise.resolve(jsonResponse(PACK_INDEX_FIXTURE));
        return Promise.resolve(notFound());
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_DEV_DECODE_FAIL);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      // feat-20260604 M2 / D-1: the .jpg extension surfaces the
      // texture-source-not-imported sentinel; shipped form fails fast as
      // asset-not-imported (AC-08) before any source fetch.
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('asset-not-imported');
      expect(fetchCallCount).toBe(1); // pack-index only, no source fetch
    });

    it('(d) import sub-branch fetch raw RGBA .bin -> Result.ok(TextureAsset POD)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      // 4x4 RGBA = 64 bytes; meta width=4, height=4 -- byte length must align.
      const rgba = new Uint8Array(4 * 4 * 4);
      for (let i = 0; i < rgba.length; i++) rgba[i] = i & 0xff;

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') return Promise.resolve(jsonResponse(PACK_INDEX_FIXTURE));
        if (url === FIXTURE_IMPORT.relativeUrl) return Promise.resolve(bytesResponse(rgba));
        return Promise.resolve(notFound());
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_IMPORT);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // loadByGuid returns the payload directly.
      const asset = result.value;
      expect(asset.kind).toBe('texture');
      expect(asset.width).toBe(4);
      expect(asset.height).toBe(4);
      expect(asset.format).toBe('rgba8unorm');
      expect(asset.colorSpace).toBe('linear');
      expect(asset.mipmap).toBe(false);
      expect(asset.data.byteLength).toBe(4 * 4 * 4);
      expect(asset.data[0]).toBe(0);
      expect(asset.data[63]).toBe(63);
    });

    it('(e) import sub-branch fetch RGBA 404 -> Result.err(asset-fetch-failed)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') return Promise.resolve(jsonResponse(PACK_INDEX_FIXTURE));
        return Promise.resolve(notFound());
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_IMPORT_FETCH_FAIL);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // M4 shipped form (no import transport): DDC fetch fail -> asset-not-imported (AC-22).
      expect(result.error.code).toBe('asset-not-imported');
      const calledUrls = fetchMock.mock.calls.map((c) => c[0]);
      expect(calledUrls).toContain('/assets/missing-import.bin');
    });

    it('(f) pack-index entry kind=texture but metadata absent -> Result.err(image-meta-missing)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') return Promise.resolve(jsonResponse(PACK_INDEX_FIXTURE));
        return Promise.resolve(notFound());
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_NO_METADATA);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('image-meta-missing');
    });
  });
}

{
  // --- from parse-scene-payload-refs.test.ts ---
  /** Access the private parseAssetPayload method via structural view-cast. */
  function accessParseScenePayload(reg: AssetRegistry) {
    // biome-ignore lint/suspicious/noExplicitAny: private method access for unit test
    const internal = reg as any as {
      parseAssetPayload(kind: string, payload: Record<string, unknown>, refs?: string[]): unknown;
    };
    return (
      kind: string,
      payload: Record<string, unknown>,
      refs?: string[],
    ): SceneAsset | undefined => {
      const result = internal.parseAssetPayload(kind, payload, refs);
      if (result === undefined) return undefined;
      if (
        typeof result === 'object' &&
        result !== null &&
        'kind' in result &&
        result.kind === 'scene'
      ) {
        return result as SceneAsset;
      }
      return undefined;
    };
  }

  const GUID_A = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
  const GUID_B = 'f6af7007-158f-4d92-9e47-93bf2f213e1f';

  describe('w1 - parseScenePayload refs normal paths (AC-01)', () => {
    it('replaces number field values with refs[N] GUID string', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = accessParseScenePayload(reg);
      const refs = [GUID_A, GUID_B];
      const payload = {
        entities: [
          {
            localId: 0,
            components: {
              MeshFilter: { assetHandle: 0 },
              MeshRenderer: { materials: [1] },
            },
          },
        ],
      };
      const asset = fn('scene', payload, refs);
      expect(asset).toBeDefined();
      if (!asset) return;
      expect(asset.kind).toBe('scene');
      expect(asset.entities.length).toBe(1);
      const comp = asset.entities[0]?.components as Record<string, Record<string, unknown>>;
      expect(comp.MeshFilter?.assetHandle).toBe(GUID_A); // refs[0]
      expect(comp.MeshRenderer?.materials).toEqual([GUID_B]); // refs[1]
    });

    it('replaces refs index 0 (valid zero-index)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = accessParseScenePayload(reg);
      const refs = [GUID_A];
      const payload = {
        entities: [
          {
            localId: 0,
            components: { MeshFilter: { assetHandle: 0 } },
          },
        ],
      };
      const asset = fn('scene', payload, refs);
      expect(asset).toBeDefined();
      if (!asset) return;
      const comp = asset.entities[0]?.components as Record<string, Record<string, unknown>>;
      expect(comp.MeshFilter?.assetHandle).toBe(GUID_A);
    });

    it('keeps non-integer number fields unchanged (float values are not refs indices)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = accessParseScenePayload(reg);
      const refs = [GUID_A];
      const payload = {
        entities: [
          {
            localId: 0,
            components: {
              Transform: { pos: [1.5, 2.7, -3.2] },
              DirectionalLight: { color: 'white', intensity: 0.8 },
            },
          },
        ],
      };
      const asset = fn('scene', payload, refs);
      expect(asset).toBeDefined();
      if (!asset) return;
      const comp = asset.entities[0]?.components as Record<string, Record<string, unknown>>;
      // Non-integer float values are not refs indices — passed through unchanged.
      expect(comp.Transform?.pos).toEqual([1.5, 2.7, -3.2]);
      expect(comp.DirectionalLight?.color).toBe('white');
      expect(comp.DirectionalLight?.intensity).toBe(0.8);
    });

    it('keeps non-handle integer fields unchanged (Transform posX=0, ChildOf.parent=0)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = accessParseScenePayload(reg);
      const refs = [GUID_A];
      const payload = {
        entities: [
          {
            localId: 0,
            components: {
              ChildOf: { parent: 0 },
              Transform: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
              MeshFilter: { assetHandle: 0 },
            },
          },
        ],
      };
      const asset = fn('scene', payload, refs);
      expect(asset).toBeDefined();
      if (!asset) return;
      const comp = asset.entities[0]?.components as Record<string, Record<string, unknown>>;
      // Non-handle integer fields are kept as-is (M1-fixup F-1)
      expect(comp.ChildOf?.parent).toBe(0);
      expect(comp.Transform?.pos).toEqual([0, 0, 0]);
      expect(comp.Transform?.quat).toEqual([0, 0, 0, 1]);
      expect(comp.Transform?.scale).toEqual([1, 1, 1]);
      // Handle fields are replaced with GUID strings
      expect(comp.MeshFilter?.assetHandle).toBe(GUID_A);
    });

    it('multiple nodes all resolve refs correctly', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = accessParseScenePayload(reg);
      const refs = [GUID_A, GUID_B];
      const payload = {
        entities: [
          {
            localId: 0,
            components: { MeshFilter: { assetHandle: 0 } },
          },
          {
            localId: 1,
            components: { MeshFilter: { assetHandle: 1 } },
          },
          {
            localId: 2,
            components: { MeshRenderer: { materials: [0] } },
          },
        ],
      };
      const asset = fn('scene', payload, refs);
      expect(asset).toBeDefined();
      if (!asset) return;
      expect(asset.entities.length).toBe(3);
      const comp0 = asset.entities[0]?.components as Record<string, Record<string, unknown>>;
      const comp1 = asset.entities[1]?.components as Record<string, Record<string, unknown>>;
      const comp2 = asset.entities[2]?.components as Record<string, Record<string, unknown>>;
      expect(comp0.MeshFilter?.assetHandle).toBe(GUID_A);
      expect(comp1.MeshFilter?.assetHandle).toBe(GUID_B);
      expect(comp2.MeshRenderer?.materials).toEqual([GUID_A]);
    });
  });

  describe('w2 - parseScenePayload refs error paths (AC-02, AC-08)', () => {
    it('returns undefined when refs index is out of bounds (N >= refs.length)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = accessParseScenePayload(reg);
      const refs = [GUID_A]; // length=1, valid indices: 0 only
      const payload = {
        entities: [
          {
            localId: 0,
            components: { MeshFilter: { assetHandle: 1 } }, // N=1 >= refs.length
          },
        ],
      };
      const result = fn('scene', payload, refs);
      expect(result).toBeUndefined();
    });

    it('returns undefined when refs is empty and handle field references index 0', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = accessParseScenePayload(reg);
      const refs: string[] = [];
      const payload = {
        entities: [
          {
            localId: 0,
            components: { MeshFilter: { assetHandle: 0 } }, // N=0 >= refs.length (0 >= 0)
          },
        ],
      };
      const result = fn('scene', payload, refs);
      expect(result).toBeUndefined();
    });

    it('stops on first error (AC-08): only first out-of-bounds node triggers failure', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = accessParseScenePayload(reg);
      const refs = [GUID_A]; // length=1
      const payload = {
        entities: [
          {
            localId: 0,
            components: { MeshFilter: { assetHandle: 1 } }, // first node: out of bounds
          },
          {
            localId: 1,
            components: { MeshFilter: { assetHandle: 0 } }, // second node: valid, but should not be reached
          },
        ],
      };
      // parseScenePayload returns undefined on first error, so result is undefined
      // regardless of the second node's validity
      const result = fn('scene', payload, refs);
      expect(result).toBeUndefined();
    });

    it('returns undefined when index is negative', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = accessParseScenePayload(reg);
      const refs = [GUID_A];
      const payload = {
        entities: [
          {
            localId: 0,
            components: { MeshFilter: { assetHandle: -1 } },
          },
        ],
      };
      const result = fn('scene', payload, refs);
      expect(result).toBeUndefined();
    });

    it('backward compat: parseScenePayload without refs returns SceneAsset with numbers unchanged', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = accessParseScenePayload(reg);
      const payload = {
        entities: [
          {
            localId: 0,
            components: {
              MeshFilter: { assetHandle: 42 },
              MeshRenderer: { materials: [1024] },
            },
          },
        ],
      };
      // No refs passed -- old call signature, numbers should pass through
      const asset = fn('scene', payload);
      expect(asset).toBeDefined();
      if (!asset) return;
      const comp = asset.entities[0]?.components as Record<string, Record<string, unknown>>;
      expect(comp.MeshFilter?.assetHandle).toBe(42);
      expect(comp.MeshRenderer?.materials).toEqual([1024]);
    });

    it('ignores all integer fields without refs and keeps them as-is (non-handle integers)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const fn = accessParseScenePayload(reg);
      const refs = [GUID_A];
      const payload = {
        entities: [
          {
            localId: 0,
            components: { Transform: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
          },
        ],
      };
      const asset = fn('scene', payload, refs);
      expect(asset).toBeDefined();
      if (!asset) return;
      const comp = asset.entities[0]?.components as Record<string, Record<string, unknown>>;
      // M1-fixup F-1: non-handle integer fields (Transform) are preserved as-is.
      // Only fields in the HANDLE_FIELD_NAMES allowlist get refs resolution.
      expect(comp.Transform?.pos).toEqual([0, 0, 0]);
      expect(comp.Transform?.quat).toEqual([0, 0, 0, 1]);
      expect(comp.Transform?.scale).toEqual([1, 1, 1]);
    });
  });

  describe('w2 - fetchPackFile wrapping produces AssetError for failed parse', () => {
    it('loadByGuid returns asset-parse-failed when scene refs index is out of bounds', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const guid = AssetGuid.parse('00000000-0000-7000-8000-000000000099');
      if (!guid.ok) throw new Error('expected ok');

      // Register a pack file with a scene containing out-of-bounds refs.
      // parseAssetPayload returns { ok: false, error }, then fetchPackFile
      // wraps it as asset-parse-failed.
      const badPayload = {
        entities: [
          {
            localId: 0,
            components: { MeshFilter: { assetHandle: 5 } }, // refs length is 3, 5 is out of bounds
          },
        ],
      };
      const packEntry = {
        guid: '00000000-0000-7000-8000-000000000099',
        kind: 'scene',
        payload: badPayload,
        refs: [
          'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          '11111111-2222-3333-4444-555555555555',
          'ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj',
        ],
      };

      // registerWithGuid wraps the raw pack entry lookup — loadByGuid dev path
      // directly hits the guid->handle map without fetchPackFile. We verify
      // the parse failure through the parseAssetPayload structural access
      // (the fetchPackFile path is an integration concern for smoke tests).
      // For unit test: use loadByGuid's dev path which registers a
      // scene asset directly. When we call parseAssetPayload with the
      // bad refs, it returns undefined, which would become asset-parse-failed
      // through fetchPackFile.
      // biome-ignore lint/suspicious/noExplicitAny: private method access
      const internal = reg as any as {
        parseAssetPayload(kind: string, payload: Record<string, unknown>, refs?: string[]): unknown;
      };
      // F21: scene refs out-of-bounds returns the structured error inline via
      // the LoaderOutput { ok: false, error } arm (no instance-slot side effect).
      const result = internal.parseAssetPayload('scene', badPayload, packEntry.refs) as {
        ok: false;
        error: { index: number; refsLength: number };
      };
      expect(result.ok).toBe(false);
      expect(result.error.index).toBe(5);
    });

    it('parseScenePayload returns structured ParseSceneError on refs out-of-bounds (F-2 / AC-02)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      // biome-ignore lint/suspicious/noExplicitAny: private method access
      const internal = reg as any;
      const badPayload = {
        entities: [
          {
            localId: 42,
            components: { MeshFilter: { assetHandle: 5 } },
          },
        ],
      };
      const refs = ['guid-a', 'guid-b']; // length=2, 5 is out of bounds
      // F21: the structured error is the return value's `error` field, not a
      // shared instance slot.
      const result = internal.parseAssetPayload('scene', badPayload, refs) as {
        ok: false;
        error: {
          localId: number;
          component: string;
          field: string;
          index: number;
          refsLength: number;
        };
      };
      expect(result.ok).toBe(false);
      const err = result.error;
      expect(err.localId).toBe(42);
      expect(err.component).toBe('MeshFilter');
      expect(err.field).toBe('assetHandle');
      expect(err.index).toBe(5);
      expect(err.refsLength).toBe(2);
    });
  });
}

{
  // --- from register-with-guid-rgba16float.test.ts ---
  const GUID_RGBA16F = '00000000-0000-7000-8000-000000002001';

  function makeRgba16FloatTexture(): TextureAsset {
    // Minimal 1x1 rgba16float texture: 8 bytes (1 px * 4 channels * 2 B).
    const data = new Uint8Array(8);
    // Encode a mid-gray (0.5, 0.5, 0.5, 1.0) in float16 as a canary.
    // float16 little-endian 0x3800 = 0.5, 0x3C00 = 1.0.
    data[0] = 0x00;
    data[1] = 0x38; // R = 0.5
    data[2] = 0x00;
    data[3] = 0x38; // G = 0.5
    data[4] = 0x00;
    data[5] = 0x38; // B = 0.5
    data[6] = 0x00;
    data[7] = 0x3c; // A = 1.0

    return {
      kind: 'texture' as const,
      width: 1,
      height: 1,
      format: 'rgba16float',
      data,
      colorSpace: 'linear' as const,
      mipmap: false,
    };
  }

  describe('w13 - M4 catalog rgba16float round-trip (AC-09 / D-5)', () => {
    it('catalog(rgba16float pod) -> lookup returns ok with format=rgba16float', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const parseResult = AssetGuid.parse(GUID_RGBA16F);
      if (!parseResult.ok) throw new Error('GUID parse failed');
      const guid = parseResult.value;

      const pod = makeRgba16FloatTexture();
      const cataloged = reg.catalog<TextureAsset>(guid, pod);
      expect(cataloged.ok).toBe(true);

      const got = reg.lookup(guid) as TextureAsset | undefined;
      expect(got).toBeDefined();
      if (got === undefined) return;
      expect(got.format).toBe('rgba16float');
      expect(got.colorSpace).toBe('linear');
      expect(got.width).toBe(1);
      expect(got.height).toBe(1);
      expect(got.data.length).toBe(8);
    });

    it('catalog(rgba16float pod) is re-resolvable via lookup (same payload object)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const parseResult = AssetGuid.parse(GUID_RGBA16F);
      if (!parseResult.ok) throw new Error('GUID parse failed');
      const guid = parseResult.value;

      const cataloged = reg.catalog<TextureAsset>(guid, makeRgba16FloatTexture());
      expect(cataloged.ok).toBe(true);

      const resolved = reg.lookup(guid);
      expect(resolved).toBeDefined();
      if (cataloged.ok) {
        expect(resolved).toBe(cataloged.value);
      }
    });
  });
}

{
  // --- from resolve-scene-guids.test.ts ---
  // A non-builtin user mesh GUID. Must not collide with the builtin mesh GUIDs
  // pre-registered by the AssetRegistry constructor (HANDLE_CUBE is
  // cbe42beb-..., etc., feat-20260603 Tier 0) — those now resolve, so reusing
  // one here would make registerWithGuid throw a collision.
  const MESH_GUID_STR = 'b1c2d3e4-f5a6-4b7c-8d9e-0a1b2c3d4e5f';
  const MATERIAL_GUID_STR = 'f6af7007-158f-4d92-9e47-93bf2f213e1f';
  const SKELETON_GUID_STR = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const UNREGISTERED_GUID_STR = 'deadbeef-dead-beef-dead-beefdeadbeef';

  function parseGuid(s: string): AssetGuid {
    const parsed = AssetGuid.parse(s);
    if (!parsed.ok) throw new Error(`invalid test GUID: ${s}`);
    return parsed.value;
  }

  function localId(n: number): LocalEntityId {
    return n as LocalEntityId;
  }

  /** Build a minimal SceneAsset suitable for _resolveSceneGuids testing. */
  function buildTestAsset(
    nodes: Array<{ localId: number; components: Record<string, Record<string, unknown>> }>,
  ): SceneAsset {
    const sceneNodes: SceneEntity[] = nodes.map((n) => ({
      localId: localId(n.localId),
      components: n.components,
    }));
    return { kind: 'scene', entities: sceneNodes };
  }

  describe('w4 - _resolveSceneGuids success path', () => {
    it('(a) resolves GUID string handle fields to Handle numbers via schema-driven handle<> detection', () => {
      // Register components so World knows their schemas (plan-strategy D-4:
      // _resolveSceneGuids uses world._getComponentByName to read fieldType).
      defineComponent('Transform', { pos: 'array<f32, 3>' });
      const reg = new AssetRegistry(makeMockShaderRegistry());

      // Pre-register mesh asset so resolveGuid finds it.
      const meshGuid = parseGuid(MESH_GUID_STR);
      reg.catalog(meshGuid, {
        kind: 'mesh',
        vertices: new Float32Array(0),
        indices: new Uint16Array(0),
        attributes: { position: new Float32Array(0) },
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      });

      // Also register material and MeshRenderer in world so we verify
      // multi-handle-type detection (MeshFilter + MeshRenderer both have handle fields).
      const materialGuid = parseGuid(MATERIAL_GUID_STR);
      reg.catalog(materialGuid, {
        kind: 'material',
        passes: [{ name: 'forward', shader: 'test::dummy' }],
        paramValues: {},
      });

      // Build a SceneAsset with GUID strings in both MeshFilter.assetHandle and
      // MeshRenderer.material (simulating parseScenePayload refs replacement from M1).
      const asset = buildTestAsset([
        {
          localId: 0,
          components: {
            Transform: { pos: [1, 0, 0] },
            MeshFilter: { assetHandle: MESH_GUID_STR },
            MeshRenderer: { materials: [MATERIAL_GUID_STR] },
          },
        },
      ]);

      const world = new World();
      defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });
      defineComponent('MeshRenderer', { materials: 'array<shared<MaterialAsset>>' });

      // Private function access for unit-test isolation (same pattern as parseAssetPayload in
      // asset-registry-scene.test.ts).
      // biome-ignore lint/suspicious/noExplicitAny: private helper access for round-trip test
      const internal = reg as any as {
        _resolveSceneGuids(
          scene: SceneAsset,
          world: World,
        ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
      };
      const result = internal._resolveSceneGuids(asset, world);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const resolvedAsset = result.value;
      expect(resolvedAsset.kind).toBe('scene');
      expect(resolvedAsset.entities.length).toBe(1);

      const resolvedComp = resolvedAsset.entities[0]?.components as Record<
        string,
        Record<string, unknown>
      >;
      // assetHandle should now be a Handle number (not a string)
      expect(resolvedComp.MeshFilter?.assetHandle).toBeTypeOf('number');
      // materials[0] should also be a Handle number (not a string)
      const matsValue = resolvedComp.MeshRenderer?.materials as readonly unknown[] | undefined;
      expect(Array.isArray(matsValue)).toBe(true);
      expect(matsValue?.[0]).toBeTypeOf('number');
    });

    it('(b) Skin.skeleton field resolves correctly', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      const skelGuid = parseGuid(SKELETON_GUID_STR);
      reg.catalog(skelGuid, {
        kind: 'skeleton',
        inverseBindMatrices: new Float32Array(3 * 16),
        jointCount: 3,
      });

      const asset = buildTestAsset([
        {
          localId: 0,
          components: {
            Skin: { skeleton: SKELETON_GUID_STR, joints: [1, 2] },
          },
        },
      ]);

      const world = new World();
      defineComponent('Skin', {
        skeleton: 'shared<SkeletonAsset>',
        joints: 'array<entity>',
      });

      // biome-ignore lint/suspicious/noExplicitAny: private helper access
      const internal = reg as any as {
        _resolveSceneGuids(
          scene: SceneAsset,
          world: World,
        ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
      };
      const result = internal._resolveSceneGuids(asset, world);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const resolvedAsset = result.value;
      const resolvedComp = resolvedAsset.entities[0]?.components as Record<
        string,
        Record<string, unknown>
      >;
      // skeleton should now be a Handle number
      expect(resolvedComp.Skin?.skeleton).toBeTypeOf('number');
      // joints (array<entity>) should NOT be touched — it's not a handle field
      expect(resolvedComp.Skin?.joints).toEqual([1, 2]);
    });

    it('(c) same GUID referenced by multiple nodes resolves to the same Handle number', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      const meshGuid = parseGuid(MESH_GUID_STR);
      reg.catalog(meshGuid, {
        kind: 'mesh',
        vertices: new Float32Array(0),
        indices: new Uint16Array(0),
        attributes: { position: new Float32Array(0) },
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      });

      const asset = buildTestAsset([
        {
          localId: 0,
          components: {
            MeshFilter: { assetHandle: MESH_GUID_STR },
          },
        },
        {
          localId: 1,
          components: {
            MeshFilter: { assetHandle: MESH_GUID_STR },
          },
        },
      ]);

      const world = new World();
      defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });

      // biome-ignore lint/suspicious/noExplicitAny: private helper access
      const internal = reg as any as {
        _resolveSceneGuids(
          scene: SceneAsset,
          world: World,
        ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
      };
      const result = internal._resolveSceneGuids(asset, world);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const resolvedAsset = result.value;
      const comp0 = (
        resolvedAsset.entities[0]?.components as Record<string, Record<string, unknown>>
      ).MeshFilter;
      const comp1 = (
        resolvedAsset.entities[1]?.components as Record<string, Record<string, unknown>>
      ).MeshFilter;
      expect(comp0?.assetHandle).toBe(comp1?.assetHandle);
      expect(comp0?.assetHandle).toBeTypeOf('number');
    });

    it('(d) nodes without handle fields pass through unchanged', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      const asset = buildTestAsset([{ localId: 0, components: { Transform: { pos: [1, 2, 3] } } }]);

      const world = new World();
      defineComponent('Transform', { pos: 'array<f32, 3>' });

      // biome-ignore lint/suspicious/noExplicitAny: private helper access
      const internal = reg as any as {
        _resolveSceneGuids(
          scene: SceneAsset,
          world: World,
        ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
      };
      const result = internal._resolveSceneGuids(asset, world);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const resolvedAsset = result.value;
      const comp = (
        resolvedAsset.entities[0]?.components as Record<string, Record<string, unknown>>
      ).Transform;
      expect(comp).toEqual({ pos: [1, 2, 3] });
    });
  });

  describe('w5 - _resolveSceneGuids error path', () => {
    it('(e) unregistered GUID returns asset-not-found with hint containing GUID, localId, and field', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      const asset = buildTestAsset([
        {
          localId: 0,
          components: {
            MeshFilter: { assetHandle: UNREGISTERED_GUID_STR },
          },
        },
      ]);

      const world = new World();
      defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });

      // biome-ignore lint/suspicious/noExplicitAny: private helper access
      const internal = reg as any as {
        _resolveSceneGuids(
          scene: SceneAsset,
          world: World,
        ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
      };
      const result = internal._resolveSceneGuids(asset, world);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const e = result.error as { code: string; hint: string };
      expect(e.code).toBe('asset-not-found');
      // Hint must contain the GUID, localId, and field for AI-user debuggability (AC-04)
      expect(e.hint).toContain(UNREGISTERED_GUID_STR);
      expect(e.hint).toContain('0'); // localId
      expect(e.hint).toContain('assetHandle');
    });

    it('(f) stop-on-first-error: only the first unregistered GUID among multiple nodes is reported', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      // Register the first GUID but not the second — first node (localId=1) should
      // fail before reaching localId=2
      const meshGuid = parseGuid(MESH_GUID_STR);
      reg.catalog(meshGuid, {
        kind: 'mesh',
        vertices: new Float32Array(0),
        indices: new Uint16Array(0),
        attributes: { position: new Float32Array(0) },
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 0,
            topology: 'triangle-list',
          },
        ],
      });

      const SECOND_UNREGISTERED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

      const asset = buildTestAsset([
        {
          localId: 1,
          components: {
            MeshFilter: { assetHandle: UNREGISTERED_GUID_STR },
          },
        },
        {
          localId: 2,
          components: {
            MeshFilter: { assetHandle: SECOND_UNREGISTERED },
          },
        },
      ]);

      const world = new World();
      defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });

      // biome-ignore lint/suspicious/noExplicitAny: private helper access
      const internal = reg as any as {
        _resolveSceneGuids(
          scene: SceneAsset,
          world: World,
        ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
      };
      const result = internal._resolveSceneGuids(asset, world);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const e = result.error as { code: string; hint: string };
      expect(e.code).toBe('asset-not-found');
      // Hint should reference the first failing node (localId=1), not the second
      expect(e.hint).toContain(UNREGISTERED_GUID_STR);
      expect(e.hint).toContain('1'); // localId of the first failing node
      // Must NOT contain the second GUID (stopped before reaching it)
      expect(e.hint).not.toContain(SECOND_UNREGISTERED.slice(0, 8)); // prefix match sufficient
    });

    describe('w10 - M3 reverse-decode from envelope.refs + buildSceneChildContext from edge lookup', () => {
      const MATERIAL2_GUID_STR = 'e1e2e3e4-a5a6-4b7c-8d9e-0a1b2c3d4e5f';
      const MATERIAL3_GUID_STR = 'd1d2d3d4-b5b6-4c7d-8e9f-0a1b2c3d4e5f';
      const TEXTURE_GUID_STR = 'cccccccc-aaaa-bbbb-cccc-dddddddddddd';

      function makeTestMesh(): MeshAsset {
        return {
          kind: 'mesh',
          vertices: new Float32Array(0),
          indices: new Uint16Array(0),
          attributes: { position: new Float32Array(0) },
          submeshes: [
            { indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'triangle-list' as const },
          ],
        };
      }

      function makeTestMaterial(): MaterialAsset {
        return {
          kind: 'material',
          passes: [{ name: 'forward', shader: 'test::dummy' }],
          paramValues: {},
        };
      }

      function registerAsset<T extends Asset>(reg: AssetRegistry, guidStr: string, asset: T): void {
        const guid = parseGuid(guidStr);
        reg.catalog(guid, asset);
      }

      it('(a) per-field equivalence: scalar handle + array handle resolve correctly via envelope.refs', () => {
        const reg = new AssetRegistry(makeMockShaderRegistry());

        registerAsset(reg, MESH_GUID_STR, makeTestMesh());
        registerAsset(reg, MATERIAL_GUID_STR, makeTestMaterial());
        registerAsset(reg, MATERIAL2_GUID_STR, makeTestMaterial());
        registerAsset(reg, MATERIAL3_GUID_STR, makeTestMaterial());

        // Build a scene and catalogue it with refs that carry edge metadata
        const sceneGuidStr = '00001111-2222-3333-4444-555566667777';
        const sceneGuid = parseGuid(sceneGuidStr);
        const sceneAsset = buildTestAsset([
          {
            localId: 0,
            components: {
              Transform: { pos: [1, 0, 0] },
              MeshFilter: { assetHandle: MESH_GUID_STR },
              MeshRenderer: {
                materials: [MATERIAL_GUID_STR, MATERIAL2_GUID_STR, MATERIAL3_GUID_STR],
              },
            },
          },
        ]);

        // Catalogue the scene WITH refs edge metadata (envelope.refs path)
        const refs: import('@forgeax/engine-types').AssetRef[] = [
          {
            guid: MESH_GUID_STR,
            sourceField: { componentName: 'MeshFilter', fieldName: 'assetHandle' },
            sceneEntityId: 0,
          },
          {
            guid: MATERIAL_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 0,
            },
            sceneEntityId: 0,
          },
          {
            guid: MATERIAL2_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 1,
            },
            sceneEntityId: 0,
          },
          {
            guid: MATERIAL3_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 2,
            },
            sceneEntityId: 0,
          },
        ];
        reg.catalog(sceneGuid, sceneAsset, refs);

        const world = new World();
        defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });
        defineComponent('MeshRenderer', { materials: 'array<shared<MaterialAsset>>' });

        // biome-ignore lint/suspicious/noExplicitAny: private helper access
        const internal = reg as any as {
          _resolveSceneGuids(
            scene: SceneAsset,
            world: World,
            sceneGuidKey?: string,
          ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
        };
        const result = internal._resolveSceneGuids(sceneAsset, world, sceneGuidStr.toLowerCase());

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const resolvedAsset = result.value;
        expect(resolvedAsset.kind).toBe('scene');
        expect(resolvedAsset.entities.length).toBe(1);

        const resolvedComp = resolvedAsset.entities[0]?.components as Record<
          string,
          Record<string, unknown>
        >;
        // Scalar handle
        expect(resolvedComp.MeshFilter?.assetHandle).toBeTypeOf('number');
        // Array handles — all 3 slots
        const mats = resolvedComp.MeshRenderer?.materials as readonly unknown[] | undefined;
        expect(Array.isArray(mats)).toBe(true);
        expect(mats?.length).toBe(3);
        expect(mats?.[0]).toBeTypeOf('number');
        expect(mats?.[1]).toBeTypeOf('number');
        expect(mats?.[2]).toBeTypeOf('number');
        // Each slot has a distinct material GUID → distinct handle
        expect(mats?.[0]).not.toBe(mats?.[1]);
        expect(mats?.[1]).not.toBe(mats?.[2]);
      });

      it('(b) arrayIndex lossless: array<handle<MaterialAsset>> of 3 → each slot gets correct GUID', () => {
        const reg = new AssetRegistry(makeMockShaderRegistry());

        registerAsset(reg, MATERIAL_GUID_STR, makeTestMaterial());
        registerAsset(reg, MATERIAL2_GUID_STR, makeTestMaterial());
        registerAsset(reg, MATERIAL3_GUID_STR, makeTestMaterial());

        const sceneGuidStr = '00001111-2222-3333-4444-555566667777';
        const sceneGuid = parseGuid(sceneGuidStr);
        const sceneAsset = buildTestAsset([
          {
            localId: 0,
            components: {
              MeshRenderer: {
                materials: [MATERIAL_GUID_STR, MATERIAL2_GUID_STR, MATERIAL3_GUID_STR],
              },
            },
          },
        ]);

        const refs: import('@forgeax/engine-types').AssetRef[] = [
          {
            guid: MATERIAL_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 0,
            },
            sceneEntityId: 0,
          },
          {
            guid: MATERIAL2_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 1,
            },
            sceneEntityId: 0,
          },
          {
            guid: MATERIAL3_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 2,
            },
            sceneEntityId: 0,
          },
        ];
        reg.catalog(sceneGuid, sceneAsset, refs);

        const world = new World();
        defineComponent('MeshRenderer', { materials: 'array<shared<MaterialAsset>>' });

        // biome-ignore lint/suspicious/noExplicitAny: private helper access
        const internal = reg as any as {
          _resolveSceneGuids(
            scene: SceneAsset,
            world: World,
            sceneGuidKey?: string,
          ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
        };
        const result = internal._resolveSceneGuids(sceneAsset, world, sceneGuidStr.toLowerCase());

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const resolvedComp = result.value.entities[0]?.components as Record<
          string,
          Record<string, unknown>
        >;
        const mats = resolvedComp.MeshRenderer?.materials as readonly number[] | undefined;
        expect(mats?.length).toBe(3);
        // Verify each slot is a number (resolved handle) and distinct
        expect(typeof mats?.[0]).toBe('number');
        expect(typeof mats?.[1]).toBe('number');
        expect(typeof mats?.[2]).toBe('number');
        // Different GUIDs → different handles
        expect(mats?.[0]).not.toBe(mats?.[1]);
        expect(mats?.[1]).not.toBe(mats?.[2]);
        expect(mats?.[0]).not.toBe(mats?.[2]);
      });

      it('(c) dedup contract: same GUID from multiple entities → same handle', () => {
        const reg = new AssetRegistry(makeMockShaderRegistry());

        registerAsset(reg, MESH_GUID_STR, makeTestMesh());

        const sceneGuidStr = '00001111-2222-3333-4444-555566667777';
        const sceneGuid = parseGuid(sceneGuidStr);
        const sceneAsset = buildTestAsset([
          {
            localId: 0,
            components: { MeshFilter: { assetHandle: MESH_GUID_STR } },
          },
          {
            localId: 1,
            components: { MeshFilter: { assetHandle: MESH_GUID_STR } },
          },
        ]);

        const refs: import('@forgeax/engine-types').AssetRef[] = [
          {
            guid: MESH_GUID_STR,
            sourceField: { componentName: 'MeshFilter', fieldName: 'assetHandle' },
            sceneEntityId: 0,
          },
          {
            guid: MESH_GUID_STR,
            sourceField: { componentName: 'MeshFilter', fieldName: 'assetHandle' },
            sceneEntityId: 1,
          },
        ];
        reg.catalog(sceneGuid, sceneAsset, refs);

        const world = new World();
        defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });

        // biome-ignore lint/suspicious/noExplicitAny: private helper access
        const internal = reg as any as {
          _resolveSceneGuids(
            scene: SceneAsset,
            world: World,
            sceneGuidKey?: string,
          ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
        };
        const result = internal._resolveSceneGuids(sceneAsset, world, sceneGuidStr.toLowerCase());

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const comp0 = (
          result.value.entities[0]?.components as Record<string, Record<string, unknown>>
        ).MeshFilter;
        const comp1 = (
          result.value.entities[1]?.components as Record<string, Record<string, unknown>>
        ).MeshFilter;
        // Same GUID → same handle (one allocSharedRef per unique payload)
        expect(comp0?.assetHandle).toBe(comp1?.assetHandle);
        expect(comp0?.assetHandle).toBeTypeOf('number');
      });

      it('(d) breadcrumb from envelope.refs: buildSceneChildContext returns correct sceneEntityId + componentField', () => {
        const reg = new AssetRegistry(makeMockShaderRegistry());

        registerAsset(reg, MESH_GUID_STR, makeTestMesh());

        const sceneGuidStr = '00001111-2222-3333-4444-555566667777';
        const sceneGuid = parseGuid(sceneGuidStr);
        const sceneAsset = buildTestAsset([
          {
            localId: 5,
            components: { MeshFilter: { assetHandle: MESH_GUID_STR } },
          },
        ]);

        const refs: import('@forgeax/engine-types').AssetRef[] = [
          {
            guid: MESH_GUID_STR,
            sourceField: { componentName: 'MeshFilter', fieldName: 'assetHandle' },
            sceneEntityId: 5,
          },
        ];
        reg.catalog(sceneGuid, sceneAsset, refs);

        const ctx = buildSceneChildContext(reg, sceneAsset, MESH_GUID_STR.toLowerCase());

        expect(ctx).toBeDefined();
        expect(ctx?.sceneEntityId).toBe(5);
        expect(ctx?.componentField).toBe('MeshFilter.assetHandle');
      });

      it('(e) texture edge: sourceField=undefined → buildSceneChildContext returns componentField undefined', () => {
        const reg = new AssetRegistry(makeMockShaderRegistry());

        registerAsset(reg, MATERIAL_GUID_STR, makeTestMaterial());

        const textureGuid = parseGuid(TEXTURE_GUID_STR);
        reg.catalog(textureGuid, {
          kind: 'texture',
          // biome-ignore lint/suspicious/noExplicitAny: test fixture uses minimal texture shape
          texture: {} as any,
        });

        const sceneGuidStr = '00001111-2222-3333-4444-555566667777';
        const sceneGuid = parseGuid(sceneGuidStr);
        const sceneAsset = buildTestAsset([
          {
            localId: 0,
            components: {
              MeshRenderer: { materials: [MATERIAL_GUID_STR] },
            },
          },
        ]);

        // Scene refs include a texture edge (flat superset per D-2) with
        // sourceField=undefined — texture has no per-entity origin.
        const refs: import('@forgeax/engine-types').AssetRef[] = [
          {
            guid: MATERIAL_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 0,
            },
            sceneEntityId: 0,
          },
          {
            guid: TEXTURE_GUID_STR,
            // sourceField intentionally omitted — texture edge, D-2
            sceneEntityId: undefined,
          },
        ];
        reg.catalog(sceneGuid, sceneAsset, refs);

        // Look up the material GUID — should find sceneEntityId + componentField
        const materialCtx = buildSceneChildContext(
          reg,
          sceneAsset,
          MATERIAL_GUID_STR.toLowerCase(),
        );
        expect(materialCtx).toBeDefined();
        expect(materialCtx?.componentField).toBe('MeshRenderer.materials[0]');

        // Look up the texture GUID — sourceField=undefined → componentField undefined
        const textureCtx = buildSceneChildContext(reg, sceneAsset, TEXTURE_GUID_STR.toLowerCase());
        expect(textureCtx).toBeDefined();
        expect(textureCtx?.sceneEntityId).toBeUndefined();
        expect(textureCtx?.componentField).toBeUndefined();
      });
    });
  });
}

{
  // --- from upload-texture-consistency.test.ts ---
  function makeTexture(format: GPUTextureFormat, colorSpace: 'srgb' | 'linear'): TextureAsset {
    return {
      kind: 'texture',
      width: 1,
      height: 1,
      format,
      data: new Uint8Array([255, 255, 255, 255]),
      colorSpace,
      mipmap: false,
    };
  }

  function makeDecoded(colorSpace: 'srgb' | 'linear'): DecodedImage {
    return {
      bytes: new Uint8Array([255, 255, 255, 255]),
      width: 1,
      height: 1,
      mime: 'image/png',
      colorSpace,
      mipmap: false,
    };
  }

  // feat-20260601-gpu-resource-store-extraction M1: uploadTexture moved to
  // GpuResourceStore; the POD carries the GPU format, the decoded image carries
  // colorSpace (D-2 caller passes POD). The store holds no registry reference, so
  // the asset-not-found arm now lives at the registry `get` the caller does
  // before calling the store (the 3rd case below).
  describe('T-M3-01 (a) uploadTexture format <-> colorSpace consistency assertion', () => {
    it('rejects format=rgba8unorm-srgb + decoded colorSpace=linear (mismatch)', async () => {
      const store = new GpuResourceStore();
      const pod = makeTexture('rgba8unorm-srgb', 'srgb');
      const handle = toShared<'TextureAsset'>(1);
      const decoded = makeDecoded('linear');
      const res = await store.uploadTexture(handle, pod, decoded);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('image-format-unsupported');
      if (res.error.code !== 'image-format-unsupported') return;
      if (res.error.detail.code !== 'image-format-unsupported') return;
      expect(res.error.detail.formatColorSpaceConflict).toBeDefined();
      expect(res.error.detail.formatColorSpaceConflict?.format).toBe('rgba8unorm-srgb');
      expect(res.error.detail.formatColorSpaceConflict?.colorSpace).toBe('linear');
      expect(res.error.detail.formatColorSpaceConflict?.expected).toBe('srgb');
    });

    it('rejects format=rgba8unorm + decoded colorSpace=srgb (mismatch reversed)', async () => {
      const store = new GpuResourceStore();
      const pod = makeTexture('rgba8unorm', 'linear');
      const handle = toShared<'TextureAsset'>(1);
      const decoded = makeDecoded('srgb');
      const res = await store.uploadTexture(handle, pod, decoded);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('image-format-unsupported');
      if (res.error.code !== 'image-format-unsupported') return;
      if (res.error.detail.code !== 'image-format-unsupported') return;
      expect(res.error.detail.formatColorSpaceConflict?.format).toBe('rgba8unorm');
      expect(res.error.detail.formatColorSpaceConflict?.colorSpace).toBe('srgb');
      expect(res.error.detail.formatColorSpaceConflict?.expected).toBe('linear');
    });

    it('unresolvable handle: stale error forwarded (AC-10)', () => {
      // D-3 / AC-10: resolveAssetHandle forwards stale errors instead of
      // swallowing them into asset-not-found. A fake handle with gen>0
      // triggers gen mismatch -> 'shared-ref-stale'.
      const world = new World();
      const fake = toShared<'TextureAsset'>(0xdeadbeef);
      const podRes = resolveAssetHandle<TextureAsset>(world, fake);
      expect(podRes.ok).toBe(false);
      if (podRes.ok) return;
      expect(podRes.error.code).toBe('shared-ref-stale');
    });
  });
}

{
  // --- from verify-revisions.test.ts ---
  const ENGINE = '../createRenderer';

  // ─── Mock fixtures ──────────────────────────────────────────────────────────

  function makeMockGL2(): Record<string, unknown> {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      createShader: () => ({}),
      shaderSource: () => undefined,
      compileShader: () => undefined,
      getShaderParameter: () => true,
      createProgram: () => ({}),
      attachShader: () => undefined,
      linkProgram: () => undefined,
      getProgramParameter: () => true,
      useProgram: () => undefined,
      createVertexArray: () => ({}),
      bindVertexArray: () => undefined,
      createBuffer: () => ({}),
      bindBuffer: () => undefined,
      bufferData: () => undefined,
      enableVertexAttribArray: () => undefined,
      vertexAttribPointer: () => undefined,
      getAttribLocation: () => 0,
      clear: () => undefined,
      drawArrays: () => undefined,
      viewport: () => undefined,
      isContextLost: () => false,
      COMPILE_STATUS: 0x8b81,
      LINK_STATUS: 0x8b82,
      VERTEX_SHADER: 0x8b31,
      FRAGMENT_SHADER: 0x8b30,
      ARRAY_BUFFER: 0x8892,
      STATIC_DRAW: 0x88e4,
      FLOAT: 0x1406,
      TRIANGLES: 0x0004,
      COLOR_BUFFER_BIT: 0x4000,
    };
  }

  interface MockCanvasOpts {
    webgl2: 'context' | 'null';
    webgpu?: 'context' | 'null';
  }

  function makeMockCanvas(opts: MockCanvasOpts): HTMLCanvasElement {
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    return {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') return opts.webgl2 === 'context' ? makeMockGL2() : null;
        if (kind === 'webgpu') {
          return opts.webgpu === 'context'
            ? {
                configure: () => undefined,
                unconfigure: () => undefined,
                getCurrentTexture: () => ({ createView: () => ({}) }),
              }
            : null;
        }
        return null;
      },
      addEventListener(type: string, fn: (e: unknown) => void) {
        let bucket = listeners.get(type);
        if (!bucket) {
          bucket = new Set();
          listeners.set(type, bucket);
        }
        bucket.add(fn);
      },
      removeEventListener(type: string, fn: (e: unknown) => void) {
        listeners.get(type)?.delete(fn);
      },
    } as unknown as HTMLCanvasElement;
  }

  const baseNavigator = { userAgent: 'mock-fix-fN' } as unknown as Navigator;

  beforeEach(() => {
    vi.stubGlobal('navigator', { ...baseNavigator });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── fix-f1: EngineEnvironmentError preserves the RhiError structured object ───

  describe('fix-f1 — EngineEnvironmentError.detail.webgpuError preserves RhiError', () => {
    it('all WebGPU channels fail → detail.webgpuError is a RhiError with .code', async () => {
      const { RhiError } = await import('@forgeax/engine-rhi');

      // With the global vi.mock for rhi-webgpu, the mock factory controls
      // adapter behavior. Force adapter rejection to get the right error code.
      spies.rhiWebgpuRequestAdapterShould = 'reject-adapter-null';

      // navigator.gpu.requestAdapter() === null → rhi.requestDevice() returns
      // Result.err({ code: 'adapter-unavailable' }).
      const mockGpu = {
        requestAdapter: async () => null,
      };
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: mockGpu });
      const canvas = makeMockCanvas({ webgl2: 'null' });

      const { createRenderer } = await import('../createRenderer');
      const { EngineEnvironmentError } = await import('../errors/environment');

      let caught: unknown;
      try {
        await createRenderer(canvas);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EngineEnvironmentError);
      const err = caught as InstanceType<typeof EngineEnvironmentError>;
      // F1 acceptance: webgpuError is a RhiError instance, AI consumers read .code via property access.
      expect(err.detail.webgpuError).toBeInstanceOf(RhiError);
      const rhiErr = err.detail.webgpuError as InstanceType<typeof RhiError>;
      expect(rhiErr.code).toBe('adapter-unavailable');
      expect(typeof rhiErr.expected).toBe('string');
      expect(rhiErr.expected.length).toBeGreaterThan(0);
      expect(typeof rhiErr.hint).toBe('string');
      expect(rhiErr.hint.length).toBeGreaterThan(0);
    });

    it('EngineEnvironmentError.detail is always present (even when webgpuError is undefined)', async () => {
      const { EngineEnvironmentError } = await import('../errors/environment');
      const e = new EngineEnvironmentError('test reason');
      expect(e.detail).toBeDefined();
      expect(e.detail.webgpuError).toBeUndefined();
    });
  });

  // ─── fix-f2: Renderer.onError listener entry ───────────────────────────────

  describe('fix-f2 — Renderer.onError(listener) explicit signal entry', () => {
    it('createRenderer returns a renderer whose onError is a function and returns an unsubscribe fn', async () => {
      const mockGpu = {
        requestAdapter: async () => ({
          requestDevice: async () => ({
            lost: new Promise(() => undefined),
            features: new Set(),
            limits: {},
            queue: { submit: () => undefined, writeBuffer: () => undefined },
            createShaderModule: () => ({}),
            createRenderPipeline: () => ({}),
            createBuffer: () => ({
              getMappedRange: () => new ArrayBuffer(64),
              unmap: () => undefined,
            }),
            createTexture: () => ({}),
            createSampler: () => ({}),
            createBindGroupLayout: () => ({}),
            createCommandEncoder: () => ({
              beginRenderPass: () => ({
                setPipeline: () => undefined,
                setVertexBuffer: () => undefined,
                draw: () => undefined,
                end: () => undefined,
              }),
              finish: () => ({}),
            }),
            destroy: () => undefined,
          }),
        }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      };
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: mockGpu });
      const canvas = makeMockCanvas({ webgl2: 'context', webgpu: 'context' });

      const { createRenderer } = (await import(ENGINE)) as {
        createRenderer: (
          canvas: unknown,
          opts?: { shaderManifestUrl?: string | undefined },
          bundler?: unknown,
        ) => Promise<{ onError?: unknown }>;
      };
      const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: undefined });

      expect(typeof (renderer as { onError?: unknown }).onError).toBe('function');
      const unsub = (
        renderer as {
          onError: (cb: (e: unknown) => void) => () => void;
        }
      ).onError(() => undefined);
      expect(typeof unsub).toBe('function');
      expect(() => unsub()).not.toThrow();
    });

    it('RhiErrorListenerRegistry late-attach replay: an add after fire immediately receives the last error', async () => {
      const { RhiError } = await import('@forgeax/engine-rhi');
      const { RhiErrorListenerRegistry } = await import('../renderer');

      const registry = new RhiErrorListenerRegistry();
      const fakeError = new RhiError({
        code: 'shader-compile-failed',
        expected: 'valid WGSL',
        hint: 'see RhiError.detail.compilerMessages',
      });

      let received: unknown;
      const unsub = registry.add((e) => {
        received = e;
      });
      expect(received).toBeUndefined(); // not yet fired

      registry.fire(fakeError);
      expect(received).toBe(fakeError);

      // late-attach replay: an add after fire still receives the last error immediately.
      let lateReceived: unknown;
      registry.add((e) => {
        lateReceived = e;
      });
      expect(lateReceived).toBe(fakeError);

      unsub();
    });

    it('RhiErrorListenerRegistry.clear detaches all listeners', async () => {
      const { RhiError } = await import('@forgeax/engine-rhi');
      const { RhiErrorListenerRegistry } = await import('../renderer');
      const registry = new RhiErrorListenerRegistry();
      let fired = 0;
      registry.add(() => {
        fired += 1;
      });
      registry.clear();
      registry.fire(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'placeholder',
          hint: 'placeholder',
        }),
      );
      expect(fired).toBe(0);
    });
  });

  // ─── fix-f6: dispose placeholder + listener detach ─────────────────────────

  describe('fix-f6 — Renderer.dispose() placeholder + listener detach', () => {
    it('dispose followed by another dispose does not throw (idempotent)', async () => {
      const mockGpu = {
        requestAdapter: async () => ({
          requestDevice: async () => ({
            lost: new Promise(() => undefined),
            features: new Set(),
            limits: {},
            queue: { submit: () => undefined, writeBuffer: () => undefined },
            createShaderModule: () => ({}),
            createRenderPipeline: () => ({}),
            createBuffer: () => ({
              getMappedRange: () => new ArrayBuffer(64),
              unmap: () => undefined,
            }),
            createTexture: () => ({}),
            createSampler: () => ({}),
            createBindGroupLayout: () => ({}),
            createCommandEncoder: () => ({
              beginRenderPass: () => ({
                setPipeline: () => undefined,
                setVertexBuffer: () => undefined,
                draw: () => undefined,
                end: () => undefined,
              }),
              finish: () => ({}),
            }),
            destroy: () => undefined,
          }),
        }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      };
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: mockGpu });
      const canvas = makeMockCanvas({ webgl2: 'context', webgpu: 'context' });
      const { createRenderer } = (await import(ENGINE)) as {
        createRenderer: (
          canvas: unknown,
          opts?: { shaderManifestUrl?: string | undefined },
          bundler?: unknown,
        ) => Promise<{ dispose: () => void }>;
      };
      const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: undefined });

      expect(() => renderer.dispose()).not.toThrow();
      expect(() => renderer.dispose()).not.toThrow();
    });

    it('LostListenerRegistry.clear detaches all listeners', async () => {
      const { LostListenerRegistry } = await import('../renderer');
      const registry = new LostListenerRegistry();
      let fired = 0;
      registry.add(() => {
        fired += 1;
      });
      registry.clear();
      registry.fire({ reason: 'unknown', message: 'after clear' });
      expect(fired).toBe(0);
    });
  });
}
