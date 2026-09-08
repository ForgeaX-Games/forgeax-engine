import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { create, globals } = await import('webgpu');
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
let device;
let target;
const WIDTH = 320;
const HEIGHT = 180;
const canvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        target ??= device.createTexture({
          size: { width: WIDTH, height: HEIGHT },
          format: desc.format ?? 'rgba8unorm',
          usage: 0x11,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() {
        return target;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};
const here = dirname(fileURLToPath(import.meta.url));
const manifest = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifest, 'utf8'))}`;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (!adapter) return adapter;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    device = await requestDevice(descriptor);
    return device;
  };
  return adapter;
};

const { createRenderer } = await import('@forgeax/engine-runtime');
const { World } = await import('@forgeax/engine-ecs');
const renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: manifestUrl });
if (rendererBackend(renderer) !== 'webgpu') throw new Error(`[smoke] backend=${rendererBackend(renderer)}`);
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const example = await import(resolve(here, '..', 'src', 'entity-disabling.ts'));
const state = example.buildEntityDisablingWorld(world);
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error.code));
let disabledSnapshot;
for (let frame = 0; frame < 180; frame += 1) {
  world.update(0.016).unwrap();
  if (frame === 40) disabledSnapshot = example.readEntityDisablingState(world, state);
  const draw = drawSmokeFrame(renderer, world);
  if (!draw.ok) throw new Error(`[smoke] draw=${draw.error.code}`);
}
const snapshot = example.readEntityDisablingState(world, state);
console.log(`[smoke] disabled=${JSON.stringify(disabledSnapshot)}`);
console.log(`[smoke] final=${JSON.stringify(snapshot)}`);
if (
  !disabledSnapshot ||
  disabledSnapshot.transition !== 'disabled' ||
  disabledSnapshot.activeCount !== 2 ||
  disabledSnapshot.disabledCount !== 1
) {
  throw new Error(`disabled state mismatch: ${JSON.stringify(disabledSnapshot)}`);
}
if (
  snapshot.transition !== 'reenabled' ||
  snapshot.activeCount !== 3 ||
  snapshot.disabledCount !== 0 ||
  errors.length > 0
) {
  throw new Error(`final state mismatch: ${JSON.stringify(snapshot)}, errors=${errors.join(',')}`);
}
console.log('[smoke] PASS - default queries hide Disabled and explicit query re-enables the target');
device?.destroy?.();
