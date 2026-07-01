// buffer-binding.test.ts — AC-06 buffer↔draw binding relation parsing (w8).
//
// Pure function tests for extracting buffer→consumer mappings:
//   (a) vertex buffer slot → draw
//   (b) index buffer → draw
//   (c) bind group binding → buffer
//
// Imports from ../buffer-binding.ts — created in w11 impl.
//
// Related: requirements AC-06; plan-strategy 5.1 TDD red-green.

// biome-ignore-all lint/style/noNonNullAssertion: test assertions on indexed array elements are guarded by length checks (expect(...).toBeDefined() / toHaveLength(N) precede each non-null assertion) — the non-null assertion signals "we already verified length/defined above" rather than suppressing a real possibility of undefined. Same idiom as viewer-model.unit.test.ts:13.

import type { RhiCallEvent } from '@forgeax/engine-rhi-debug';
import type { DrawEntry } from '@forgeax/engine-rhi-debug/frame-model';
import { describe, expect, it } from 'vitest';
import { bufferBindingConsumers } from '../buffer-binding';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

type HandleId = string;

function stubDraw(
  passIdx: number,
  overrides: {
    vertexBuffers?: Map<number, HandleId>;
  } = {},
): DrawEntry {
  return {
    frameIdx: 0,
    passIdx,
    bindings: [],
    drawCall: {
      pipelineKind: 'render',
      pipelineHandleId: 'pipe:1',
      vertexCount: 3,
      instanceCount: 1,
    },
    colorAttachmentHandleId: 'tv:1',
    pipelineState: {
      inputAssembly: { topology: 'triangle-list' as const, stripIndexFormat: undefined },
      vertexInput: { buffers: [] },
      shaders: { vertexShaderModuleHandleId: 'sm:vs', fragmentShaderModuleHandleId: 'sm:fs' },
      rasterizer: { cullMode: 'back' as const, frontFace: 'ccw' as const },
      depthStencil: {
        format: 'depth32float' as const,
        depthWriteEnabled: true,
        depthCompare: 'less' as const,
        stencilFront: {
          compare: 'always',
          failOp: 'keep',
          depthFailOp: 'keep',
          passOp: 'keep',
        } as const,
        stencilBack: {
          compare: 'always',
          failOp: 'keep',
          depthFailOp: 'keep',
          passOp: 'keep',
        } as const,
        stencilReadMask: 0xff,
        stencilWriteMask: 0xff,
        depthBias: 0,
        depthBiasSlopeScale: 0,
        depthBiasClamp: 0,
        stencilReference: 0,
      },
      blend: { colorTargets: [], blendConstant: undefined },
      multisample: { count: 1, mask: 0xffffffff, alphaToCoverageEnabled: false },
    },
    vertexBuffers: overrides.vertexBuffers ?? new Map(),
    depthStencil: {
      depthStencilViewHandleId: undefined,
      depthStencilAttachment: undefined,
    },
  };
}

// --------------------------------------------------------------------------
// AC-06a: vertex buffer → draw
// --------------------------------------------------------------------------

describe('AC-06a: vertex buffer slot → draw', () => {
  it('maps buffer to draw via DrawEntry.vertexBuffers', () => {
    const vb = new Map<number, HandleId>();
    vb.set(0, 'buf-vbo');
    vb.set(1, 'buf-instanceData');

    const draws: readonly DrawEntry[] = [stubDraw(0, { vertexBuffers: vb })];

    const result = bufferBindingConsumers(draws, []);

    const vboConsumers = result.get('buf-vbo');
    expect(vboConsumers).toBeDefined();
    expect(vboConsumers).toHaveLength(1);
    expect(vboConsumers![0]!.drawIdx).toBe(0);
    expect(vboConsumers![0]!.role).toBe('vertex');
    expect(vboConsumers![0]!.slot).toBe(0);
    expect(vboConsumers![0]!.stride).toBeUndefined();
  });

  it('maps a buffer referenced by multiple draws in same/different passes', () => {
    const vb0 = new Map<number, HandleId>();
    vb0.set(0, 'buf-shared');
    const vb1 = new Map<number, HandleId>();
    vb1.set(0, 'buf-shared');

    const draws: readonly DrawEntry[] = [
      stubDraw(0, { vertexBuffers: vb0 }),
      stubDraw(1, { vertexBuffers: vb1 }),
    ];

    const result = bufferBindingConsumers(draws, []);

    const consumers = result.get('buf-shared');
    expect(consumers).toBeDefined();
    expect(consumers).toHaveLength(2);
    expect(consumers![0]!.drawIdx).toBe(0);
    expect(consumers![1]!.drawIdx).toBe(1);
  });

  it('returns undefined for buffer not referenced by any draw', () => {
    const vb = new Map<number, HandleId>();
    vb.set(0, 'buf-used');

    const draws: readonly DrawEntry[] = [stubDraw(0, { vertexBuffers: vb })];

    const result = bufferBindingConsumers(draws, []);

    expect(result.get('buf-unused')).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// AC-06b: index buffer -> draw
// --------------------------------------------------------------------------

describe('AC-06b: index buffer -> draw', () => {
  it('finds draw consumer from setIndexBuffer event', () => {
    const draws: readonly DrawEntry[] = [stubDraw(0)];

    const events: readonly RhiCallEvent[] = [
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:0',
        passHandleId: 'p:0',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'setIndexBuffer', passHandleId: 'p:0', bufferHandleId: 'buf-ibo', format: 'uint16' },
    ];

    const result = bufferBindingConsumers(draws, events);

    const iboConsumers = result.get('buf-ibo');
    expect(iboConsumers).toBeDefined();
    expect(iboConsumers).toHaveLength(1);
    expect(iboConsumers![0]!.drawIdx).toBe(0);
    expect(iboConsumers![0]!.role).toBe('index');
  });

  it('maps format from setIndexBuffer event', () => {
    const draws: readonly DrawEntry[] = [stubDraw(0)];

    const events: readonly RhiCallEvent[] = [
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:0',
        passHandleId: 'p:0',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'setIndexBuffer',
        passHandleId: 'p:0',
        bufferHandleId: 'buf-ibo32',
        format: 'uint32',
      },
    ];

    const result = bufferBindingConsumers(draws, events);

    const consumers = result.get('buf-ibo32');
    expect(consumers).toBeDefined();
    expect(consumers![0]!.details).toContain('uint32');
  });
});

// --------------------------------------------------------------------------
// AC-06c: bind group binding → buffer
// --------------------------------------------------------------------------

describe('AC-06c: bind group binding → buffer', () => {
  it('finds buffer via setBindGroup → createBindGroup → entries', () => {
    const draws: readonly DrawEntry[] = [stubDraw(0)];

    const events: readonly RhiCallEvent[] = [
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:0',
        passHandleId: 'p:0',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'createBindGroup',
        handleId: 'bg:0',
        layoutHandleId: 'bgl:0',
        entries: [
          { binding: 0, resourceKind: 'buffer', bufferOffset: 16, bufferSize: 64 },
          { binding: 1, resourceKind: 'sampler' },
        ],
        resourceHandleIds: ['buf-ubo', 'sampler-1'],
      },
      { kind: 'setBindGroup', passHandleId: 'p:0', index: 0, bindGroupHandleId: 'bg:0' },
    ];

    const result = bufferBindingConsumers(draws, events);

    const uboConsumers = result.get('buf-ubo');
    expect(uboConsumers).toBeDefined();
    expect(uboConsumers).toHaveLength(1);
    expect(uboConsumers![0]!.drawIdx).toBe(0);
    expect(uboConsumers![0]!.role).toBe('bindGroup');
    expect(uboConsumers![0]!.groupIndex).toBe(0);
    expect(uboConsumers![0]!.entryIndex).toBe(0);
  });

  it('sampler resource in bind group is NOT treated as buffer consumer', () => {
    const draws: readonly DrawEntry[] = [stubDraw(0)];

    const events: readonly RhiCallEvent[] = [
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:0',
        passHandleId: 'p:0',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'createBindGroup',
        handleId: 'bg:0',
        layoutHandleId: 'bgl:0',
        entries: [{ binding: 1, resourceKind: 'sampler' }],
        resourceHandleIds: ['sampler-1'],
      },
      { kind: 'setBindGroup', passHandleId: 'p:0', index: 0, bindGroupHandleId: 'bg:0' },
    ];

    const result = bufferBindingConsumers(draws, events);

    // sampler-1 is NOT a buffer → should not appear
    expect(result.get('sampler-1')).toBeUndefined();
  });

  it('buffer in bind group with offset/size shows sub-range', () => {
    const draws: readonly DrawEntry[] = [stubDraw(0)];

    const events: readonly RhiCallEvent[] = [
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:0',
        passHandleId: 'p:0',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'createBindGroup',
        handleId: 'bg:0',
        layoutHandleId: 'bgl:0',
        entries: [{ binding: 2, resourceKind: 'buffer', bufferOffset: 256, bufferSize: 64 }],
        resourceHandleIds: ['buf-storage'],
      },
      { kind: 'setBindGroup', passHandleId: 'p:0', index: 0, bindGroupHandleId: 'bg:0' },
    ];

    const result = bufferBindingConsumers(draws, events);

    const consumers = result.get('buf-storage');
    expect(consumers).toBeDefined();
    expect(consumers).toHaveLength(1);
    expect(consumers![0]!.details).toContain('offset=256');
  });
});

// --------------------------------------------------------------------------
// AC-06: mixed paths — vertex + index + bindGroup on same buffer
// --------------------------------------------------------------------------

describe('AC-06: mixed binding paths', () => {
  it('buffer used as both vertex buffer and bind group shows both consumers', () => {
    const vb = new Map<number, HandleId>();
    vb.set(0, 'buf-multi');

    const draws: readonly DrawEntry[] = [stubDraw(0, { vertexBuffers: vb })];

    const events: readonly RhiCallEvent[] = [
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:0',
        passHandleId: 'p:0',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'createBindGroup',
        handleId: 'bg:0',
        layoutHandleId: 'bgl:0',
        entries: [{ binding: 0, resourceKind: 'buffer' }],
        resourceHandleIds: ['buf-multi'],
      },
      { kind: 'setBindGroup', passHandleId: 'p:0', index: 0, bindGroupHandleId: 'bg:0' },
    ];

    const result = bufferBindingConsumers(draws, events);

    const consumers = result.get('buf-multi');
    expect(consumers).toBeDefined();
    expect(consumers).toHaveLength(2); // vertex + bindGroup
    const roles = consumers!.map((c: { role: string }) => c.role).sort();
    expect(roles).toEqual(['bindGroup', 'vertex']);
  });
});
