#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const { create, globals } = await import('webgpu');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });

let rafQueue = [];
let rafId = 1;
globalThis.requestAnimationFrame = (callback) => { const id = rafId++; rafQueue.push({ id, callback }); return id; };
globalThis.cancelAnimationFrame = (id) => { rafQueue = rafQueue.filter((frame) => frame.id !== id); };
let device;
let target;
const canvas = {
  tagName: 'CANVAS', isConnected: true, width: 800, height: 600,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure({ device: nextDevice }) {
        device = nextDevice;
        target ??= device.createTexture({
          size: { width: 800, height: 600 },
          format: 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() { return target; },
    };
  },
  addEventListener() {}, removeEventListener() {},
};

const { createApp } = await import('@forgeax/engine-app');
const { buildCapstoneScene } = await import(resolve(root, 'apps/hello/m8-integrated-capstone/src/scene.ts'));
const { physicsPlugin } = await import('@forgeax/engine-physics');
const manifestPath = resolve(root, 'apps/hello/m8-integrated-capstone/dist/shaders/manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const result = await createApp(canvas, { plugins: [physicsPlugin('rapier-3d')] }, { shaderManifestUrl: manifestUrl });
if (!result.ok) throw new Error(`M8 Dawn createApp failed: ${result.error.code}`);
const app = result.value;
const scene = buildCapstoneScene(app.world);
const fixedTicks = { value: 0 };
const { FixedUpdate } = await import('@forgeax/engine-ecs');
app.world.addSystem(FixedUpdate, { name: 'm8-dawn-fixed-oracle', queries: [], fn: () => { fixedTicks.value += 1; } }).unwrap();
const errors = [];
app.onError((error) => errors.push({ code: error.code, hint: error.hint, detail: error.detail }));
if (!(await app.renderer.ready).ok) throw new Error('M8 Dawn renderer.ready failed');
const originalNow = globalThis.performance.now.bind(globalThis.performance);
let fakeNow = 0;
globalThis.performance.now = () => fakeNow;
const started = app.start();
if (!started.ok) throw new Error(`M8 Dawn app.start failed: ${started.error.code}`);
for (let i = 0; i < 120; i++) {
  const frame = rafQueue.shift();
  if (!frame) break;
  fakeNow += 16.67;
  frame.callback(fakeNow);
}
globalThis.performance.now = originalNow;
const actor = app.world.get(scene.actor, (await import('@forgeax/engine-scene')).Transform);
const entities = app.world.inspect().entityCount;
if (!actor.ok || fixedTicks.value < 30 || entities < 6 || errors.length > 0) {
  throw new Error(`M8 Dawn shared-scene oracle failed: ${JSON.stringify({ fixedTicks: fixedTicks.value, entities, actorY: actor.ok ? actor.value.pos[1] : null, errors })}`);
}
const stopped = app.stop();
if (!stopped.ok) throw new Error(`M8 Dawn app.stop failed: ${stopped.error.code}`);
console.log(`[m8-capstone] Dawn shared-scene journey: PASS entities=${entities} fixed=${fixedTicks.value} actorY=${actor.value.pos[1]}`);
delete globalThis.navigator.gpu;
process.exit(0);
