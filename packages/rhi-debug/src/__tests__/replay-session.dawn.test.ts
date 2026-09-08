/// <reference types="@webgpu/types" />

import type { RhiInstance } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { BootstrapResource, Tape } from '../protocol/types';
import { openReplay, type ReplayBackend } from '../replay/session';

interface DawnPack {
  readonly rhi: RhiInstance;
  readonly createShaderModule: ReplayBackend['createShaderModule'];
}

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';
const WIDTH = 32;
const HEIGHT = 32;

const VERTEX_SHADER = `
@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(0.0, 0.7), vec2<f32>(-0.7, -0.7), vec2<f32>(0.7, -0.7));
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}`;

async function loadDawn(): Promise<DawnPack> {
  return (await import('@forgeax/engine-rhi-webgpu')) as unknown as DawnPack;
}

async function freshDevice(pack: DawnPack) {
  const adapter = await pack.rhi.requestAdapter();
  expect(adapter.ok).toBe(true);
  if (!adapter.ok) throw new Error(`Dawn admission failed: ${adapter.error.code}`);
  const device = await adapter.value.requestDevice();
  expect(device.ok).toBe(true);
  if (!device.ok) throw new Error(`Dawn device admission failed: ${device.error.code}`);
  return device.value;
}

function bootstrap(
  handleId: string,
  kind: BootstrapResource['kind'],
  create: Record<string, unknown>,
  initialData: BootstrapResource['initialData'] = [],
): BootstrapResource {
  return { handleId, kind, create, initialData };
}

function triangleTape(): Tape {
  const bootstrapResources: BootstrapResource[] = [
    bootstrap(
      'texture:rt',
      'texture',
      {
        kind: 'createTexture',
        handleId: 'texture:rt',
        desc: {
          size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          format: 'rgba8unorm',
          dimension: '2d',
          mipLevelCount: 1,
          sampleCount: 1,
          usage: 0x13,
        },
      },
      [{ hash: 'texture-seed', byteOffset: 0, byteLength: WIDTH * HEIGHT * 4 }],
    ),
    bootstrap('texture-view:rt', 'texture-view', {
      kind: 'createTextureView',
      sourceHandleId: 'texture:rt',
      resultHandleId: 'texture-view:rt',
      desc: {},
    }),
    bootstrap('shader:vertex', 'shader-module', {
      kind: 'createShaderModule',
      handleId: 'shader:vertex',
      wgslCode: VERTEX_SHADER,
    }),
    bootstrap('shader:fragment', 'shader-module', {
      kind: 'createShaderModule',
      handleId: 'shader:fragment',
      wgslCode: FRAGMENT_SHADER,
    }),
    bootstrap('layout:empty', 'binding', {
      kind: 'createBindGroupLayout',
      handleId: 'layout:empty',
      desc: { entries: [] },
    }),
    bootstrap('pipeline-layout:empty', 'binding', {
      kind: 'createPipelineLayout',
      handleId: 'pipeline-layout:empty',
      bglHandleIds: ['layout:empty'],
    }),
    bootstrap('pipeline:triangle', 'pipeline', {
      kind: 'createRenderPipeline',
      handleId: 'pipeline:triangle',
      desc: {
        vertex: { entryPoint: 'main', buffers: [] },
        fragment: { entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      },
      layoutHandleId: 'pipeline-layout:empty',
      vertexShaderModuleHandleId: 'shader:vertex',
      fragmentShaderModuleHandleId: 'shader:fragment',
    }),
  ];
  const events = [
    { kind: 'createCommandEncoder', cmdHandleId: 'encoder:frame', desc: {} },
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'encoder:frame',
      passHandleId: 'pass:frame',
      desc: {
        colorAttachments: [
          { view: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'load', storeOp: 'store' },
        ],
      },
      colorAttachmentViewHandleIds: ['texture-view:rt'],
      colorAttachmentResolveTargetHandleIds: [undefined],
      depthStencilViewHandleId: undefined,
    },
    { kind: 'setPipeline', passHandleId: 'pass:frame', pipelineHandleId: 'pipeline:triangle' },
    {
      kind: 'draw',
      passHandleId: 'pass:frame',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    { kind: 'endRenderPass', passHandleId: 'pass:frame' },
    { kind: 'finish', cmdHandleId: 'encoder:frame' },
    { kind: 'submit', cmdHandleIds: ['encoder:frame'] },
    { kind: 'frameMark', frameIdx: 0 },
  ] as unknown as Tape['events'];
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: events.length, blobCount: 1 },
    bootstrap: bootstrapResources,
    events,
    blobs: [
      {
        hash: 'texture-seed',
        bytes: new Uint8Array(WIDTH * HEIGHT * 4).fill(23),
        compression: 'none',
      },
    ],
  };
}

describe.skipIf(SKIP_DAWN)('ReplaySession Dawn contract', () => {
  it('replays a triangle and returns attachment bytes through inspectWork', async () => {
    const pack = await loadDawn();
    const tape = triangleTape();
    const first = await openReplay(tape, {
      device: await freshDevice(pack),
      createShaderModule: pack.createShaderModule,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.hint);
    const baseline = await first.value.inspectWork(0, ['pixels']);
    expect(
      baseline.ok,
      baseline.ok ? undefined : `${baseline.error.code}: ${JSON.stringify(baseline.error.detail)}`,
    ).toBe(true);
    if (!baseline.ok) throw new Error(baseline.error.hint);
    expect(baseline.value.attachment?.bytes.byteLength).toBe(WIDTH * HEIGHT * 4);
    expect(baseline.value.attachment?.bytes.slice(0, 4)).toEqual(new Uint8Array([23, 23, 23, 23]));
    expect(baseline.value.attachment?.provenance.resourceId).toBe('texture-view:rt');
    expect(baseline.value.attachment?.provenance.selectedWorkIndex).toBe(0);
    expect(baseline.value.attachment?.provenance.subresource).toBeNull();

    const second = await openReplay(tape, {
      device: await freshDevice(pack),
      createShaderModule: pack.createShaderModule,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error.hint);
    const replay = await second.value.inspectWork(0, ['pixels']);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.hint);
    expect(replay.value.attachment?.bytes).toEqual(baseline.value.attachment?.bytes);
    expect((await first.value.dispose()).ok).toBe(true);
    expect((await second.value.dispose()).ok).toBe(true);
  }, 60_000);

  it('reports the first shader factory failure on a real Dawn device', async () => {
    const pack = await loadDawn();
    const device = await freshDevice(pack);
    const failingBackend: ReplayBackend = {
      device,
      createShaderModule: async () =>
        err(
          new RhiError({
            code: 'shader-compile-failed',
            expected: 'shader compilation succeeds',
            hint: 'test factory failure',
          }),
        ),
    };
    const replay = await openReplay(triangleTape(), failingBackend);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.hint);
    const inspection = await replay.value.inspectWork(0);
    expect(inspection.ok).toBe(false);
    if (!inspection.ok) {
      expect(inspection.error.code).toBe('replay-event-failed');
      if (inspection.error.code === 'replay-event-failed') {
        expect(inspection.error.detail?.kind).toBe('createShaderModule');
        expect(inspection.error.detail?.stage).toBe('create');
      }
    }
    expect((await replay.value.dispose()).ok).toBe(true);
  }, 60_000);
});
