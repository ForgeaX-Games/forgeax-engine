#!/usr/bin/env node
// bevy-tonemapping headless dawn smoke (structural-only).
//   (a) backend=webgpu (b) frames >= SMOKE_MIN_FRAMES (c) Renderer.onError count == 0

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const WIDTH = 200, HEIGHT = 150;

let create, globals;
try { ({ create, globals } = await import('webgpu')); } catch (err) {
  console.error(`[smoke] FAIL - dawn.node import`); process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try { gpu = create([]); } catch { console.error('[smoke] FAIL - create([])'); process.exit(1); }
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const origReqAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const a = await origReqAdapter(opts); if (a === null) return a;
  const origDev = a.requestDevice.bind(a);
  a.requestDevice = async (d) => { const dev = await origDev(d); sharedDevice ||= dev; return dev; };
  return a;
};

let rt;
const mockCanvas = { width: WIDTH, height: HEIGHT, getContext(k) {
  if (k !== 'webgpu') return null;
  return { configure(d) { rt ||= d.device.createTexture({ size: { width: WIDTH, height: HEIGHT }, format: d.format ?? 'rgba8unorm', usage: 0x10 | 0x01, viewFormats: ['rgba8unorm-srgb'] }); }, unconfigure() {}, getCurrentTexture() { if (!rt) { if (!sharedDevice) throw new Error('no device'); rt = sharedDevice.createTexture({ size: { width: WIDTH, height: HEIGHT }, format: 'rgba8unorm', usage: 0x10 | 0x01, viewFormats: ['rgba8unorm-srgb'] }); } return rt; } };
}, addEventListener() {}, removeEventListener() {} };

const { World } = await import('@forgeax/engine-ecs');
const { createBoxGeometry, createSphereGeometry } = await import('@forgeax/engine-geometry');
const { Camera, createRenderer, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective, TONEMAP_AGX, Transform } = await import('@forgeax/engine-runtime');
const world = new World();
const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(resolve(here, '..', 'dist', 'shaders', 'manifest.json'), 'utf8'))}`;

let renderer;
try { renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL }); }
catch (err) { console.error(`[smoke] FAIL - createRenderer: ${err.message}`); process.exit(1); }
finally { globalThis.navigator.gpu.requestAdapter = origReqAdapter; }
console.log(`[tonemapping] backend=${renderer.backend}`);
const errors = []; renderer.onError((e) => errors.push(e));
if (!(await renderer.ready).ok) { console.error('[smoke] FAIL - renderer.ready'); process.exit(1); }

const cube = createBoxGeometry(1, 1, 1, 1, 1, 1); if (!cube.ok) { console.error('cube fail'); process.exit(1); }
const sphere = createSphereGeometry(0.5, 32, 16); if (!sphere.ok) { console.error('sphere fail'); process.exit(1); }
const cH = world.allocSharedRef('MeshAsset', cube.value);
const sH = world.allocSharedRef('MeshAsset', sphere.value);
const mat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.8, 0.7, 0.6, 1], metallic: 0, roughness: 0.4 }));
world.spawn({ component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } }, { component: MeshFilter, data: { assetHandle: sH } }, { component: MeshRenderer, data: { materials: [mat] } });
world.spawn({ component: Transform, data: { pos: [1.5, 0, 0], quat: [0, 0, 0, 1], scale: [0.8, 0.8, 0.8] } }, { component: MeshFilter, data: { assetHandle: cH } }, { component: MeshRenderer, data: { materials: [mat] } });
world.spawn({ component: DirectionalLight, data: { direction: [-0.4, -0.6, -0.7], color: [1, 1, 1], intensity: 2 } });
world.spawn({ component: Transform, data: { pos: [0, 0, 6] } }, { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT }), tonemap: TONEMAP_AGX } });

const TARGET = Math.max(SMOKE_MIN_FRAMES, Math.ceil(SMOKE_DURATION_MS / 16.67));
let n = 0;
for (let i = 0; i < TARGET; i++) { renderer.draw([world], { owner: 0 }); n++; }
const dev = sharedDevice; if (dev) await dev.queue.onSubmittedWorkDone();
console.log(`[smoke] frames observed=${n}`);

const fail = [];
if (renderer.backend !== 'webgpu') fail.push(`(a) backend=${renderer.backend}`);
if (n < SMOKE_MIN_FRAMES) fail.push(`(b) frames=${n} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) fail.push(`(c) RhiError count=${errors.length}`);
if (fail.length > 0) { console.error(`[smoke] FAIL: ${fail.join('; ')}`); process.exit(1); }
console.log(`[smoke] PASS - backend=webgpu, frames=${n}, RhiError count=0`);
dev?.destroy?.(); delete globalThis.navigator.gpu; process.exit(0);