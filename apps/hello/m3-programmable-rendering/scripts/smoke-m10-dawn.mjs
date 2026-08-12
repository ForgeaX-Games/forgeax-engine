#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { World } from '@forgeax/engine-ecs';
import { Camera, RenderFeatureStageFailedError } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { createRenderer } from '@forgeax/engine-runtime';
import { err, ok } from '@forgeax/engine-types';

const WIDTH = 64;
const HEIGHT = 64;
const COPY_SRC = 0x01;
const COPY_DST = 0x08;
const MAP_READ = 0x0001;
const RENDER_ATTACHMENT = 0x10;
const artifactDir = process.env.FORGEAX_M10_ARTIFACT_DIR ?? resolve(process.cwd(), '.forgeax-gauntlet', 'm10-render-feature');
mkdirSync(artifactDir, { recursive: true });

const { create, globals } = await import('webgpu');
Object.assign(globalThis, globals);
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
}
const gpu = create([]);
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });

const deviceRef = { value: undefined };
const targetRef = { value: undefined };
const canvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        deviceRef.value = descriptor.device;
        targetRef.value = descriptor.device.createTexture({
          size: { width: WIDTH, height: HEIGHT },
          format: descriptor.format ?? 'rgba8unorm',
          usage: RENDER_ATTACHMENT | COPY_SRC,
          ...(descriptor.format === 'rgba8unorm'
            ? { viewFormats: ['rgba8unorm-srgb'] }
            : {}),
        });
      },
      unconfigure() {},
      getCurrentTexture() {
        if (targetRef.value === undefined) throw new Error('M10 Dawn target is not configured');
        return targetRef.value;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const manifest = await buildEngineShaderManifest();
const manifestUrl = `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;

function world() {
  const value = new World();
  value.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
  );
  return value;
}

function feature(identity, faultState) {
  let pipeline;
  let viewBindings;
  let inputBindings;
  let vertices;
  const feature = {
    identity,
    extract: () => ok({ draw: true }),
    prepare: (_data, context) => {
      if (faultState.fault === 'create' && !faultState.repaired) {
        return err(new RenderFeatureStageFailedError(identity, 1, 'prepare', 'next-frame'));
      }
      const pipelineResult = context.graphics.preparePipeline('forward', {
        shader: 'forgeax::tonemap',
        vertexLayout: 'position',
        colorFormats: ['rgba8unorm-srgb'],
      });
      if (!pipelineResult.ok) return pipelineResult;
      const viewResult = context.graphics.prepareBindings('forward', {
        pipeline: pipelineResult.value,
        values: {},
      });
      if (!viewResult.ok) return viewResult;
      const inputResult = context.graphics.prepareBindings('input', {
        pipeline: pipelineResult.value,
        values: { group: 1 },
      });
      if (!inputResult.ok) return inputResult;
      const verticesResult = context.graphics.prepareVertexData('triangle', {
        layout: 'position',
        data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      });
      if (!verticesResult.ok) return verticesResult;
      pipeline = pipelineResult.value;
      viewBindings = viewResult.value;
      inputBindings = inputResult.value;
      vertices = verticesResult.value;
      return ok(undefined);
    },
    contribute: (_data, context) => {
      if (pipeline === undefined || viewBindings === undefined || inputBindings === undefined || vertices === undefined) {
        return err(new Error(`${identity} prepared state missing`));
      }
      const draw = {
        kind: 'draw',
        pipeline,
        bindings: [viewBindings, inputBindings],
        vertexData: [{ slot: 0, resource: vertices }],
        command: { vertexCount: 3, instanceCount: 1 },
      };
      const passResult = context.staging.addGraphicsPass('forward', {
        attachments: {
          colors: [{ resource: 'swapchain', format: 'rgba8unorm-srgb', loadOp: 'clear', storeOp: 'store' }],
        },
        draws: [draw],
      });
      if (!passResult.ok) return passResult;
      return ok(undefined);
    },
  };
  return { feature, repair: () => { faultState.repaired = true; } };
}

function installFaultProbe(device, states) {
  const prepared = new Map();
  const probe = {
    backendCalls: { create: 0, upload: 0, record: 0 },
    failures: [],
    buffers: [],
    uploads: [],
    recordGroups: [],
    destroyCount: 0,
    createdLabels: [],
    uploadOwners: [],
    queuePatched: false,
  };
  const isPrepared = (label) => typeof label === 'string' && [...states.keys()].some((identity) => label.startsWith(`${identity}::`));
  const destroyBuffer = device.destroyBuffer.bind(device);
  device.destroyBuffer = (buffer) => {
    if (prepared.has(buffer)) probe.destroyCount += 1;
    return destroyBuffer(buffer);
  };
  const createBuffer = device.createBuffer.bind(device);
  device.createBuffer = (descriptor) => {
    probe.createdLabels.push(descriptor.label ?? null);
    const identity = [...states.keys()].find((entry) => descriptor.label?.startsWith(`${entry}::`));
    const state = identity === undefined ? undefined : states.get(identity);
    const invalid = state?.fault === 'create' && !state.repaired;
    if (isPrepared(descriptor.label) && state?.fault === 'create') probe.backendCalls.create += 1;
    const result = createBuffer(invalid ? { ...descriptor, size: -1 } : descriptor);
    if (identity !== undefined && state?.fault === 'create') {
      probe.buffers.push({ identity, accepted: result.ok });
      if (!result.ok) probe.failures.push({ identity, operation: 'create' });
      if (result.ok) prepared.set(result.value, identity);
    } else if (result.ok && isPrepared(descriptor.label)) {
      prepared.set(result.value, identity);
    }
    return result;
  };
  const writeBuffer = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
    const identity = prepared.get(buffer);
    probe.uploadOwners.push(identity ?? null);
    const state = identity === undefined ? undefined : states.get(identity);
    const fault = state?.fault === 'upload' && !state.repaired;
    if (fault) probe.backendCalls.upload += 1;
    const result = fault
      ? writeBuffer(buffer, offset, data, 0, -1)
      : writeBuffer(buffer, offset, data, dataOffset, size);
    if (fault) {
      probe.uploads.push({ identity, accepted: result.ok });
      if (!result.ok) probe.failures.push({ identity, operation: 'upload' });
    }
    return result;
  };
  probe.queuePatched = device.queue.writeBuffer !== writeBuffer;
  const createCommandEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = (descriptor) => {
    const result = createCommandEncoder(descriptor);
    if (!result.ok) return result;
    const encoder = result.value;
    const beginRenderPass = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = (passDescriptor) => {
      const pass = beginRenderPass(passDescriptor);
      const group = [];
      probe.recordGroups.push(group);
      const setVertexBuffer = pass.setVertexBuffer.bind(pass);
      pass.setVertexBuffer = (slot, buffer, ...rest) => {
        group.push('setVertexBuffer');
        const identity = prepared.get(buffer);
        const state = identity === undefined ? undefined : states.get(identity);
        if (state?.fault !== 'record' || state.repaired) {
          setVertexBuffer(slot, buffer, ...rest);
          return;
        }
        probe.recordGroups[probe.recordGroups.length - 1].push(identity);
        if (state !== undefined) {
          probe.backendCalls.record += 1;
          try {
            setVertexBuffer(slot, buffer, -1);
          } catch (error) {
            probe.failures.push({ identity, operation: 'record', error: String(error) });
            throw error;
          }
          return;
        }
        setVertexBuffer(slot, buffer, ...rest);
      };
      return pass;
    };
    return result;
  };
  return probe;
}

async function readCenterPixel() {
  const device = deviceRef.value;
  const target = targetRef.value;
  if (device === undefined || target === undefined) throw new Error('M10 Dawn readback target missing');
  const bytesPerRow = 256;
  const readback = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: MAP_READ | COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 });
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(MAP_READ);
  const bytes = new Uint8Array(readback.getMappedRange()).slice(0);
  readback.unmap();
  readback.destroy();
  const offset = Math.floor(HEIGHT / 2) * bytesPerRow + Math.floor(WIDTH / 2) * 4;
  return [...bytes.slice(offset, offset + 4)];
}

const states = new Map([
  ['m10.dawn.create', { fault: 'create', repaired: false }],
  ['m10.dawn.upload', { fault: 'upload', repaired: false }],
  ['m10.dawn.record', { fault: 'record', repaired: false }],
]);
const healthy = feature('m10.dawn.healthy', { fault: undefined, repaired: true });
const faulty = [...states.entries()].map(([identity, state]) => feature(identity, state));
const renderer = await createRenderer(
  canvas,
  { features: [healthy.feature, ...faulty.map((entry) => entry.feature)] },
  { shaderManifestUrl: manifestUrl },
);
const ready = await renderer.ready;
if (!ready.ok) throw new Error(`M10 Dawn renderer.ready failed: ${ready.error.code}`);
const errors = [];
renderer.onError((error) => errors.push({ code: error.code, hint: error.hint, detail: error.detail }));
const probe = installFaultProbe(renderer.device, states);
const firstDraw = renderer.draw([world()], { owner: 0 });
const firstDiagnostics = renderer.renderFeatureDiagnostics();
const firstPixel = await readCenterPixel();
const firstErrors = errors.slice();
for (const entry of faulty) entry.repair();
const recoveryModes = new Set(
  firstDiagnostics
    .map((entry) => entry.latestError?.detail.recovery)
    .filter((recovery) => recovery !== undefined),
);
const recoveryActions = [];
if (recoveryModes.has('renderer-recover')) {
  const recovered = await renderer.recover();
  recoveryActions.push(
    recovered.ok ? 'renderer.recover()' : `renderer.recover():${recovered.error.code}`,
  );
  if (!recovered.ok && recovered.error.code !== 'recover-not-needed') {
    throw new Error(`M10 Dawn renderer recovery failed: ${recovered.error.code}`);
  }
}
if (recoveryModes.has('next-frame')) recoveryActions.push('next-frame retry');
const secondDraw = renderer.draw([world()], { owner: 0 });
const secondDiagnostics = renderer.renderFeatureDiagnostics();
const secondPixel = await readCenterPixel();
renderer.dispose();
renderer.dispose();

const expected = {
  create: 'render-feature-stage-failed',
  upload: 'render-feature-preparation-failed',
  record: 'render-feature-draw-recording-failed',
};
for (const [identity, state] of states) {
  const first = firstDiagnostics.find((entry) => entry.identity === identity);
  const second = secondDiagnostics.find((entry) => entry.identity === identity);
  const error = firstErrors.find((entry) => entry.detail?.featureIdentity === identity);
  if (first?.status !== 'failed' || first.latestError?.code !== expected[state.fault] || first.latestError?.detail.featureIdentity !== identity) {
    throw new Error(`M10 Dawn ${identity} first diagnostic mismatch: ${JSON.stringify({ first, error, probe })}`);
  }
  if (error?.hint === undefined || second?.status !== 'active' || second.latestError !== undefined) {
    throw new Error(`M10 Dawn ${identity} recovery mismatch: ${JSON.stringify({ error, second })}`);
  }
}
const healthyFirst = firstDiagnostics.find((entry) => entry.identity === 'm10.dawn.healthy');
const healthySecond = secondDiagnostics.find((entry) => entry.identity === 'm10.dawn.healthy');
if (
  !firstDraw.ok || !secondDraw.ok ||
  healthyFirst?.status !== 'active' || healthySecond?.status !== 'active' ||
  firstPixel.slice(0, 3).every((channel) => channel === 0) ||
  JSON.stringify(firstPixel) !== JSON.stringify(secondPixel) ||
  probe.backendCalls.upload < 1 || probe.backendCalls.record < 1 ||
  !probe.failures.some((failure) => failure.identity === 'm10.dawn.upload' && failure.operation === 'upload') ||
  !probe.failures.some((failure) => failure.identity === 'm10.dawn.record' && failure.operation === 'record') ||
  probe.destroyCount < 1
) {
  throw new Error(`M10 Dawn acceptance mismatch: ${JSON.stringify({ firstPixel, secondPixel, firstDiagnostics, secondDiagnostics, probe })}`);
}
const evidence = {
  status: 'pass',
  backend: 'dawn',
  firstPixel,
  secondPixel,
  firstDiagnostics,
  secondDiagnostics,
  firstErrors,
  recoveryModes: [...recoveryModes],
  recoveryActions,
  siblingPassEvidence: { healthyFirst: healthyFirst?.status, healthySecond: healthySecond?.status },
  probe,
  cleanup: { disposeCalls: 2, destroyCount: probe.destroyCount },
};
writeFileSync(resolve(artifactDir, 'm10-dawn.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`[m10-render-feature] Dawn PASS cases=${states.size} firstPixel=${JSON.stringify(firstPixel)} secondPixel=${JSON.stringify(secondPixel)} artifact=${resolve(artifactDir, 'm10-dawn.json')}`);
process.exit(0);
