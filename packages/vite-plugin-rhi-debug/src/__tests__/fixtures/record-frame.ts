// Test fixture: build a DebugRhiInstance with one recorded frame.
//
// Mirrors the mock-instance bootstrap from
// packages/rhi-debug/src/__tests__/recorder.unit.test.ts so the endpoint
// integration test (w10/w11) can drive finalizeToMemory against a real tape
// without standing up a GPU device.

import { wrap } from '@forgeax/engine-rhi-debug';

// biome-ignore lint/suspicious/noExplicitAny: structural GPU mock, type fidelity not needed
type Any = any;

function rOk<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function h(): Any {
  return {};
}

function makeRenderPass(): Any {
  return {
    setPipeline: () => {},
    setVertexBuffer: () => {},
    setIndexBuffer: () => {},
    setBindGroup: () => {},
    draw: () => {},
    drawIndexed: () => {},
    setViewport: () => {},
    setScissorRect: () => {},
    end: () => {},
  };
}

function makeCmdEncoder(): Any {
  return {
    beginRenderPass: () => makeRenderPass(),
    copyTextureToBuffer: () => {},
    finish: () => rOk(h()),
  };
}

function buildMockInstance(): Any {
  const mockQueue: Any = {
    writeBuffer: () => rOk(undefined),
    writeTexture: () => rOk(undefined),
    submit: () => rOk(undefined),
    onSubmittedWorkDone: () => Promise.resolve(undefined),
  };

  const mockDevice: Any = {
    caps: {
      backendKind: 'webgpu',
      compute: true,
      timestampQuery: false,
      textureCompression: false,
      storageBuffer: true,
      rgba16floatRenderable: true,
      float32Filterable: false,
    },
    features: new Set(),
    limits: { maxTextureDimension2D: 8192 },
    queue: mockQueue,
    lost: Promise.resolve({ reason: 'destroyed', message: '' }),
    createBuffer: () => rOk(h()),
    createTexture: () => rOk(h()),
    createTextureView: () => rOk(h()),
    createSampler: () => rOk(h()),
    createBindGroupLayout: () => rOk(h()),
    createBindGroup: () => rOk(h()),
    createPipelineLayout: () => rOk(h()),
    createRenderPipeline: () => rOk(h()),
    createComputePipeline: () => rOk(h()),
    createQuerySet: () => rOk(h()),
    destroyBuffer: () => rOk(undefined),
    destroyTexture: () => rOk(undefined),
    createCommandEncoder: () => rOk(makeCmdEncoder()),
  };

  const mockAdapter: Any = {
    features: new Set(),
    limits: {},
    requestDevice: () => Promise.resolve(rOk(mockDevice)),
  };

  return {
    requestAdapter: () => Promise.resolve(rOk(mockAdapter)),
  };
}

/**
 * Record one frame and return the live debugInst (idle, tape available).
 * finalizeToMemory(debugInst) yields a non-empty tape.
 */
export async function recordOneFrameToMemory(): Promise<{ debugInst: ReturnType<typeof wrap> }> {
  const debugInst = wrap(buildMockInstance());
  const adapterRes = await debugInst.requestAdapter();
  if (!adapterRes.ok) throw new Error('mock adapter failed');
  const adapter = (adapterRes as Any).value;
  const devRes = await adapter.requestDevice();
  if (!devRes.ok) throw new Error('mock device failed');
  const device = (devRes as Any).value;

  debugInst.arm(1);
  device.createBuffer({ size: 64, usage: 16 });
  debugInst.onFrameEnd();

  return { debugInst };
}
