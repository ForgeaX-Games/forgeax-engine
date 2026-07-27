#!/usr/bin/env node
// Headless structural smoke for play_sound_effect.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDTH = 200;
const HEIGHT = 150;
const MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const { create, globals } = await import('webgpu');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });

let sharedDevice;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (!adapter) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const device = await originalRequestDevice(descriptor);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let target;
function ensureTarget(device, format) {
  target ??= device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return target;
}
const canvas = {
  tagName: 'CANVAS', isConnected: true, width: WIDTH, height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) { ensureTarget(desc.device, desc.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() { if (!target) ensureTarget(sharedDevice, 'rgba8unorm'); return target; },
    };
  },
  addEventListener() {}, removeEventListener() {},
};

const { createApp } = await import('@forgeax/engine-app');
const { AUDIO_ENGINE_RESOURCE_KEY } = await import('@forgeax/engine-audio');
const { audioPlugin } = await import('@forgeax/engine-audio-webaudio');
const { buildPlaySoundEffectWorld } = await import('../src/play-sound-effect.ts');
const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const shaderManifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const appResult = await createApp(canvas, { plugins: [audioPlugin()] }, { shaderManifestUrl });
gpu.requestAdapter = originalRequestAdapter;
if (!appResult.ok) throw new Error(`createApp failed: ${appResult.error.code}`);
const app = appResult.value;
const ready = await app.renderer.ready;
if (!ready.ok) throw new Error(`renderer.ready failed: ${ready.error.code}`);
const scene = buildPlaySoundEffectWorld(app.world, WIDTH / HEIGHT);
const errors = [];
app.onError((error) => errors.push(error));
let frames = 0;
let drawErrors = 0;
for (; frames < MIN_FRAMES; frames += 1) {
  const result = app.renderer.draw([app.world], { owner: 0 });
  if (!result.ok) drawErrors += 1;
}
const hasAudioEngine = app.world.hasResource(AUDIO_ENGINE_RESOURCE_KEY);
console.log(`[play-sound-effect] backend=${app.renderer.backend} frames=${frames} audioResource=${hasAudioEngine} camera=${scene.camera} target=${scene.target} anchor=${scene.audioAnchor}`);
const failures = [];
if (app.renderer.backend !== 'webgpu') failures.push(`backend=${app.renderer.backend}`);
if (frames < MIN_FRAMES) failures.push(`frames=${frames} < ${MIN_FRAMES}`);
if (!hasAudioEngine) failures.push('AudioEngine resource missing');
if (drawErrors > 0) failures.push(`draw errors=${drawErrors}`);
if (errors.length > 0) failures.push(`Renderer.onError=${errors.map((error) => error.code).join(',')}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  sharedDevice?.destroy?.();
  process.exit(1);
}
console.log('[smoke] PASS - structural audio resource, trigger scene, 300 draws, and RHI error gates are green.');
sharedDevice?.destroy?.();
delete globalThis.navigator.gpu;
