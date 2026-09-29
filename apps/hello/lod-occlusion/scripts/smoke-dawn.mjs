#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupGpuShim } from '../../triangle/scripts/smoke-helpers.mjs';
import { emitSmokeReceipt, smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';
// setupGpuShim owns the direct dawn-node WebGPU backend for this smoke.

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const distRoot = resolve(appRoot, 'dist');
const frames = Math.max(smokeFrameBudget(), smokeFrameBudget(process.env.LOD_SMOKE_FRAMES));
if (!existsSync(resolve(distRoot, 'pack-index.json'))) {
  console.error('[hello-lod-occlusion] FAIL - missing dist/pack-index.json; run build first');
  process.exit(1);
}

const packIndexText = readFileSync(resolve(distRoot, 'pack-index.json'), 'utf8');
const packIndex = JSON.parse(packIndexText);
const packageFiles = new Map(packIndex.map((entry) => [entry.packageUrl, resolve(distRoot, entry.packageUrl.slice(1))]));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (request) => {
  const url = new URL(typeof request === 'string' ? request : request.url, 'http://127.0.0.1');
  if (url.pathname === '/pack-index.json') return new Response(packIndexText);
  const packageFile = packageFiles.get(url.pathname);
  if (packageFile !== undefined) return new Response(readFileSync(packageFile));
  const assetFile = resolve(distRoot, url.pathname.slice(1));
  if (existsSync(assetFile)) return new Response(readFileSync(assetFile));
  return originalFetch(request);
};

const shim = await setupGpuShim({
  width: 200,
  height: 150,
  rerunCmd: 'pnpm --filter @forgeax/hello-lod-occlusion smoke',
});
const manifest = readFileSync(resolve(distRoot, 'shaders/manifest.json'), 'utf8');
const { createWorldContext, World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, renderComponentsPlugin } = await import('@forgeax/engine-render');
const { scenePlugin, Transform } = await import('@forgeax/engine-scene');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(shim.mockCanvas, {}, {
    shaderManifestUrl: `data:application/json,${encodeURIComponent(manifest)}`,
  });
  if (!constructed.ok) throw constructed.error;
  const { assets } = constructed.value;
  renderer = constructed.value.renderer;
  assets.configurePackIndex('/pack-index.json');
  const world = new World();
  await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
  const meta = JSON.parse(readFileSync(resolve(appRoot, 'assets/lod-scene.gltf.meta.json'), 'utf8'));
  const sceneGuidText = meta.subAssets.find((entry) => entry.kind === 'scene')?.guid;
  const sceneGuid = AssetGuid.parse(sceneGuidText ?? '');
  if (!sceneGuid.ok) throw new Error('LOD sidecar has no valid scene GUID');
  const scene = await assets.loadByGuid(sceneGuid.value);
  if (!scene.ok) throw new Error(`scene load failed: ${scene.error.code}`);
  const rootGuidText = meta.subAssets.find((entry) => entry.kind === 'mesh' && entry.sourceIndex === 0)?.guid;
  const rootGuid = AssetGuid.parse(rootGuidText ?? '');
  if (!rootGuid.ok) throw new Error('LOD sidecar has no valid root mesh GUID');
  const rootMesh = await assets.loadByGuid(rootGuid.value);
  if (!rootMesh.ok) throw new Error(`root mesh load failed: ${rootMesh.error.code}`);
  if (!Array.isArray(rootMesh.value.lods) || rootMesh.value.lods.length !== 2) {
    throw new Error(`root mesh LOD metadata missing after Pack load: ${JSON.stringify(Object.keys(rootMesh.value))}`);
  }
  // The production GPU-driven lane owns opaque Standard PBR bindings on the
  // directional-only scene-index path. Keep the imported MeshAsset/LOD refs
  // as the geometry source of truth while using a small authored Standard PBR
  // material for this lane smoke.
  const rootMeshHandle = world.allocSharedRef('MeshAsset', rootMesh.value);
  const materialHandle = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.2, 0.6, 0.95, 1], roughness: 0.5 }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0] } },
    { component: MeshFilter, data: { assetHandle: rootMeshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();
  world.spawn(
    // Keep the smoke camera on the same verified LOD1 boundary as the
    // interactive demo. The generated sphere is larger than the old fixture,
    // so 12m correctly remains LOD0 instead of exercising a lower level.
    { component: Transform, data: { pos: [0, 0, 20] } },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 4 / 3, near: 0.1, far: 100 } },
  ).unwrap();
  // Imported glTF scene has no light; provide a real directional component so
  // the Standard PBR environment path remains exercised.
  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.5, -1, -0.3], intensity: 2, castShadow: false },
  }).unwrap();
  // Attach only after the initial render vocabulary exists. The persistent
  // renderer projection consumes the attachment's change cursor as its first
  // snapshot; attaching an empty world would otherwise make the first later
  // spawns invisible to the rigid incremental path.
  const attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  const frameRequest = {
    leases: [attachment.value],
    camera: { lease: attachment.value },
    environment: { lease: attachment.value },
  };

  let submittedFrames = 0;
  let lastReceipt;
  let lastInspection;
  for (let frame = 0; frame < frames; frame += 1) {
    world.update().unwrap();
    const drawn = renderer.draw(frameRequest);
    if (!drawn.ok) throw new Error(`renderer draw failed: ${drawn.error.code}`);
    lastReceipt = drawn.value;
    await shim.sharedDevice.queue.onSubmittedWorkDone();
    lastInspection = renderer.inspect();
    submittedFrames += 1;
  }
  if (lastReceipt !== undefined) {
    const observed = await renderer.observe(lastReceipt, { include: [] });
    if (!observed.ok) throw new Error(`renderer LOD telemetry observation failed: ${observed.error.code}`);
    lastInspection = renderer.inspect();
  }
  const lodOcclusion = lastInspection?.lodOcclusion;
  if (lodOcclusion === undefined) throw new Error('renderer did not publish LOD inspection');
  if (lodOcclusion.count.candidates <= 0 || lodOcclusion.count.visible <= 0) {
    throw new Error(`renderer LOD inspection has no real scene candidates: ${JSON.stringify(lastInspection)}`);
  }
  const mainGpuChannel = lastInspection.renderScene?.gpuDriven?.channels?.find(
    (channel) => channel.viewPass === 'main',
  );
  if (mainGpuChannel?.lane !== 'gpu' || mainGpuChannel.drawCount <= 0) {
    throw new Error(`renderer did not submit the main GPU-driven lane: ${JSON.stringify(mainGpuChannel)}`);
  }
  if (!lodOcclusion.lodHistogram.some((row) => row.level > 0 && row.count > 0)) {
    throw new Error(`renderer did not select a lower-detail level: ${JSON.stringify(lodOcclusion)}`);
  }
  if (!lastInspection.output.graphPassNames.includes('gpu-driven.frustum-compact')) {
    throw new Error('renderer did not include the GPU-driven LOD graph passes');
  }
  const passNames = lastInspection.output.graphPassNames;
  const lateOcclusion = passNames.includes('gpu-driven.occlusion-cull') && passNames.includes('main-late');
  if (lateOcclusion !== (lastInspection.capabilities.firstInstanceIndirect === true)) {
    throw new Error(`two-phase GPU occlusion must follow firstInstanceIndirect: ${JSON.stringify(passNames)}`);
  }
  console.log(`[hello-lod-occlusion] backend=${lastInspection.capabilities.backendKind} frames=${submittedFrames} candidates=${lodOcclusion.count.candidates} visible=${lodOcclusion.count.visible} lod=${JSON.stringify(lodOcclusion.lodHistogram)} lateOcclusion=${lateOcclusion}`);
  emitSmokeReceipt('hello-lod-occlusion/smoke', submittedFrames);
} finally {
  if (renderer !== undefined) {
    const disposed = await renderer.dispose();
    if (!disposed.ok) console.error(`[hello-lod-occlusion] renderer dispose failed: ${disposed.error.code}`);
  }
  shim.renderTarget?.destroy?.();
  shim.sharedDevice?.destroy?.();
  delete globalThis.navigator.gpu;
}
