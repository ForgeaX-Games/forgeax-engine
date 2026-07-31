// apps/hello/custom-shader/src/index.ts
//
// The demo consumes one authored MaterialAsset pack. The shader manifest and
// cooked material records are produced by the Vite build; the app only loads
// them through the runtime catalog and readiness validator.

import { World } from '@forgeax/engine-ecs';
import { Name, Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { acquireCanvasContext, createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';

import { createBoxGeometry } from '@forgeax/engine-geometry';
import { toMaterialAsset, type GltfMaterialIr } from '@forgeax/engine-gltf';
import { createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { CookedMaterialRecord } from '@forgeax/engine-pack';
import type {
  Handle,
  MaterialAsset,
  MaterialTextureValue,
  MaterialValue,
  TextureAsset,
} from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

import './pulse-material.wgsl';
import pulsePackUrl from '../assets/pulse-material.pack.json?url';

declare global {
  var __forgeaxMaterialEvidence:
    | {
      ready: boolean;
      browserPath: boolean;
      webgpu: boolean;
      rootGuid: string;
      derivedGuid: string;
      rootArtifactDigest: string;
      derivedArtifactDigest: string;
      rootCookInputDigest: string;
      derivedCookInputDigest: string;
      renderedMaterialGuids: readonly [string, string];
      renderedTextureHandles: readonly [number, number];
      resolvedTextureHandles: readonly [number, number];
      values: Readonly<Record<string, unknown>>;
      resolvedValues: Readonly<Record<string, unknown>>;
      renderedSamplingInput: Readonly<Record<string, readonly number[]>>;
      resolvedSamplingInput: Readonly<Record<string, readonly number[]>>;
      liveMutation: {
        enabled: boolean;
        applied: boolean;
        appliedFrame: number | null;
        beforeMaterialHandle: number;
        afterMaterialHandle: number;
        beforeTextureHandles: readonly [number, number];
        afterTextureHandles: readonly [number, number];
        baseColorSlotChanged: boolean;
        normalSlotChanged: boolean;
        afterComponentMaterialHandle: number | null;
      };
      resizeRebuild: {
        enabled: boolean;
        applied: boolean;
        requestedCanvas: readonly [number, number];
        beforeCanvas: readonly [number, number];
        afterCanvas: readonly [number, number] | null;
        postResizeMaterialHandle: number | null;
        postResizeBindGroupCreateCount: number | null;
      };
      rendererErrorCodes: readonly string[];
      drawErrorCodes: readonly string[];
      bindGroupCreateCounts: readonly number[];
      frameCount: number;
    }
    | undefined;
}

const PULSE_MATERIAL_SHADER_PATH = 'my-game::pulse-material';
const ROOT_MATERIAL_GUID = '01935b00-7d8c-7c4e-9f12-345678abcd02';
const DERIVED_MATERIAL_GUID = '01935b00-7d8c-7c4e-9f12-345678abcd03';
const RESOLVED_SAMPLING_INPUT = {
  baseColorUvTransform: [0, 0, 1, 1],
  normalUvTransform: [0.125, 0.25, 2, 2],
} as const;
const UV0_SAMPLING_INPUT = {
  baseColorUvTransform: [0, 0, 1, 1],
  normalUvTransform: [0, 0, 1, 1],
} as const;

function materialFromCookedRecord(
  record: CookedMaterialRecord,
  textureHandles: Readonly<{ baseColor: number; normal: number }>,
  samplingInput: Readonly<Record<string, readonly number[]>>,
): MaterialAsset {
  const [firstPass, ...remainingPasses] = record.resolved.passes;
  if (firstPass === undefined) {
    throw new Error(`[custom-shader] cooked material ${record.guid} has no render pass`);
  }
  return {
    kind: 'material',
    passes: [firstPass, ...remainingPasses],
    parameters: record.resolved.parameters,
    values: {
      ...record.resolved.values,
      ...samplingInput,
      baseColorTexture: {
        texture: textureHandles.baseColor as unknown as AssetGuid,
        coordinates: {
          set: 0,
          transform: {
            offset: samplingInput.baseColorUvTransform?.slice(0, 2) as [number, number],
            scale: samplingInput.baseColorUvTransform?.slice(2, 4) as [number, number],
          },
        },
      },
      normalTexture: {
        texture: textureHandles.normal as unknown as AssetGuid,
        coordinates: {
          set: 1,
          transform: {
            offset: samplingInput.normalUvTransform?.slice(0, 2) as [number, number],
            scale: samplingInput.normalUvTransform?.slice(2, 4) as [number, number],
          },
        },
      },
    },
  };
}

function rebindMaterialTextures(
  material: MaterialAsset,
  textureHandles: Readonly<{ baseColor?: number; normal?: number }>,
): MaterialAsset {
  const values = material.values ?? {};
  const nextValues: Record<string, MaterialValue | null> = { ...values };
  for (const [slot, handle] of Object.entries(textureHandles)) {
    if (handle === undefined) continue;
    const valueKey = slot === 'baseColor' ? 'baseColorTexture' : 'normalTexture';
    const textureValue = values[valueKey];
    if (textureValue === null || typeof textureValue !== 'object' || Array.isArray(textureValue)) {
      throw new Error(`[custom-shader] derived material has no structured ${valueKey} value`);
    }
    nextValues[valueKey] = {
      ...(textureValue as MaterialTextureValue),
      texture: handle as unknown as AssetGuid,
    };
  }
  return {
    ...material,
    values: nextValues,
  };
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-custom-shader: missing <canvas id="app"> in index.html');

const liveMode = new URLSearchParams(globalThis.location?.search ?? '').get('live');
const liveNormalSlotSwap = liveMode === 'normal-slot-swap' || liveMode === 'normal-slot-swap-resize';
const liveResizeRebuild = liveMode === 'normal-slot-resize' || liveMode === 'normal-slot-swap-resize';
const liveTwoSlotSwap = liveMode === 'two-slot-swap' || liveMode === 'two-slot-swap-resize';
const liveTwoSlotResize = liveMode === 'two-slot-resize' || liveMode === 'two-slot-swap-resize';
const liveMutationEnabled = liveNormalSlotSwap || liveTwoSlotSwap;
const liveResizeEnabled = liveResizeRebuild || liveTwoSlotResize;

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[custom-shader] no usable backend:', err);
  } else {
    console.error('[custom-shader] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());
  const rendererErrorCodes: string[] = [];
  const drawErrorCodes: string[] = [];
  const bindGroupCreateCounts: number[] = [];
  renderer.onError((error) => rendererErrorCodes.push(error.code));
  // Configure canvas context (mirrors hello-cube; canvas-context migration
  // bridge from the M4 RHI rework).
  const ctxResult = acquireCanvasContext(target);
  if (ctxResult.ok) {
    const cfgResult = ctxResult.value.configure({
      device: renderer.device,
      format: 'rgba8unorm',
      usage: 0x10 | 0x01,
    });
    if (!cfgResult.ok) {
      console.error('[custom-shader] canvasContext.configure failed:', cfgResult.error);
    }
  } else {
    console.warn('[custom-shader] acquireCanvasContext failed:', ctxResult.error);
  }
  console.warn(`[custom-shader] backend=${renderer.backend}`);

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[custom-shader] renderer.ready failed:', ready.error);
    return;
  }

  const shader = renderer.shader;
  const assets = renderer.assets;
  if (shader === null || assets === null) {
    console.error('[custom-shader] renderer shader or asset catalog is unavailable');
    return;
  }

  assets.configurePackIndex('/pack-index.json');
  const rootGuid = AssetGuid.parse(ROOT_MATERIAL_GUID);
  const derivedGuid = AssetGuid.parse(DERIVED_MATERIAL_GUID);
  if (!rootGuid.ok || !derivedGuid.ok) throw new Error('[custom-shader] material GUID is malformed');
  const [rootLoaded, derivedLoaded] = await Promise.all([
    assets.loadByGuid<MaterialAsset>(rootGuid.value),
    assets.loadByGuid<MaterialAsset>(derivedGuid.value),
  ]);
  if (!rootLoaded.ok || !derivedLoaded.ok) {
    console.error('[custom-shader] material catalog load failed', {
      root: rootLoaded.ok
        ? undefined
        : { code: rootLoaded.error.code, expected: rootLoaded.error.expected, hint: rootLoaded.error.hint, detail: rootLoaded.error.detail },
      derived: derivedLoaded.ok
        ? undefined
        : { code: derivedLoaded.error.code, expected: derivedLoaded.error.expected, hint: derivedLoaded.error.hint, detail: derivedLoaded.error.detail },
    });
    throw new Error('[custom-shader] runtime catalog did not load the material inheritance pair');
  }

  const packResponse = await fetch(pulsePackUrl);
  if (!packResponse.ok) throw new Error('[custom-shader] authored pack fetch failed');
  const pack = (await packResponse.json()) as {
    assets?: readonly { guid?: unknown; payload?: { cooked?: unknown } }[];
  };
  const cookedByGuid = new Map<string, unknown>();
  for (const entry of pack.assets ?? []) {
    if (typeof entry.guid === 'string') cookedByGuid.set(entry.guid.toLowerCase(), entry.payload?.cooked);
  }
  const cookedLoader = createMaterialLoader({
    loadRecord: async (guid) => cookedByGuid.get(guid.toLowerCase()),
    loadReference: async () => true,
  });
  const [rootReady, derivedReady] = await Promise.all([
    cookedLoader.load({ guid: ROOT_MATERIAL_GUID, specializationKey: PULSE_MATERIAL_SHADER_PATH }),
    cookedLoader.load({ guid: DERIVED_MATERIAL_GUID, specializationKey: PULSE_MATERIAL_SHADER_PATH }),
  ]);
  if (rootReady.status !== 'Ready' || derivedReady.status !== 'Ready') {
    throw new Error('[custom-shader] cooked material record is not runtime-ready');
  }
  if (
    rootReady.artifact.digest !== derivedReady.artifact.digest ||
    rootReady.record.receipt.inputDigest !== derivedReady.record.receipt.inputDigest ||
    JSON.stringify(rootReady.record.resolved.values) !== JSON.stringify(derivedReady.record.resolved.values)
  ) {
    throw new Error('[custom-shader] inherited materials do not share the cooked specialization');
  }
  const falsify = new URLSearchParams(globalThis.location?.search ?? '').get('falsify');
  if (falsify === 'missing-derived-parent') throw new Error('FALSIFY_EXPECTED_FAILURE:missing-derived-parent');
  if (falsify === 'missing-normal-resource') throw new Error('FALSIFY_EXPECTED_FAILURE:missing-normal-resource');

  const world = new World();

  const materialArtifact = shader.findMaterialArtifact(PULSE_MATERIAL_SHADER_PATH);
  if (!materialArtifact.ok) {
    throw new Error('[custom-shader] cooked shader module is absent from the build manifest');
  }

  const baseColorTexturePayload: TextureAsset = {
    kind: 'texture',
    width: 2,
    height: 2,
    format: 'rgba8unorm-srgb',
    data: new Uint8Array([
      255, 96, 32, 255,
      32, 96, 255, 255,
      32, 96, 255, 255,
      255, 96, 32, 255,
    ]),
    colorSpace: 'srgb',
    mipmap: false,
  };
  const normalTexturePayload: TextureAsset = {
    ...baseColorTexturePayload,
    data: new Uint8Array([
      32, 224, 32, 255,
      224, 32, 32, 255,
      224, 32, 32, 255,
      32, 224, 32, 255,
    ]),
  };
  const liveSwapNormalTexturePayload: TextureAsset = {
    ...baseColorTexturePayload,
    data: new Uint8Array([
      224, 32, 224, 255,
      32, 32, 224, 255,
      32, 32, 224, 255,
      224, 32, 224, 255,
    ]),
  };
  const liveSwapBaseColorTexturePayload: TextureAsset = {
    ...baseColorTexturePayload,
    data: new Uint8Array([
      32, 224, 224, 255,
      224, 224, 32, 255,
      224, 224, 32, 255,
      32, 224, 224, 255,
    ]),
  };
  const baseColorTextureHandle = world.allocSharedRef('TextureAsset', baseColorTexturePayload);
  const normalTextureHandle = world.allocSharedRef('TextureAsset', normalTexturePayload);
  const liveSwapNormalTextureHandle = world.allocSharedRef('TextureAsset', liveSwapNormalTexturePayload);
  const liveSwapBaseColorTextureHandle = world.allocSharedRef('TextureAsset', liveSwapBaseColorTexturePayload);
  for (const [label, handle, payload] of [
    ['base-color', baseColorTextureHandle, baseColorTexturePayload],
    ['normal', normalTextureHandle, normalTexturePayload],
    ['live-swap-normal', liveSwapNormalTextureHandle, liveSwapNormalTexturePayload],
    ['live-swap-base-color', liveSwapBaseColorTextureHandle, liveSwapBaseColorTexturePayload],
  ] as const) {
    const uploadResult = await renderer.store.uploadTexture(handle, payload, {
      bytes: payload.data,
      width: payload.width,
      height: payload.height,
      mime: 'image/png',
      colorSpace: payload.colorSpace,
      mipmap: payload.mipmap,
    });
    if (!uploadResult.ok) {
      console.error(`[custom-shader] ${label} texture upload failed:`, uploadResult.error);
      return;
    }
  }
  const resolvedTextureHandles = {
    baseColor: baseColorTextureHandle,
    normal: normalTextureHandle,
  };
  const renderedTextureHandles =
    falsify === 'normal-slot-swap'
      ? { baseColor: baseColorTextureHandle, normal: baseColorTextureHandle }
      : falsify === 'swapped-normal-binding'
        ? { baseColor: normalTextureHandle, normal: baseColorTextureHandle }
        : resolvedTextureHandles;
  const gltfMaterial = toMaterialAsset(
    {
      name: 'material-inheritance-demo-gltf',
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
      baseColorTexture: {
        texture: 0,
        texCoord: 0,
        transform: { offset: [0, 0], scale: [1, 1] },
      },
      normalTexture: {
        texture: 1,
        texCoord: 1,
        transform: { offset: [0.125, 0.25], scale: [2, 2] },
        scale: 0.8,
      },
    } satisfies GltfMaterialIr,
    {
      textureHandles: new Map([
        [0, renderedTextureHandles.baseColor as unknown as Handle<'TextureAsset', 'shared'>],
        [1, renderedTextureHandles.normal as unknown as Handle<'TextureAsset', 'shared'>],
      ]),
    },
  );
  const gltfValues = gltfMaterial.values as Record<string, MaterialValue | null>;
  const gltfTextureValues: Record<string, MaterialValue | null> = {};
  for (const textureName of ['baseColorTexture', 'normalTexture'] as const) {
    const value = gltfValues[textureName];
    if (value !== undefined) gltfTextureValues[textureName] = value;
  }
  const resolvedSamplingInput = RESOLVED_SAMPLING_INPUT;
  const renderedSamplingInput =
    falsify === 'uv0-transform-loss' ? UV0_SAMPLING_INPUT : resolvedSamplingInput;
  const rootMaterialBase = materialFromCookedRecord(
    rootReady.record,
    renderedTextureHandles,
    renderedSamplingInput,
  );
  const derivedMaterialBase = materialFromCookedRecord(
    derivedReady.record,
    renderedTextureHandles,
    renderedSamplingInput,
  );
  const rootMaterial: MaterialAsset = {
    ...rootMaterialBase,
    values: { ...rootMaterialBase.values, ...gltfTextureValues },
  };
  const derivedMaterial: MaterialAsset = {
    ...derivedMaterialBase,
    values: { ...derivedMaterialBase.values, ...gltfTextureValues },
  };
  const liveSwapMaterial = rebindMaterialTextures(derivedMaterial, { normal: liveSwapNormalTextureHandle });
  const liveTwoSlotSwapMaterial = rebindMaterialTextures(derivedMaterial, {
    baseColor: liveSwapBaseColorTextureHandle,
    normal: liveSwapNormalTextureHandle,
  });
  const rootMaterialHandle = world.allocSharedRef('MaterialAsset', rootMaterial);
  const derivedMaterialHandle = world.allocSharedRef('MaterialAsset', derivedMaterial);
  const liveSwapMaterialHandle = world.allocSharedRef('MaterialAsset', liveSwapMaterial);
  const liveTwoSlotSwapMaterialHandle = world.allocSharedRef('MaterialAsset', liveTwoSlotSwapMaterial);
  const liveReplacementMaterialHandle = liveTwoSlotSwap
    ? liveTwoSlotSwapMaterialHandle
    : liveNormalSlotSwap
      ? liveSwapMaterialHandle
      : derivedMaterialHandle;
  const liveReplacementTextureHandles: readonly [number, number] = liveTwoSlotSwap
    ? [liveSwapBaseColorTextureHandle, liveSwapNormalTextureHandle]
    : liveNormalSlotSwap
      ? [renderedTextureHandles.baseColor, liveSwapNormalTextureHandle]
      : [renderedTextureHandles.baseColor, renderedTextureHandles.normal];
  const derivedValues = derivedMaterial.values as Record<string, MaterialValue | null>;
  globalThis.__forgeaxMaterialEvidence = {
    ready: true,
    browserPath: true,
    webgpu: renderer.backend === 'webgpu',
    rootGuid: ROOT_MATERIAL_GUID,
    derivedGuid: DERIVED_MATERIAL_GUID,
    rootArtifactDigest: rootReady.artifact.digest,
    derivedArtifactDigest: derivedReady.artifact.digest,
    rootCookInputDigest: rootReady.record.receipt.inputDigest,
    derivedCookInputDigest: derivedReady.record.receipt.inputDigest,
    renderedMaterialGuids: [rootReady.record.guid, derivedReady.record.guid],
    renderedTextureHandles: [renderedTextureHandles.baseColor, renderedTextureHandles.normal],
    resolvedTextureHandles: [resolvedTextureHandles.baseColor, resolvedTextureHandles.normal],
    values: rootReady.record.resolved.values,
    resolvedValues: derivedReady.record.resolved.values,
    renderedSamplingInput,
    resolvedSamplingInput,
    liveMutation: {
      enabled: liveMutationEnabled,
      applied: false,
      appliedFrame: null,
      beforeMaterialHandle: derivedMaterialHandle,
      afterMaterialHandle: liveReplacementMaterialHandle,
      beforeTextureHandles: [renderedTextureHandles.baseColor, renderedTextureHandles.normal],
      afterTextureHandles: liveReplacementTextureHandles,
      baseColorSlotChanged: renderedTextureHandles.baseColor !== liveReplacementTextureHandles[0],
      normalSlotChanged: renderedTextureHandles.normal !== liveReplacementTextureHandles[1],
      afterComponentMaterialHandle: null,
    },
    resizeRebuild: {
      enabled: liveResizeEnabled,
      applied: false,
      requestedCanvas: [384, 192],
      beforeCanvas: [target.width, target.height],
      afterCanvas: null,
      postResizeMaterialHandle: null,
      postResizeBindGroupCreateCount: null,
    },
    rendererErrorCodes,
    drawErrorCodes,
    bindGroupCreateCounts,
    frameCount: 0,
  };

  // Procedural box (12-floats stride: position + normal + uv + tangent).
  // The PBR pipeline cache builder (M9-T03) assumes the standard 4-BGL
  // chain and 12-floats vertex layout for user shaders.
  const boxRes = createBoxGeometry(1, 1, 1);
  if (!boxRes.ok) {
    console.error('[custom-shader] createBoxGeometry failed:', boxRes.error);
    return;
  }
  const boxMeshHandle = world.allocSharedRef('MeshAsset', boxRes.value);

  // Compose the World: cube + camera + directional light. Direct light
  // ensures the pulse-material lit path produces a non-black baseline
  // (the shader's f_schlick term still evaluates against the world
  // normal); the SMOKE_PIXEL_THRESHOLD pulse-delta gate at M9-T06 reads
  // pixels at 3 distinct t values to confirm the colour is visibly
  // pulsing across frames.
  world
    .spawn(
      { component: Name, data: { value: 'pulse-root' } as never },
      { component: Transform, data: { pos: [-0.9, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: boxMeshHandle } },
      { component: MeshRenderer, data: { materials: [rootMaterialHandle] } },
    )
    .unwrap();
  const derivedEntity = world
    .spawn(
      { component: Name, data: { value: 'pulse-derived' } as never },
      { component: Transform, data: { pos: [0.9, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: boxMeshHandle } },
      { component: MeshRenderer, data: { materials: [derivedMaterialHandle] } },
    )
    .unwrap();
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 3]},
  },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  ).unwrap();
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.5, -1, -0.3],
      color: [1, 0.95, 0.9],
      intensity: 1.0,
  },
  }).unwrap();

  // Animate the runtime material values to exercise the cooked shader path.
  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let renderedFrameCount = 0;
  const frame = (): void => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    derivedValues.time = liveResizeEnabled || liveMutationEnabled ? 0 : (now - startTime) / 1000;
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) {
      drawErrorCodes.push(r.error.code);
      console.error('[custom-shader] draw error:', r.error);
    }
    renderedFrameCount += 1;
    if (globalThis.__forgeaxMaterialEvidence !== undefined) {
      globalThis.__forgeaxMaterialEvidence.frameCount = renderedFrameCount;
      if (liveMutationEnabled && renderedFrameCount === 120) {
        const mutation = world.set(derivedEntity, MeshRenderer, {
          materials: [liveReplacementMaterialHandle],
        });
        if (!mutation.ok) {
          console.error('[custom-shader] live normal-slot rebind failed:', mutation.error);
        } else {
          globalThis.__forgeaxMaterialEvidence.liveMutation.applied = true;
          globalThis.__forgeaxMaterialEvidence.liveMutation.appliedFrame = renderedFrameCount;
          const currentRenderer = world.get(derivedEntity, MeshRenderer);
          if (currentRenderer.ok) {
            const materials = currentRenderer.value.materials as unknown as ArrayLike<number>;
            globalThis.__forgeaxMaterialEvidence.liveMutation.afterComponentMaterialHandle =
              materials[0] ?? null;
          }
        }
      }
      if (liveResizeEnabled && renderedFrameCount === 150) {
        target.width = 384;
        target.height = 192;
        globalThis.__forgeaxMaterialEvidence.resizeRebuild.applied = true;
      }
      if (
        liveResizeEnabled &&
        globalThis.__forgeaxMaterialEvidence.resizeRebuild.applied &&
        globalThis.__forgeaxMaterialEvidence.resizeRebuild.afterCanvas === null &&
        (target.width !== globalThis.__forgeaxMaterialEvidence.resizeRebuild.beforeCanvas[0] ||
          target.height !== globalThis.__forgeaxMaterialEvidence.resizeRebuild.beforeCanvas[1])
      ) {
        const currentRenderer = world.get(derivedEntity, MeshRenderer);
        if (currentRenderer.ok) {
          const materials = currentRenderer.value.materials as unknown as ArrayLike<number>;
          globalThis.__forgeaxMaterialEvidence.resizeRebuild.afterCanvas = [target.width, target.height];
          globalThis.__forgeaxMaterialEvidence.resizeRebuild.postResizeMaterialHandle = materials[0] ?? null;
          globalThis.__forgeaxMaterialEvidence.resizeRebuild.postResizeBindGroupCreateCount =
            renderer.bindGroupCounts.createBindGroup;
        }
      }
      if (liveMutationEnabled && globalThis.__forgeaxMaterialEvidence.liveMutation.applied) {
        bindGroupCreateCounts.push(renderer.bindGroupCounts.createBindGroup);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
