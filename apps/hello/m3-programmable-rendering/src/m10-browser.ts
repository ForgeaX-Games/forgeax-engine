import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  RenderFeatureStageFailedError,
  type RenderFeature,
  type RenderFeaturePreparedRef,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { createRenderer } from '@forgeax/engine-runtime';
import { err, ok } from '@forgeax/engine-types';

const WIDTH = 64;
const HEIGHT = 64;
const canvas = document.querySelector<HTMLCanvasElement>('#m10-render-feature');
if (canvas === null) throw new Error('M10 browser canvas is missing');
canvas.width = WIDTH;
canvas.height = HEIGHT;

type Fault = 'create' | 'upload' | 'record' | undefined;
type FaultState = { fault: Fault; repaired: boolean };

function makeWorld(): World {
  const world = new World();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
  );
  return world;
}

function makeFeature(identity: string, state: FaultState): RenderFeature<unknown> {
  let pipeline: RenderFeaturePreparedRef<'pipeline'> | undefined;
  let viewBindings: RenderFeaturePreparedRef<'bindings'> | undefined;
  let inputBindings: RenderFeaturePreparedRef<'bindings'> | undefined;
  let vertices: RenderFeaturePreparedRef<'vertex-data'> | undefined;
  return {
    identity,
    extract: () => ok({ draw: true }),
    prepare: (_data, context) => {
      if (state.fault === 'create' && !state.repaired) {
        return err(new RenderFeatureStageFailedError(identity, 1, 'prepare', 'next-frame'));
      }
      const colorFormat = navigator.gpu.getPreferredCanvasFormat().endsWith('-srgb')
        ? navigator.gpu.getPreferredCanvasFormat()
        : `${navigator.gpu.getPreferredCanvasFormat()}-srgb`;
      const pipelineResult = context.graphics.preparePipeline('forward', {
        shader: 'forgeax::tonemap',
        vertexLayout: 'position',
        colorFormats: [colorFormat],
      });
      if (!pipelineResult.ok) return pipelineResult;
      const viewResult = context.graphics.prepareBindings('view', {
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
        return err(new RenderFeatureStageFailedError(identity, 1, 'contribute', 'next-frame'));
      }
      const colorFormat = navigator.gpu.getPreferredCanvasFormat().endsWith('-srgb')
        ? navigator.gpu.getPreferredCanvasFormat()
        : `${navigator.gpu.getPreferredCanvasFormat()}-srgb`;
      const passResult = context.staging.addGraphicsPass('forward', {
        attachments: {
          colors: [{ resource: 'swapchain', format: colorFormat, loadOp: 'clear', storeOp: 'store' }],
        },
        draws: [{
          kind: 'draw',
          pipeline,
          bindings: [viewBindings, inputBindings],
          vertexData: [{ slot: 0, resource: vertices }],
          command: { vertexCount: 3, instanceCount: 1 },
        }],
      });
      if (!passResult.ok) return passResult;
      return ok(undefined);
    },
  };
}

function installFaultProbe(device: any, states: ReadonlyMap<string, FaultState>) {
  const buffers = new Map<any, string>();
  const probe = {
    backendCalls: { create: 0, upload: 0, record: 0 },
    failures: [] as Array<Record<string, unknown>>,
    destroyCount: 0,
  };
  const originalDestroy = device.destroyBuffer.bind(device);
  device.destroyBuffer = (buffer: any) => {
    if (buffers.has(buffer)) probe.destroyCount += 1;
    return originalDestroy(buffer);
  };
  const originalCreate = device.createBuffer.bind(device);
  device.createBuffer = (descriptor: any) => {
    const identity = [...states.keys()].find((entry) => descriptor.label?.startsWith(`${entry}::`));
    const result = originalCreate(descriptor);
    if (identity !== undefined && result.ok) buffers.set(result.value, identity);
    return result;
  };
  const originalWrite = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = (buffer: any, offset: number, data: any, dataOffset?: number, size?: number) => {
    const identity = buffers.get(buffer);
    const state = identity === undefined ? undefined : states.get(identity);
    if (state?.fault === 'upload' && !state.repaired) {
      probe.backendCalls.upload += 1;
      const failed = originalWrite(buffer, offset, data, 0, -1);
      probe.failures.push({ identity, operation: 'upload', accepted: failed.ok });
      return failed;
    }
    return originalWrite(buffer, offset, data, dataOffset, size);
  };
  const originalEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = (descriptor: any) => {
    const encoderResult = originalEncoder(descriptor);
    if (!encoderResult.ok) return encoderResult;
    const encoder = encoderResult.value;
    const originalBegin = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = (passDescriptor: any) => {
      const pass = originalBegin(passDescriptor);
      const originalSetVertex = pass.setVertexBuffer.bind(pass);
      pass.setVertexBuffer = (slot: number, buffer: any, ...rest: any[]) => {
        const identity = buffers.get(buffer);
        const state = identity === undefined ? undefined : states.get(identity);
        if (state?.fault === 'record' && !state.repaired) {
          probe.backendCalls.record += 1;
          try {
            originalSetVertex(slot, buffer, -1);
          } catch (error) {
            probe.failures.push({ identity, operation: 'record', error: String(error) });
            throw error;
          }
          return;
        }
        originalSetVertex(slot, buffer, ...rest);
      };
      return pass;
    };
    return encoderResult;
  };
  return probe;
}

const states = new Map<string, FaultState>([
  ['m10.browser.create', { fault: 'create', repaired: false }],
  ['m10.browser.upload', { fault: 'upload', repaired: false }],
  ['m10.browser.record', { fault: 'record', repaired: false }],
]);
const healthy = makeFeature('m10.browser.healthy', { fault: undefined, repaired: true });
const faulty = [...states.entries()].map(([identity, state]) => ({ identity, state, feature: makeFeature(identity, state) }));
const renderer = await createRenderer(
  canvas,
  { features: [healthy, ...faulty.map((entry) => entry.feature)] },
  { shaderManifestUrl: '/shaders/manifest.json' },
);
const ready = await renderer.ready;
if (!ready.ok) throw new Error(`M10 browser renderer.ready failed: ${ready.error.code}`);
const errors: Array<{ code: string; hint: string; detail: unknown }> = [];
renderer.onError((error) => {
  const candidate = error as unknown as { code: string; hint: string; detail?: unknown };
  errors.push({ code: candidate.code, hint: candidate.hint, detail: candidate.detail });
});
const probe = installFaultProbe(renderer.device, states);
const firstWorld = makeWorld();
const firstAttachment = renderer.attachWorld(firstWorld);
if (!firstAttachment.ok) throw firstAttachment.error;
firstWorld.update().unwrap();
const firstDraw = renderer.draw([firstWorld], { cameraOwner: 0, resourceOwner: 0 });
const firstDiagnostics = renderer.renderFeatureDiagnostics();
const firstErrors = errors.slice();
for (const entry of faulty) entry.state.repaired = true;
const recoveryModes = new Set(
  firstDiagnostics
    .map((entry) => {
      const detail = entry.latestError?.detail;
      return detail !== undefined && 'recovery' in detail ? detail.recovery : undefined;
    })
    .filter((value) => value !== undefined),
);
const recoveryActions: string[] = [];
if (recoveryModes.has('renderer-recover')) {
  const recovered = await renderer.recover();
  recoveryActions.push(recovered.ok ? 'renderer.recover()' : `renderer.recover():${recovered.error.code}`);
}
if (recoveryModes.has('next-frame')) recoveryActions.push('next-frame retry');
const secondWorld = makeWorld();
renderer.detachWorld(firstWorld);
const secondAttachment = renderer.attachWorld(secondWorld);
if (!secondAttachment.ok) throw secondAttachment.error;
secondWorld.update().unwrap();
const secondDraw = renderer.draw([secondWorld], { cameraOwner: 0, resourceOwner: 0 });
const secondDiagnostics = renderer.renderFeatureDiagnostics();
const firstByIdentity = (identity: string) => firstDiagnostics.find((entry) => entry.identity === identity);
const secondByIdentity = (identity: string) => secondDiagnostics.find((entry) => entry.identity === identity);
for (const [identity, state] of states) {
  const expected = state.fault === 'create'
    ? 'render-feature-stage-failed'
    : state.fault === 'upload'
      ? 'render-feature-preparation-failed'
      : 'render-feature-draw-recording-failed';
  const first = firstByIdentity(identity);
  const second = secondByIdentity(identity);
  const error = firstErrors.find((entry) => {
    const detail = entry.detail;
    return detail !== null && typeof detail === 'object' && 'featureIdentity' in detail && detail.featureIdentity === identity;
  });
  if (first?.status !== 'failed' || first.latestError?.code !== expected || error?.hint === undefined || second?.status !== 'active' || second.latestError !== undefined) {
    throw new Error(`M10 browser ${identity} lifecycle mismatch: ${JSON.stringify({ first, second, error, probe })}`);
  }
}
const healthyFirst = firstByIdentity('m10.browser.healthy');
const healthySecond = secondByIdentity('m10.browser.healthy');
if (!firstDraw.ok || !secondDraw.ok || healthyFirst?.status !== 'active' || healthySecond?.status !== 'active' || probe.backendCalls.upload < 1 || probe.backendCalls.record < 1) {
  throw new Error(`M10 browser acceptance mismatch: ${JSON.stringify({ firstDraw, secondDraw, firstDiagnostics, secondDiagnostics, probe })}`);
}
const evidence = {
  status: 'pass',
  backend: 'browser-webgpu',
  firstDiagnostics,
  secondDiagnostics,
  firstErrors,
  recoveryModes: [...recoveryModes],
  recoveryActions,
  siblingPassEvidence: { healthyFirst: healthyFirst?.status, healthySecond: healthySecond?.status },
  probe,
  cleanup: undefined as { disposeCalls: number; destroyCount: number } | undefined,
};
await renderer.device.queue.onSubmittedWorkDone();
await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const browserGlobals = globalThis as typeof globalThis & {
  __forgeaxM10Dispose?: () => void;
  __forgeaxM10Evidence?: unknown;
};
browserGlobals.__forgeaxM10Evidence = evidence;
browserGlobals.__forgeaxM10Dispose = () => {
  renderer.dispose();
  renderer.dispose();
  evidence.cleanup = { disposeCalls: 2, destroyCount: probe.destroyCount };
  browserGlobals.__forgeaxM10Evidence = evidence;
};
