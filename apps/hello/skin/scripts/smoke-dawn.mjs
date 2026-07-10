#!/usr/bin/env node
// hello-skin headless smoke (tweak-20260611-skin-fox-3clip-and-kb-sample-assets M4 / m4-1).
//
// End-to-end proof: dawn-node drives the same Khronos Fox.glb 3-instance
// scene the browser src/main.ts exercises (charter P4 consistent abstraction).
// 300 frames + pixel readback: non-black + non-NaN shape sanity gate.
//
// M4 scope: the smoke runs the new Fox.glb pipeline (parseGlb + bridge +
// 3 AnimationPlayer instances) end-to-end and verifies the structural
// 5-criteria gate (a) backend (b) frames (c) per-pixel non-black (d) no NaN
// (e) Renderer.onError count == 0. M5 adds baseline.png regeneration + the
// FALSIFY=clip-fixed / FALSIFY=no-skin counter-proofs.
//
// Output literals (grep-friendly):
//   - `[hello-skin] backend=webgpu`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');

// tweak-20260611 M7 / AC-06: FALSIFY counter-proofs (must turn smoke red).
//   FALSIFY=clip-fixed -> all 3 instances share the Survey clip handle; the
//     three foxes animate in lockstep. Smoke asserts each spawn carries a
//     distinct AnimationPlayer.clip handle; with the falsify mutation that
//     assertion trips and exit !=0. (Without falsify the smoke verifies the
//     three handles really ARE different, catching a regression where the
//     demo accidentally collapses the lineup to one clip.)
//   FALSIFY=no-skin -> bridge ctx omits skeletonGuidBySkinIndex so no Skin
//     component is emitted on any Fox instance. Smoke asserts at least one
//     resolved Skin entity exists in each spawn subtree; with the falsify
//     mutation findSkinnedMember returns undefined and exit !=0.
//   FALSIFY=identity-parent -> parent rig uses identity Transform (pos y=0)
//     instead of pos y=1. With the shader fix (M1), the rendered frame must
//     differ from the parented baseline; if it does NOT differ, either the
//     parent is not being applied or the camera framing washes out the
//     difference, and the smoke is suspect. Counter-proof for AC-02.
const FALSIFY = process.env.FALSIFY ?? '';
if (FALSIFY !== '' && FALSIFY !== 'clip-fixed' && FALSIFY !== 'no-skin' && FALSIFY !== 'identity-parent') {
  console.error(`[smoke] FAIL - unknown FALSIFY mode '${FALSIFY}' (expected '' / 'clip-fixed' / 'no-skin' / 'identity-parent')`);
  process.exit(1);
}

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const FOX_GLB_PATH = resolve(repoRoot, 'forgeax-engine-assets/khronos-gltf-samples/Fox/Fox.glb');
const FOX_META_PATH = resolve(repoRoot, 'forgeax-engine-assets/khronos-gltf-samples/Fox/Fox.glb.meta.json');

// --- 1. dawn.node binding setup ------------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-skin smoke');
  console.error('  hint:  ensure node_modules/.pnpm/webgpu@*/node_modules/webgpu/dist binary present');
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-skin smoke');
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
// feat-20260612-skin-palette-per-frame-upload M4 / m4-4: dawn-node palette
// readback probe (AC-01 dawn-equivalent fallback to the browser-path AC-01
// in smoke-browser.mjs). The browser smoke is the primary gate; this probe
// is the bottom-of-the-stack guard so a dawn-node-only regression in the
// SkinPaletteAllocator/writeJointPalette path does not slip through silent.
// Implementation choice: intercept device.queue.writeBuffer for buffers
// labeled `skin-palette` (the SkinPaletteAllocator's GPUBuffer label) and
// hash the payload bytes. The plan-strategy mentions mapAsync as the
// "ideal" readback path; the runtime palette buffer is created with
// STORAGE | COPY_DST (no COPY_SRC / MAP_READ), so a true mapAsync would
// require staging a copyBufferToBuffer round-trip every frame -- a
// significantly more invasive smoke-side change than the intercept and
// functionally equivalent (the writeBuffer payload IS the bytes the GPU
// stores, byte-for-byte, modulo the GPU's internal write coalescing). The
// implementer note explicitly allows this simplification when the
// intercept is the load-bearing observation. Sample window: >=3 distinct
// fullHash values across the recorded writes (paralleling smoke-browser
// AC-01's 3-sample lower bound). FALSIFY anchor: short-circuit
// writeJointPalette in skin-palette-allocator.ts to write a constant
// identity payload -> distinctness collapses to 1 -> probe red.
const skinPaletteWritesDawn = [];
const fnv1a32Dawn = (bytes, start, end) => {
  let h = 0x811c9dc5;
  for (let i = start; i < end; i++) {
    h ^= bytes[i] ?? 0;
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalAmbientRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    // M4 / m4-4: install palette buffer + writeBuffer hooks on first
    // device acquisition. Same shape as smoke-browser's addInitScript
    // hook chain but inlined here (dawn-node has no page context).
    try {
      const origCB = dev.createBuffer.bind(dev);
      const paletteIndex = new WeakMap();
      let paletteBufferCount = 0;
      dev.createBuffer = (cdesc) => {
        const buf = origCB(cdesc);
        try {
          if ((cdesc.label ?? '') === 'skin-palette') {
            paletteIndex.set(buf, paletteBufferCount++);
          }
        } catch (_e) {}
        return buf;
      };
      const origQueue = dev.queue;
      const origWriteBuffer = origQueue.writeBuffer.bind(origQueue);
      origQueue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
        try {
          if (paletteIndex.has(buffer)) {
            const u8 =
              data instanceof Uint8Array
                ? data
                : data?.buffer != null
                  ? new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength)
                  : data instanceof ArrayBuffer
                    ? new Uint8Array(data)
                    : null;
            if (u8 !== null) {
              const totalLen = u8.byteLength;
              const fullHash = fnv1a32Dawn(u8, 0, totalLen);
              const headEnd = Math.min(64, totalLen);
              const firstMat4Hash = fnv1a32Dawn(u8, 0, headEnd);
              skinPaletteWritesDawn.push({ offset, byteLength: totalLen, fullHash, firstMat4Hash });
            }
          }
        } catch (_e) {}
        return origWriteBuffer(buffer, offset, data, dataOffset, size);
      };
    } catch (_e) {}
    return dev;
  };
  return rawAdapter;
};

// --- 2. Mock canvas with offscreen render target -------------------------------

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}

const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. Engine + Fox.glb pipeline -----------------------------------------------

const { World } = await import('@forgeax/engine-ecs');
const {
  AnimationPlayer,
  Camera,
  ChildOf,
  createAnimationAssetResolver,
  createRenderer,
  DirectionalLight,
  registerAdvanceAnimationPlayer,
  SceneInstance,
  Skin,
  Transform,
} = await import('@forgeax/engine-runtime');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { gltfDocToSceneAsset, meshIrToMeshAsset, parseGlb, toMaterialAsset } = await import(
  '@forgeax/engine-gltf'
);

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[hello-skin] backend=${renderer.backend}`);

const assets = renderer.assets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

// --- Fox.glb parse + POD register (mirrors src/main.ts) ------------------------

const meta = JSON.parse(readFileSync(FOX_META_PATH, 'utf8'));
const subs = meta.subAssets;

function subGuid(kind, sourceIndex) {
  const e = subs.find((s) => s.kind === kind && s.sourceIndex === sourceIndex);
  if (!e) throw new Error(`Fox.glb.meta.json missing ${kind}/${sourceIndex}`);
  const r = AssetGuid.parse(e.guid);
  if (!r.ok) throw new Error(`AssetGuid.parse(${e.guid}) failed`);
  return r.value;
}

const meshGuid = subGuid('mesh', 0);
const materialGuid = subGuid('material', 0);
const sceneGuid = subGuid('scene', 0);
const skeletonGuid = subGuid('skeleton', 0);
const skinGuid = subGuid('skin', 0);
const surveyGuid = subGuid('animation-clip', 0);
const walkGuid = subGuid('animation-clip', 1);
const runGuid = subGuid('animation-clip', 2);

const glbBytes = readFileSync(FOX_GLB_PATH);
const glbAb = glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength);
const docResult = await parseGlb(glbAb, FOX_GLB_PATH);
if (!docResult.ok) {
  console.error('[smoke] FAIL - parseGlb failed:', docResult.error);
  process.exit(1);
}
const doc = docResult.value;

const skeletonRec = doc.skeletons[0];
if (!skeletonRec) {
  console.error('[smoke] FAIL - Fox.glb GltfDoc.skeletons[0] missing');
  process.exit(1);
}
// w64: World holds the SharedRefStore minted handles need; create it before
// any allocSharedRef. catalog stores GUID->payload for instantiate resolution.
const world = new World();
assets.catalog(skeletonGuid, {
  kind: 'skeleton',
  inverseBindMatrices: skeletonRec.inverseBindMatrices,
  jointCount: skeletonRec.jointCount,
});
assets.catalog(skinGuid, {
  kind: 'skin',
  skeletonGuid: AssetGuid.format(skeletonGuid),
  jointPaths: skeletonRec.jointPaths,
});

function recToClip(rec) {
  const channels = [];
  for (const ch of rec.channels) {
    const property =
      ch.property === 'translation' || ch.property === 'rotation' || ch.property === 'scale'
        ? ch.property
        : 'rotation';
    channels.push({
      targetPath: ch.targetPath,
      property,
      sampler: {
        input: ch.sampler.input,
        output: ch.sampler.output,
        interpolation: ch.sampler.interpolation === 'STEP' ? 'STEP' : 'LINEAR',
      },
    });
  }
  let duration = rec.duration;
  if (!Number.isFinite(duration) || duration <= 0) duration = 1;
  return { kind: 'animation-clip', duration, channels };
}

const surveyClip = recToClip(doc.animationClips[0]);
const walkClip = recToClip(doc.animationClips[1]);
const runClip = recToClip(doc.animationClips[2]);
assets.catalog(surveyGuid, surveyClip);
assets.catalog(walkGuid, walkClip);
assets.catalog(runGuid, runClip);
const surveyHandle = world.allocSharedRef('AnimationClip', surveyClip);
const walkHandle = world.allocSharedRef('AnimationClip', walkClip);
const runHandle = world.allocSharedRef('AnimationClip', runClip);

const meshIrs = doc.meshes.filter((m) => m.meshIndex === 0);
const meshAsset = meshIrToMeshAsset(meshIrs);
assets.catalog(meshGuid, meshAsset);
const meshHandle = world.allocSharedRef('MeshAsset', meshAsset);
// feat-20260611 w17-a: smoke-dawn parallels the gltf-importer cooker by
// passing { skinned: true } so toMaterialAsset routes the emitted
// MaterialAsset to `forgeax::pbr-skin`. Fox.glb's only material is consumed
// exclusively by skinned primitives; main.ts (browser path) gets this for
// free via the cooker's auto-detection in gltf-importer.ts.
const matAsset = toMaterialAsset(doc.materials[0], { skinned: true });
assets.catalog(materialGuid, matAsset);
const matHandle = world.allocSharedRef('MaterialAsset', matAsset);

// tweak-20260611 M6: bridge auto-emits Skin { skeleton: <guid-string> } on
// every NodeIr with skinIndex set, so the demo no longer post-patches the
// scene to inject Skin (the previous workaround). _resolveSceneGuids
// resolves the GUID string to a runtime Handle at instantiate time.
// FALSIFY=no-skin: drop skeletonGuidBySkinIndex so the bridge does not emit
// Skin -> findSkinnedMember returns undefined per spawn -> smoke fails on
// the AC-09 multi-instance assertion below.
const bridgeCtx = {
  meshHandles: new Map([[0, meshHandle]]),
  materialHandles: new Map([[0, matHandle]]),
  ...(FALSIFY === 'no-skin'
    ? {}
    : { skeletonGuidBySkinIndex: new Map([[0, AssetGuid.format(skeletonGuid)]]) }),
};
const scene = gltfDocToSceneAsset(doc, bridgeCtx);
assets.catalog(sceneGuid, scene);

// --- 4. Build world: 3 instances + camera + light ------------------------------

const sceneRes = await assets.loadByGuid(sceneGuid);
if (!sceneRes.ok) {
  console.error('[smoke] FAIL - loadByGuid<SceneAsset> failed:', sceneRes.error);
  process.exit(1);
}
// loadByGuid returns the payload (D-17); mint a user-tier column handle reused
// across the 3 instantiate calls below.
const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);

// FALSIFY=clip-fixed: collapse the lineup to a single clip handle so the
// AC-03 distinct-poses assertion below trips. The smoke checks all three
// AnimationPlayer.clip handles are pairwise distinct -> exit !=0 with the
// clip-fixed mutation, exit 0 normally.
const clipLineup =
  FALSIFY === 'clip-fixed'
    ? [
        { x: -2.4, clip: surveyHandle, label: 'Survey' },
        { x: 0, clip: surveyHandle, label: 'Walk-as-Survey' },
        { x: 2.4, clip: surveyHandle, label: 'Run-as-Survey' },
      ]
    : [
        { x: -2.4, clip: surveyHandle, label: 'Survey' },
        { x: 0, clip: walkHandle, label: 'Walk' },
        { x: 2.4, clip: runHandle, label: 'Run' },
      ];
const lineup = clipLineup;
const perInstance = [];

// bug-20260615-skin-mesh-node-double-transform: parent all 3 Fox instances
// under a single non-identity rig. With the shader fix (M1), the skinned
// meshes rigid-follow the parent; without it, the parent transform doubles.
// pos y=1 lifts the Fox 1 unit upward, producing a visible pixel difference
// between parented and identity-parent modes at 200x150 resolution.
// FALSIFY=identity-parent: rig uses identity Transform -- the rendered
// full-frame hash must differ from the parented-baseline reference.
const parentRigTr =
  FALSIFY === 'identity-parent'
    ? { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]}
    : { pos: [0, 1, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]};
const parentRigRes = world.spawn({ component: Transform, data: parentRigTr });
if (!parentRigRes.ok) {
  console.error(`[smoke] FAIL - parent rig spawn failed: ${parentRigRes.error.code}`);
  process.exit(1);
}
const parentRig = parentRigRes.value;

for (const { x, clip, label } of lineup) {
  const instRes = assets.instantiate(sceneHandle, world);
  if (!instRes.ok) {
    console.error(`[smoke] FAIL - instantiate ${label}:`, instRes.error.code);
    process.exit(1);
  }
  const root = instRes.value;
  const tr = world.get(root, Transform);
  if (tr.ok) world.set(root, Transform, { ...tr.value, pos: [x, 0, 0]});
  else {
    console.error(`[smoke] FAIL - ${label} root has no Transform`);
    process.exit(1);
  }
  // bug-20260615-skin-mesh-node-double-transform: parent the Fox under the
  // non-identity rig so the skin path exercises the parented code path.
  world.addComponent(root, { component: ChildOf, data: { parent: parentRig } });
  const inst = world.get(root, SceneInstance);
  if (!inst.ok) {
    console.error(`[smoke] FAIL - get SceneInstance for ${label}:`, inst.error);
    process.exit(1);
  }
  let skinned;
  for (let i = 0; i < inst.value.mapping.length; i++) {
    const e = inst.value.mapping[i];
    if (e === 0) continue;
    const skinRes = world.get(e, Skin);
    if (skinRes.ok) {
      skinned = e;
      break;
    }
  }
  if (skinned === undefined) {
    console.error(`[smoke] FAIL - no Skin-bearing member in ${label} instance`);
    process.exit(1);
  }
  // M2 / w7: SoA inline arrays. Single-clip path (slot 0 active, slots 1..3
  // inactive) is the dawn-smoke equivalent of the legacy { clip, time, speed }
  // shape; the AC-03 distinct-clips assertion below still holds because each
  // instance writes a different handle into clips[0].
  world.set(skinned, AnimationPlayer, {
    clips: [clip, 0, 0, 0],
    times: new Float32Array([0, 0, 0, 0]),
    weights: new Float32Array([1, 0, 0, 0]),
    speeds: new Float32Array([1, 1, 1, 1]),
    paused: false,
    looping: true,
  });
  // tweak-20260611 M7: capture per-instance Skin entity + clip handle so the
  // post-loop AC-03 + AC-09 assertions can verify multi-instance isolation.
  perInstance.push({ label, root, skinned, clip });
}

// --- 4b. AC-03 distinct clips + AC-09 distinct skinned entities ----------------
//
// AC-09 (M5 subtree-scope): each spawn's skinned member must be a distinct
// entity. Without subtree-scope, all 3 instances would share instance-0's
// skinned mesh and the resolver would wire all Skin.joints[] to the same
// joint set; spawn ECS guarantees the entity ids differ post-instantiate so
// this is a fast structural check (the joint isolation itself is unit-tested
// in packages/runtime/src/scene-instances/__tests__/post-spawn-resolve-joints.unit.test.ts).
const skinnedEntityIds = perInstance.map((p) => p.skinned);
if (
  skinnedEntityIds[0] === skinnedEntityIds[1] ||
  skinnedEntityIds[1] === skinnedEntityIds[2] ||
  skinnedEntityIds[0] === skinnedEntityIds[2]
) {
  console.error(
    `[smoke] FAIL - AC-09: instances share skinned entity ids ${JSON.stringify(skinnedEntityIds)} (subtree-scope regression)`,
  );
  process.exit(1);
}
// AC-03 distinct clips: the three AnimationPlayer.clip handles must be
// pairwise distinct -> three foxes animate independently. FALSIFY=clip-fixed
// collapses the lineup to one clip and trips this assertion.
const clipHandleNumbers = perInstance.map((p) => Number(p.clip));
const allClipsDistinct =
  clipHandleNumbers[0] !== clipHandleNumbers[1] &&
  clipHandleNumbers[1] !== clipHandleNumbers[2] &&
  clipHandleNumbers[0] !== clipHandleNumbers[2];
if (!allClipsDistinct) {
  console.error(
    `[smoke] FAIL - AC-03: AnimationPlayer.clip handles not pairwise distinct ${JSON.stringify(clipHandleNumbers)} (collapsed lineup)`,
  );
  process.exit(1);
}

world.spawn(
  {
    component: Transform,
    data: { pos: [0, 1.2, 6], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
  },
  { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
);
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 1 },
});

const animResolver = createAnimationAssetResolver(assets);
registerAdvanceAnimationPlayer(world, animResolver);

// --- 5. Render loop + pixel readback -------------------------------------------

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const TARGET_FRAMES = Math.max(SMOKE_MIN_FRAMES, Math.ceil(SMOKE_DURATION_MS / 16.67));
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}

const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
const readbackBuffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
{
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
}
try {
  await readbackBuffer.mapAsync(0x01);
} catch (err) {
  console.error(`[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const mapped = readbackBuffer.getMappedRange();
const bytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  return {
    r: (bytes[off + 2] ?? 0) / 255,
    g: (bytes[off + 1] ?? 0) / 255,
    b: (bytes[off + 0] ?? 0) / 255,
  };
};

const sites = [
  { name: 'center', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'leftFox', x: Math.floor(WIDTH * 0.25), y: Math.floor(HEIGHT / 2) },
  { name: 'rightFox', x: Math.floor(WIDTH * 0.75), y: Math.floor(HEIGHT / 2) },
  { name: 'upperLeft', x: Math.floor(WIDTH * 0.3), y: Math.floor(HEIGHT * 0.3) },
  { name: 'upperRight', x: Math.floor(WIDTH * 0.7), y: Math.floor(HEIGHT * 0.3) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
  { name: 'cornerBR', x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.95) },
];

const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

// --- 6. Verdict (6 criteria + M4 AC-02 counter-proof) ---------------------------

const distance = (a, b) =>
  Math.sqrt((a.r - b[0]) ** 2 + (a.g - b[1]) ** 2 + (a.b - b[2]) ** 2);

const meshSites = ['center', 'leftFox', 'rightFox'];
let meshedRenderCount = 0;
const perSiteDistance = {};
for (const name of meshSites) {
  const site = pixelSamples[name];
  const dist = distance(site, [0.05, 0.05, 0.08]);
  perSiteDistance[name] = dist.toFixed(4);
  if (dist > SMOKE_PIXEL_THRESHOLD) meshedRenderCount++;
}
console.log(`[smoke] perSiteDistance=${JSON.stringify(perSiteDistance)}`);

let nanFound = false;
for (const s of sites) {
  const c = pixelSamples[s.name];
  if (Number.isNaN(c.r) || Number.isNaN(c.g) || Number.isNaN(c.b)) {
    nanFound = true;
    break;
  }
}

const failures = [];
if (renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedRenderCount < 1)
  failures.push(
    `(c) zero meshed sites above threshold=${SMOKE_PIXEL_THRESHOLD} from clear color; perSiteDistance=${JSON.stringify(perSiteDistance)}`,
  );
if (nanFound)
  failures.push('(d) NaN pixel value detected in readback samples');
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(e) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

// feat-20260612-skin-palette-per-frame-upload M4 / m4-4: AC-01 dawn-node
// equivalent fallback. The browser smoke (smoke-browser.mjs) is the
// primary AC-01 gate; this probe catches a dawn-only regression in the
// skin-palette per-frame upload chain. Sample window >=3 distinct
// fullHash values; FALSIFY anchor: short-circuit writeJointPalette to
// identity -> distinctness collapses to 1 -> probe red.
const skinPaletteHitsDawn = skinPaletteWritesDawn.length;
const skinPaletteFullHashSetDawn = new Set(skinPaletteWritesDawn.map((w) => w.fullHash));
console.log(
  `[smoke] m4-4 skin-palette writes=${skinPaletteHitsDawn} distinctFullHash=${skinPaletteFullHashSetDawn.size} sample=[${[...skinPaletteFullHashSetDawn].slice(0, 4).join(',')}]`,
);
if (skinPaletteHitsDawn < 3) {
  failures.push(
    `(f) m4-4 skin-palette writeBuffer hit count=${skinPaletteHitsDawn} (need >=3); SkinPaletteAllocator buffer never created or write hook never engaged`,
  );
}
if (skinPaletteFullHashSetDawn.size < 2) {
  failures.push(
    `(f) m4-4 skin-palette payload distinctness=${skinPaletteFullHashSetDawn.size} (need >=2); palette frozen across frames -- writeJointPalette short-circuit or upstream Transform.world propagation failure`,
  );
}

// bug-20260615 M4 AC-02 counter-proof (palette-hash structural assertion).
// The parented-rig (pos y=1) palette hashes differ from the identity-parent
// palette hashes. The parented-mode reference set (pos y=1):
//   {c72b7794, bfe6ce5c, 7d92e658}
// The FALSIFY=identity-parent mode produces a different set:
//   {05dba7cc, b8f254fc, 7cbb03c9}
// This gate asserts: identity-parent mode palette hashes MUST NOT match
// the parented-mode reference. A match means the parent transform is NOT
// load-bearing (parent change has no effect on palette) -- AC-02 failed.
const PARENTED_PALETTE_REF = new Set(['c72b7794', 'bfe6ce5c', '7d92e658']);
if (FALSIFY === 'identity-parent') {
  const identitySet = skinPaletteFullHashSetDawn;
  const matchesParented = identitySet.size === PARENTED_PALETTE_REF.size &&
    [...identitySet].every((h) => PARENTED_PALETTE_REF.has(h));
  if (matchesParented) {
    failures.push(
      `(g) M4 AC-02 counter-proof FAILED: identity-parent palette hash set ${JSON.stringify([...identitySet].sort())} matches parented reference ${JSON.stringify([...PARENTED_PALETTE_REF].sort())}; parent transform is NOT load-bearing`,
    );
  } else {
    console.log(
      `[smoke] M4 AC-02 counter-proof GREEN: identity-parent palette set=${JSON.stringify([...identitySet].sort())} != parented ref=${JSON.stringify([...PARENTED_PALETTE_REF].sort())}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    `  rerun: SMOKE_DURATION_MS=${SMOKE_DURATION_MS * 2} pnpm --filter @forgeax/hello-skin smoke`,
  );
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, meshed sites above threshold=${meshedRenderCount}/${meshSites.length}, NaN=0, RhiError count=0, palette writes=${skinPaletteHitsDawn} (${skinPaletteFullHashSetDawn.size} distinct)`,
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
