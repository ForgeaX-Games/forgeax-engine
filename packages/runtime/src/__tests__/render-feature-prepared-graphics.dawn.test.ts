import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  type RenderFeature,
  type RenderFeatureCapabilityKey,
  type RenderFeatureDrawRecord,
  type RenderFeaturePreparedRef,
} from '@forgeax/engine-render';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { Transform } from '@forgeax/engine-scene';
import { err, ok } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { createRenderer } from '../createRenderer';
import { drawPublished } from './draw-published';

const WIDTH = 64;
const HEIGHT = 64;
const manifestUrl = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  const manifest = await buildEngineShaderManifest();
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
})();

type PreparedFeatureMode = 'accepted' | 'stale' | 'forged';

type BackendFailure = 'create' | 'upload' | 'record';

interface PreparedFeatureOptions {
  readonly identity?: string;
  readonly mode?: PreparedFeatureMode;
}

interface BackendProbe {
  readonly buffers: Array<{
    readonly label: string | undefined;
    readonly size: number;
    readonly usage: number;
    readonly accepted: boolean;
    readonly handle: object | undefined;
  }>;
  readonly uploads: Array<{ readonly bytes: number[]; readonly accepted: boolean }>;
  readonly recordGroups: Array<{ readonly mutations: string[]; readonly handles: unknown[] }>;
  readonly backendCalls: { create: number; upload: number; record: number };
  readonly backendFailures: Array<{
    readonly operation: BackendFailure;
    readonly outcome: 'result-error' | 'throw';
  }>;
  destroyCount: number;
}

function bytesOf(data: ArrayBufferView | ArrayBuffer): number[] {
  if (data instanceof ArrayBuffer) return [...new Uint8Array(data)];
  const view = data as ArrayBufferView;
  return [...new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength)];
}

function installBackendProbe(
  device: RhiDevice,
  featureIdentities: readonly string[],
  failure?: BackendFailure,
): BackendProbe {
  const preparedBuffers = new Set<object>();
  const probe: BackendProbe = {
    buffers: [],
    uploads: [],
    recordGroups: [],
    backendCalls: { create: 0, upload: 0, record: 0 },
    backendFailures: [],
    destroyCount: 0,
  };
  const isPreparedLabel = (label: string | undefined): boolean =>
    label !== undefined && featureIdentities.some((identity) => label.startsWith(`${identity}::`));

  const destroyBuffer = device.destroyBuffer.bind(device);
  device.destroyBuffer = (buffer) => {
    if (preparedBuffers.has(buffer as object)) probe.destroyCount += 1;
    return destroyBuffer(buffer);
  };

  const createBuffer = device.createBuffer.bind(device);
  device.createBuffer = (descriptor) => {
    const prepared = isPreparedLabel(descriptor.label);
    // Preserve the native call so Dawn validates this invalid descriptor.
    const backendDescriptor =
      prepared && failure === 'create' ? { ...descriptor, size: -1 } : descriptor;
    probe.backendCalls.create += prepared ? 1 : 0;
    try {
      const result = createBuffer(backendDescriptor);
      if (prepared) {
        probe.buffers.push({
          label: descriptor.label,
          size: backendDescriptor.size ?? 0,
          usage: descriptor.usage ?? 0,
          accepted: result.ok,
          handle: result.ok ? (result.value as object) : undefined,
        });
        if (!result.ok)
          probe.backendFailures.push({ operation: 'create', outcome: 'result-error' });
        if (result.ok) preparedBuffers.add(result.value as object);
      }
      return result;
    } catch (error) {
      if (prepared) {
        probe.buffers.push({
          label: descriptor.label,
          size: backendDescriptor.size ?? 0,
          usage: descriptor.usage ?? 0,
          accepted: false,
          handle: undefined,
        });
        probe.backendFailures.push({ operation: 'create', outcome: 'throw' });
      }
      throw error;
    }
  };

  const writeBuffer = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
    if (!preparedBuffers.has(buffer as object)) {
      return writeBuffer(buffer, offset, data, dataOffset, size);
    }
    probe.backendCalls.upload += failure === 'upload' ? 1 : 0;
    try {
      // The native queue validates the invalid size and returns its real result.
      const result =
        failure === 'upload'
          ? writeBuffer(buffer, offset, data, 0, -1)
          : writeBuffer(buffer, offset, data, dataOffset, size);
      probe.uploads.push({ bytes: bytesOf(data), accepted: result.ok });
      if (failure === 'upload' && !result.ok) {
        probe.backendFailures.push({ operation: 'upload', outcome: 'result-error' });
      }
      return result;
    } catch (error) {
      if (failure === 'upload') {
        probe.uploads.push({ bytes: bytesOf(data), accepted: false });
        probe.backendFailures.push({ operation: 'upload', outcome: 'throw' });
      }
      throw error;
    }
  };

  const createCommandEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = (descriptor) => {
    const result = createCommandEncoder(descriptor);
    if (!result.ok) return result;
    const encoder = result.value;
    const beginRenderPass = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = (passDescriptor) => {
      const pass = beginRenderPass(passDescriptor);
      const group: { mutations: string[]; handles: unknown[] } = {
        mutations: [],
        handles: [],
      };
      probe.recordGroups.push(group);
      const setPipeline = pass.setPipeline.bind(pass);
      pass.setPipeline = (handle) => {
        group.mutations.push('setPipeline');
        group.handles.push(handle);
        setPipeline(handle);
      };
      const setBindGroup = pass.setBindGroup.bind(pass);
      pass.setBindGroup = ((index: number, handle: unknown, ...rest: unknown[]) => {
        group.mutations.push('setBindGroup');
        group.handles.push(handle);
        (setBindGroup as (...args: unknown[]) => void)(index, handle, ...rest);
      }) as typeof pass.setBindGroup;
      const setVertexBuffer = pass.setVertexBuffer.bind(pass);
      pass.setVertexBuffer = (slot, handle, ...rest) => {
        group.mutations.push('setVertexBuffer');
        group.handles.push(handle);
        probe.backendCalls.record +=
          failure === 'record' && preparedBuffers.has(handle as object) ? 1 : 0;
        try {
          if (failure === 'record' && preparedBuffers.has(handle as object)) {
            // The native pass receives the real handle and rejects this offset.
            setVertexBuffer(slot, handle, -1);
            return;
          }
          setVertexBuffer(slot, handle, ...rest);
        } catch (error) {
          if (failure === 'record' && preparedBuffers.has(handle as object)) {
            probe.backendFailures.push({ operation: 'record', outcome: 'throw' });
          }
          throw error;
        }
      };
      const setIndexBuffer = pass.setIndexBuffer.bind(pass);
      pass.setIndexBuffer = (handle, format, ...rest) => {
        group.mutations.push('setIndexBuffer');
        group.handles.push(handle);
        setIndexBuffer(handle, format, ...rest);
      };
      const draw = pass.draw.bind(pass);
      pass.draw = (...args) => {
        group.mutations.push('draw');
        draw(...args);
      };
      const drawIndexed = pass.drawIndexed.bind(pass);
      pass.drawIndexed = (...args) => {
        group.mutations.push('drawIndexed');
        drawIndexed(...args);
      };
      return pass;
    };
    return result;
  };
  return probe;
}

function preparedFeature(
  options: PreparedFeatureOptions = {},
): RenderFeature<{ readonly draw: RenderFeatureDrawRecord }> {
  const mode = options.mode ?? 'accepted';
  const identity = options.identity ?? 'synthetic.dawn.prepared';
  const passName = `${identity}.pass`;
  let pipeline: RenderFeaturePreparedRef<'pipeline'> | undefined;
  let viewBindings: RenderFeaturePreparedRef<'bindings'> | undefined;
  let inputBindings: RenderFeaturePreparedRef<'bindings'> | undefined;
  let vertices: RenderFeaturePreparedRef<'vertex-data'> | undefined;

  return {
    identity,
    extract: () =>
      ok({
        draw: {
          kind: 'draw',
          pipeline: { kind: 'pipeline', generation: 0 },
          bindings: [
            { kind: 'bindings', generation: 0 },
            { kind: 'bindings', generation: 0 },
          ],
          vertexData: [{ slot: 0, resource: { kind: 'vertex-data', generation: 0 } }],
          command: { vertexCount: 3, instanceCount: 1 },
        },
      }),
    prepare: (_data, context) => {
      const pipelineResult = context.graphics.preparePipeline('forward', {
        shader: 'forgeax::tonemap',
        vertexLayout: 'position',
        colorFormats: ['rgba8unorm-srgb'],
      });
      if (!pipelineResult.ok) return pipelineResult;
      const bindingsResult = context.graphics.prepareBindings('forward', {
        pipeline: pipelineResult.value,
        values: {},
      });
      if (!bindingsResult.ok) return bindingsResult;
      const inputBindingsResult = context.graphics.prepareBindings('input', {
        pipeline: pipelineResult.value,
        values: { group: 1 },
      });
      if (!inputBindingsResult.ok) return inputBindingsResult;
      const verticesResult = context.graphics.prepareVertexData('triangle', {
        layout: 'position',
        data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      });
      if (!verticesResult.ok) return verticesResult;
      pipeline = pipelineResult.value;
      viewBindings = bindingsResult.value;
      inputBindings = inputBindingsResult.value;
      vertices = verticesResult.value;
      return ok(undefined);
    },
    contribute: (data, context) => {
      if (
        pipeline === undefined ||
        viewBindings === undefined ||
        inputBindings === undefined ||
        vertices === undefined
      ) {
        return err(new Error('prepared graphics state missing') as never);
      }
      context.staging.addResource('color', { kind: 'texture', lifetime: 'transient' });
      const drawPipeline =
        mode === 'stale' ? { kind: 'pipeline' as const, generation: 99 } : pipeline;
      const drawVertices =
        mode === 'forged' ? { kind: 'vertex-data' as const, generation: 0 } : vertices;
      return context.staging.addGraphicsPass(passName, {
        attachments: {
          colors: [
            { resource: 'color', format: 'rgba8unorm-srgb', loadOp: 'load', storeOp: 'store' },
          ],
        },
        draws: [
          {
            ...data.draw,
            pipeline: drawPipeline,
            bindings: [viewBindings, inputBindings],
            vertexData: [{ slot: 0, resource: drawVertices }],
          },
        ],
      });
    },
  };
}

const capabilityCandidates: readonly RenderFeatureCapabilityKey[] = [
  'compute',
  'timestampQuery',
  'indirectDrawing',
  'textureCompressionAstc',
  'textureCompressionBc',
  'textureCompressionEtc2',
  'multiDrawIndirect',
  'pushConstants',
  'textureBindingArray',
  'samplerAliasing',
  'firstInstanceIndirect',
  'storageBuffer',
  'storageTexture',
  'rgba16floatRenderable',
  'rg11b10ufloatRenderable',
  'float32Filterable',
];

function capabilityFeature(
  capabilities: RenderFeatureCapabilityKey[],
): RenderFeature<{ readonly ready: true }> {
  return {
    identity: 'synthetic.dawn.capability-mismatch',
    requiredCapabilities: capabilities,
    extract: () => ok({ ready: true }),
    prepare: () => ok(undefined),
    contribute: () => ok(undefined),
  };
}

function makeCanvas(deviceRef: { value?: GPUDevice }): HTMLCanvasElement {
  let target: GPUTexture | undefined;
  return {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(descriptor: { device: GPUDevice; format?: GPUTextureFormat }) {
          deviceRef.value = descriptor.device;
          target = descriptor.device.createTexture({
            size: { width: WIDTH, height: HEIGHT },
            format: descriptor.format ?? 'rgba8unorm',
            viewFormats: ['rgba8unorm-srgb'],
            usage: 0x10 | 0x04,
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          if (target === undefined) throw new Error('Dawn target was not configured');
          return target;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
}

describe('prepared graphics Dawn contract', () => {
  let renderer: Awaited<ReturnType<typeof createRenderer>> | undefined;

  afterEach(() => {
    renderer?.dispose();
    renderer = undefined;
  });

  it('records and submits the prepared operation with comparable diagnostics', async () => {
    if (typeof navigator?.gpu?.requestAdapter !== 'function') {
      throw new Error('Dawn navigator.gpu is unavailable');
    }
    const deviceRef: { value?: GPUDevice } = {};
    renderer = await createRenderer(
      makeCanvas(deviceRef),
      { features: [preparedFeature()] },
      { shaderManifestUrl: manifestUrl },
    );
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;

    const device = renderer.device;
    const identity = 'synthetic.dawn.prepared';
    const probe = installBackendProbe(device, [identity]);
    const errors: string[] = [];
    renderer.onError((error) => errors.push(error.code));
    const world = new World();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: Camera, data: { fov: 60, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    expect(drawPublished(renderer, world).ok).toBe(true);
    await deviceRef.value?.queue.onSubmittedWorkDone();

    expect(renderer.renderFeatureDiagnostics()[0]?.status).toBe('active');
    expect(errors).toEqual([]);
    expect(probe.buffers).toEqual([
      expect.objectContaining({
        label: `${identity}::triangle`,
        size: 36,
        usage: 40,
        accepted: true,
      }),
    ]);
    expect(probe.uploads).toEqual([
      {
        bytes: Array.from(new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer)),
        accepted: true,
      },
    ]);
    const preparedGroup = probe.recordGroups.find((group) =>
      group.handles.includes(probe.buffers[0]?.handle),
    );
    expect(preparedGroup?.mutations).toEqual([
      'setPipeline',
      'setBindGroup',
      'setBindGroup',
      'setVertexBuffer',
      'draw',
    ]);
    await device.queue.onSubmittedWorkDone();
    expect(probe.destroyCount).toBe(1);
    renderer.dispose();
    expect(probe.destroyCount).toBe(1);
  });

  it('rejects stale and forged refs before prepared GPU buffer mutation', async () => {
    if (typeof navigator?.gpu?.requestAdapter !== 'function') {
      throw new Error('Dawn navigator.gpu is unavailable');
    }
    const deviceRef: { value?: GPUDevice } = {};
    renderer = await createRenderer(
      makeCanvas(deviceRef),
      {
        features: [
          preparedFeature({ identity: 'synthetic.dawn.stale', mode: 'stale' }),
          preparedFeature({ identity: 'synthetic.dawn.forged', mode: 'forged' }),
        ],
      },
      { shaderManifestUrl: manifestUrl },
    );
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;

    const probe = installBackendProbe(renderer.device, [
      'synthetic.dawn.stale',
      'synthetic.dawn.forged',
    ]);
    const errors: Array<{ readonly code: string; readonly detail: unknown }> = [];
    renderer.onError((error) =>
      errors.push({ code: error.code, detail: 'detail' in error ? error.detail : undefined }),
    );
    const world = new World();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: Camera, data: { fov: 60, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    expect(drawPublished(renderer, world).ok).toBe(true);
    expect(errors.map((error) => error.code)).toEqual([
      'render-feature-prepared-state-mismatch',
      'render-feature-prepared-state-mismatch',
    ]);
    expect(errors.map((error) => error.detail)).toEqual([
      expect.objectContaining({ featureIdentity: 'synthetic.dawn.stale' }),
      expect.objectContaining({ featureIdentity: 'synthetic.dawn.forged' }),
    ]);
    expect(probe.buffers).toEqual([]);
    expect(
      probe.recordGroups.every(
        (group) =>
          !group.mutations.includes('setVertexBuffer') &&
          !group.mutations.includes('setIndexBuffer'),
      ),
    ).toBe(true);
    expect(renderer.renderFeatureDiagnostics().map((entry) => entry.status)).toEqual([
      'failed',
      'failed',
    ]);
    await renderer.device.queue.onSubmittedWorkDone();
    expect(probe.destroyCount).toBe(0);
    renderer.dispose();
    expect(probe.destroyCount).toBe(0);
  });

  it.each([
    { failure: 'create' as const, code: 'render-feature-stage-failed', destroys: 0 },
    { failure: 'upload' as const, code: 'render-feature-preparation-failed', destroys: 1 },
    {
      failure: 'record' as const,
      code: 'render-feature-draw-recording-failed',
      destroys: 1,
    },
  ])('isolates a real backend $failure failure before feature completion', async ({
    failure,
    code,
    destroys,
  }) => {
    if (typeof navigator?.gpu?.requestAdapter !== 'function') {
      throw new Error('Dawn navigator.gpu is unavailable');
    }
    const deviceRef: { value?: GPUDevice } = {};
    const identity = `synthetic.dawn.${failure}`;
    renderer = await createRenderer(
      makeCanvas(deviceRef),
      { features: [preparedFeature({ identity })] },
      { shaderManifestUrl: manifestUrl },
    );
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;

    const probe = installBackendProbe(renderer.device, [identity], failure);
    const errors: Array<{ readonly code: string; readonly detail: unknown }> = [];
    renderer.onError((error) =>
      errors.push({ code: error.code, detail: 'detail' in error ? error.detail : undefined }),
    );
    const world = new World();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: Camera, data: { fov: 60, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    expect(drawPublished(renderer, world).ok).toBe(true);

    expect(errors.map((error) => error.code)).toContain(code);
    expect(errors.some((error) => error.detail !== undefined)).toBe(true);
    expect(renderer.renderFeatureDiagnostics()[0]?.status).toBe('failed');
    expect(probe.backendCalls[failure]).toBe(1);
    expect(probe.backendFailures).toEqual([expect.objectContaining({ operation: failure })]);
    if (failure === 'create') {
      expect(probe.buffers).toEqual([
        expect.objectContaining({ label: `${identity}::triangle`, accepted: false }),
      ]);
      expect(probe.uploads).toEqual([]);
    } else {
      expect(probe.buffers[0]?.accepted).toBe(true);
      expect(probe.uploads[0]?.accepted).toBe(failure !== 'upload');
    }
    if (failure === 'record') {
      const preparedGroup = probe.recordGroups.find((group) =>
        group.handles.includes(probe.buffers[0]?.handle),
      );
      expect(preparedGroup?.mutations).toEqual([
        'setPipeline',
        'setBindGroup',
        'setBindGroup',
        'setVertexBuffer',
      ]);
    }
    await renderer.device.queue.onSubmittedWorkDone();
    expect(probe.destroyCount).toBe(destroys);
    renderer.dispose();
    expect(probe.destroyCount).toBe(destroys);
  });

  it('disables an unsupported capability before feature preparation', async () => {
    if (typeof navigator?.gpu?.requestAdapter !== 'function') {
      throw new Error('Dawn navigator.gpu is unavailable');
    }
    const deviceRef: { value?: GPUDevice } = {};
    const capabilities: RenderFeatureCapabilityKey[] = ['compute'];
    renderer = await createRenderer(
      makeCanvas(deviceRef),
      { features: [capabilityFeature(capabilities)] },
      { shaderManifestUrl: manifestUrl },
    );
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;

    const unsupported = capabilityCandidates.find((key) => renderer?.device.caps[key] !== true);
    if (unsupported === undefined)
      throw new Error('fixture requires one unsupported RHI capability');
    capabilities[0] = unsupported;

    const errors: string[] = [];
    renderer.onError((error) => errors.push(error.code));
    const world = new World();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: Camera, data: { fov: 60, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    expect(drawPublished(renderer, world).ok).toBe(true);
    expect(renderer.renderFeatureDiagnostics()[0]?.status).toBe('disabled');
    expect(errors).toContain('render-feature-capability-missing');
  });
});
