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
import type { Handle, MaterialAsset, MaterialValue, TextureAsset } from '@forgeax/engine-types';
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
      values: Readonly<Record<string, unknown>>;
      resolvedValues: Readonly<Record<string, unknown>>;
      renderedSamplingInput: Readonly<Record<string, readonly number[]>>;
      resolvedSamplingInput: Readonly<Record<string, readonly number[]>>;
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
  textureHandle: number,
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
        texture: textureHandle as unknown as AssetGuid,
        coordinates: {
          set: 0,
          transform: {
            offset: samplingInput.baseColorUvTransform?.slice(0, 2) as [number, number],
            scale: samplingInput.baseColorUvTransform?.slice(2, 4) as [number, number],
          },
        },
      },
      normalTexture: {
        texture: textureHandle as unknown as AssetGuid,
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

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-custom-shader: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[custom-shader] no usable backend:', err);
  } else {
    console.error('[custom-shader] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());
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

  const world = new World();

  const materialArtifact = shader.findMaterialArtifact(PULSE_MATERIAL_SHADER_PATH);
  if (!materialArtifact.ok) {
    throw new Error('[custom-shader] cooked shader module is absent from the build manifest');
  }

  const texturePayload: TextureAsset = {
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
  const pulseTextureHandle = world.allocSharedRef('TextureAsset', texturePayload);
  const uploadResult = await renderer.store.uploadTexture(pulseTextureHandle, texturePayload, {
    bytes: texturePayload.data,
    width: texturePayload.width,
    height: texturePayload.height,
    mime: 'image/png',
    colorSpace: texturePayload.colorSpace,
    mipmap: texturePayload.mipmap,
  });
  if (!uploadResult.ok) {
    console.error('[custom-shader] pulse texture upload failed:', uploadResult.error);
    return;
  }
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
        texture: 0,
        texCoord: 1,
        transform: { offset: [0.125, 0.25], scale: [2, 2] },
        scale: 0.8,
      },
    } satisfies GltfMaterialIr,
    {
      textureHandles: new Map([
        [0, pulseTextureHandle as unknown as Handle<'TextureAsset', 'shared'>],
      ]),
    },
  );
  const gltfValues = gltfMaterial.values as Record<string, MaterialValue | null>;
  const resolvedSamplingInput = RESOLVED_SAMPLING_INPUT;
  const renderedSamplingInput =
    falsify === 'uv0-transform-loss' ? UV0_SAMPLING_INPUT : resolvedSamplingInput;
  const rootMaterialBase = materialFromCookedRecord(
    rootReady.record,
    pulseTextureHandle,
    renderedSamplingInput,
  );
  const derivedMaterialBase = materialFromCookedRecord(
    derivedReady.record,
    pulseTextureHandle,
    renderedSamplingInput,
  );
  const rootMaterial: MaterialAsset = {
    ...rootMaterialBase,
    values: { ...rootMaterialBase.values, ...gltfValues },
  };
  const derivedMaterial: MaterialAsset = {
    ...derivedMaterialBase,
    values: { ...derivedMaterialBase.values, ...gltfValues },
  };
  const rootMaterialHandle = world.allocSharedRef('MaterialAsset', rootMaterial);
  const derivedMaterialHandle = world.allocSharedRef('MaterialAsset', derivedMaterial);
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
    values: rootReady.record.resolved.values,
    resolvedValues: derivedReady.record.resolved.values,
    renderedSamplingInput,
    resolvedSamplingInput,
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
  world
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
  const frame = (): void => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    derivedValues.time = (now - startTime) / 1000;
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error('[custom-shader] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
