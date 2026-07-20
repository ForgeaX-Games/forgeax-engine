// bevy-transform headless dawn smoke — reproduces Bevy's transform World in
// node-dawn. A white cube translates forward, slerps toward the central yellow
// sphere, and shrinks that sphere according to travel distance. The smoke proves
// render motion and the same Transform state semantics that the browser app uses.
//
// The shared src/transform.ts builder and step are imported through Node's TS
// type stripping, so the browser app and smoke cannot drift into separate scenes.
// It writes early/late PNGs for the mandatory visual review.
//
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const MOTION_THRESHOLD = Number.parseFloat(process.env.SMOKE_MOTION_THRESHOLD ?? '0.0005');
const WIDTH = 320;
const HEIGHT = 180;
const FIXED_DT = 1 / 60;

// --- dawn.node binding setup ---
let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
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
  console.error(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// --- mock canvas + offscreen render target ---
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

// --- build the Transform World via the shared SSOT builder ---
const { World, createQueryState, Entity, queryRun } = await import('@forgeax/engine-ecs');
const { Transform, createRenderer, propagateTransforms } = await import('@forgeax/engine-runtime');

const here = dirname(fileURLToPath(import.meta.url));
const { buildTransformWorld, CenterSphere, Orbiting, orbitDistance, stepTransform } = await import(resolve(here, '..', 'src', 'transform.ts'));

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
}
console.log(`[bevy-transform] backend=${renderer.backend}`);

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const world = new World();
buildTransformWorld(world);

// --- readback helper (copy renderTarget → mapped buffer → tight RGBA) ---
const bytesPerPixel = 4;
const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
async function capture(device) {
  await device.queue.onSubmittedWorkDone();
  const readbackBuffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await readbackBuffer.mapAsync(0x01);
  const raw = new Uint8Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  return tight;
}

// --- drive the shared Transform step and capture motion ---
const CAPTURE_EARLY = Math.max(1, Math.floor(SMOKE_MIN_FRAMES * 0.05));
const CAPTURE_LATE = Math.max(CAPTURE_EARLY + 1, Math.floor(SMOKE_MIN_FRAMES * 0.65));
const centerState = createQueryState({ with: [Transform, CenterSphere, Entity] });
const orbitState = createQueryState({ with: [Transform, Orbiting, Entity] });
let framesObserved = 0;
let earlyFrame;
let lateFrame;
let earlyDistance = Number.NaN;
let earlyQuat;
let finalQuat;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
  if (i === CAPTURE_EARLY) {
    earlyFrame = await capture(sharedDevice);
    earlyDistance = orbitDistance(world);
    queryRun(orbitState, world, (bundle) => {
      const handle = bundle.Entity.self[0];
      if (handle === undefined) return;
      const transform = world.get(handle, Transform);
      if (transform.ok) earlyQuat = Array.from(transform.value.quat);
    });
  }
  if (i === CAPTURE_LATE) lateFrame = await capture(sharedDevice);
  stepTransform(world, FIXED_DT);
  propagateTransforms(world);
}
let finalCenterScale;
queryRun(centerState, world, (bundle) => {
  const handle = bundle.Entity.self[0];
  if (handle === undefined) return;
  const transform = world.get(handle, Transform);
  if (transform.ok) finalCenterScale = Array.from(transform.value.scale);
});
const finalDistance = orbitDistance(world);
queryRun(orbitState, world, (bundle) => {
  const handle = bundle.Entity.self[0];
  if (handle === undefined) return;
  const transform = world.get(handle, Transform);
  if (transform.ok) finalQuat = Array.from(transform.value.quat);
});
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
console.log(`[smoke] frames observed=${framesObserved} (target=${SMOKE_MIN_FRAMES})`);

if (!earlyFrame || !lateFrame) {
  console.error('[smoke] FAIL - capture frames not taken (renderTarget never allocated?)');
  process.exit(1);
}

// --- pixel samples + motion delta ---
const readRgba = (buf, px, py) => {
  const off = (py * WIDTH + px) * 4;
  return [(buf[off] ?? 0) / 255, (buf[off + 1] ?? 0) / 255, (buf[off + 2] ?? 0) / 255];
};
// The central sphere stays near frame center, so the early center sample proves the lit scene is present.
const ndcCenter = readRgba(earlyFrame, Math.floor(WIDTH / 2), Math.floor(HEIGHT / 2));
const corner = readRgba(earlyFrame, Math.floor(WIDTH * 0.05), Math.floor(HEIGHT * 0.05));
console.log(`[smoke] pixelSamples=${JSON.stringify({ ndcCenter, corner })}`);

let sum = 0;
for (let i = 0; i < earlyFrame.length; i++) sum += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
const motionMeanDelta = sum / earlyFrame.length / 255;
console.log(`[smoke] motionMeanDelta=${motionMeanDelta.toFixed(5)} (threshold ${MOTION_THRESHOLD})`);
console.log(`[smoke] orbitDistance=${finalDistance.toFixed(4)} centerScale=${JSON.stringify(finalCenterScale)}`);

// --- dump both PNGs so the loop eyeballs orbit motion + compares to Bevy ---
try {
  const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
  mkdirSync(outDir, { recursive: true });
  const earlyOut = resolve(outDir, 'frame-early.png');
  const lateOut = resolve(outDir, 'frame-late.png');
  writeFileSync(earlyOut, writeReferencePng(earlyFrame, WIDTH, HEIGHT));
  writeFileSync(lateOut, writeReferencePng(lateFrame, WIDTH, HEIGHT));
  console.log(`[smoke] wrote PNG=${earlyOut}`);
  console.log(`[smoke] wrote PNG=${lateOut}`);
} catch (err) {
  console.warn(`[smoke] (non-fatal) PNG dump skipped: ${err instanceof Error ? err.message : String(err)}`);
}

const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const dist = distance(ndcCenter, [0, 0, 0]);

const failures = [];
if (renderer.backend !== 'webgpu') failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (dist <= SMOKE_PIXEL_THRESHOLD) {
  failures.push(`(c) NDC-center ${JSON.stringify(ndcCenter)} too close to black (dist ${dist.toFixed(4)} <= ${SMOKE_PIXEL_THRESHOLD}) — center sphere not visible`);
}
if (motionMeanDelta <= MOTION_THRESHOLD) {
  failures.push(`(d) motionMeanDelta ${motionMeanDelta.toFixed(5)} <= ${MOTION_THRESHOLD} — scene did NOT visibly orbit`);
}
const centerUniform = finalCenterScale?.every((value) => Math.abs(value - (finalCenterScale?.[0] ?? 0)) < 1e-5) ?? false;
const centerShrank = (finalCenterScale?.[0] ?? 1) < 0.99;
const rotationChanged = earlyQuat?.some((value, index) => Math.abs(value - (finalQuat?.[index] ?? value)) > 1e-3) ?? false;
if (!(finalDistance > earlyDistance + 0.5) || !centerUniform || !centerShrank || !rotationChanged) {
  failures.push(`(e) transform state invalid: earlyDistance=${earlyDistance} finalDistance=${finalDistance} centerScale=${JSON.stringify(finalCenterScale)} uniform=${centerUniform} rotationChanged=${rotationChanged}`);
}
if (errors.length > 0) failures.push(`(f) Renderer.onError fired ${errors.length}x: [${errors.map((e) => e.code).join(', ')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - 6 criteria GREEN: backend=webgpu, frames=${framesObserved}, centerVisible=${dist.toFixed(4)}, motionMeanDelta=${motionMeanDelta.toFixed(5)}, orbit+centerScale OK, RhiError count=0`);
device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
