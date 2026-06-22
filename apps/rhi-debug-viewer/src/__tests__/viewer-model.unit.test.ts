// viewer-model.unit.test.ts — buildViewModel assertions against fixture tape (TDD red: viewer-model.ts not yet created).
//
// w10: fixture tape tree/draws structure
// w11: compute-mixed fixture + empty tape boundary + multi-pass render-only
//
// Violated import (viewer-model.ts does not exist yet) is the expected TDD red state.
// Once w13 creates viewer-model.ts, all assertions turn green.
//
// Related: plan-strategy D-4 (zero-copy ViewModel); AC-02 (tree == computePassOffsets);
//   AC-03/AC-04 (compute pass in tree); AC-05 (draws[idx].bindings from extractDrawInfo);
//   AC-11 (empty tape produces empty state).

// biome-ignore-all lint/style/noNonNullAssertion: test assertions on indexed array elements are guarded by length checks — the non-null assertion signals "we already verified length above" rather than suppressing a real possibility of undefined

import type { RhiCallEvent, Tape } from '@forgeax/engine-rhi-debug';
import { computePassOffsets, deserializeTape } from '@forgeax/engine-rhi-debug';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs fixture builder has no .d.ts; runtime-only import
import { buildHelloCubeFixture } from '../../fixtures/build-hello-cube-tape.mjs';
import type { ViewModel } from '../viewer-model';
import { buildViewModel } from '../viewer-model';

// ============================================================================
// w10 fixtures — hello-cube fixture built in-memory (zero-binary invariant:
// no committed .tape.bin; bytes synthesised at test time, grep:no-binary-assets)
// ============================================================================

function loadHelloCubeTape(): Tape {
  const { json, blob } = buildHelloCubeFixture();
  const result = deserializeTape(json, blob);
  if (!result.ok) throw new Error(`deserializeTape failed: ${result.error.code}`);
  return result.value;
}

// ============================================================================
// w11 fixtures — hand-built compute-mixed events
// ============================================================================

function makeComputeMixedEvents(): readonly RhiCallEvent[] {
  const events: RhiCallEvent[] = [
    {
      kind: 'frameMark',
      frameIdx: 0,
    },
    // -- Render pass 1 (with draw) --
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:1',
      passHandleId: 'pass:1',
      desc: { colorAttachments: [] },
      colorAttachmentViewHandleIds: ['tv:1'],
    },
    {
      kind: 'setPipeline',
      passHandleId: 'pass:1',
      pipelineHandleId: 'pipe:render',
    },
    {
      kind: 'draw',
      passHandleId: 'pass:1',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    {
      kind: 'endRenderPass',
      passHandleId: 'pass:1',
    },
    // -- Compute pass (with dispatchWorkgroups) --
    {
      kind: 'beginComputePass',
      cmdHandleId: 'cmd:2',
      passHandleId: 'pass:2',
    },
    {
      kind: 'setComputePipeline',
      passHandleId: 'pass:2',
      pipelineHandleId: 'pipe:compute',
    },
    {
      kind: 'dispatchWorkgroups',
      passHandleId: 'pass:2',
      x: 4,
      y: 1,
      z: 1,
    },
    {
      kind: 'endComputePass',
      passHandleId: 'pass:2',
    },
    // -- Render pass 2 (with draw) --
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:3',
      passHandleId: 'pass:3',
      desc: { colorAttachments: [] },
      colorAttachmentViewHandleIds: ['tv:2'],
    },
    {
      kind: 'setPipeline',
      passHandleId: 'pass:3',
      pipelineHandleId: 'pipe:render2',
    },
    {
      kind: 'draw',
      passHandleId: 'pass:3',
      vertexCount: 6,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    {
      kind: 'endRenderPass',
      passHandleId: 'pass:3',
    },
  ];
  return events;
}

function makeMultiPassRenderOnlyEvents(): readonly RhiCallEvent[] {
  const events: RhiCallEvent[] = [
    {
      kind: 'frameMark',
      frameIdx: 0,
    },
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:1',
      passHandleId: 'pass:1',
      desc: { colorAttachments: [] },
      colorAttachmentViewHandleIds: ['tv:1'],
    },
    {
      kind: 'draw',
      passHandleId: 'pass:1',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    {
      kind: 'endRenderPass',
      passHandleId: 'pass:1',
    },
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:2',
      passHandleId: 'pass:2',
      desc: { colorAttachments: [] },
      colorAttachmentViewHandleIds: ['tv:2'],
    },
    {
      kind: 'draw',
      passHandleId: 'pass:2',
      vertexCount: 6,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    {
      kind: 'draw',
      passHandleId: 'pass:2',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    {
      kind: 'endRenderPass',
      passHandleId: 'pass:2',
    },
  ];
  return events;
}

function makeEmptyPassBeforeDrawEvents(): readonly RhiCallEvent[] {
  const events: RhiCallEvent[] = [
    {
      kind: 'frameMark',
      frameIdx: 0,
    },
    // Empty render pass A (no draw — clear/present only)
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:1',
      passHandleId: 'pass:A',
      desc: { colorAttachments: [] },
      colorAttachmentViewHandleIds: ['tv:clear'],
    },
    {
      kind: 'endRenderPass',
      passHandleId: 'pass:A',
    },
    // Render pass B with one draw
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:2',
      passHandleId: 'pass:B',
      desc: { colorAttachments: [] },
      colorAttachmentViewHandleIds: ['tv:draw'],
    },
    {
      kind: 'setPipeline',
      passHandleId: 'pass:B',
      pipelineHandleId: 'pipe:1',
    },
    {
      kind: 'draw',
      passHandleId: 'pass:B',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    {
      kind: 'endRenderPass',
      passHandleId: 'pass:B',
    },
  ];
  return events;
}

function makeEmptyTape(): Tape {
  return makeTapeFromEventsBase([], {});
}

function makeTapeFromEventsBase(
  events: readonly RhiCallEvent[],
  blobPoolOverrides: Record<string, ArrayBuffer>,
): Tape {
  const blobPool = new Map<string, ArrayBuffer>(Object.entries(blobPoolOverrides));
  return {
    formatVersion: 1,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm' as GPUTextureFormat,
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompression: false,
      storageBuffer: false,
      timestampQuery: false,
    },
    events,
    blobPool,
  };
}

function makeTapeFromEvents(events: readonly RhiCallEvent[]): Tape {
  return makeTapeFromEventsBase(events, {});
}

// ============================================================================
// w10 tests — fixture tape ViewModel structure
// ============================================================================

describe('buildViewModel — hello-cube fixture (w10)', () => {
  let vm: ViewModel;

  beforeAll(() => {
    const tape = loadHelloCubeTape();
    vm = buildViewModel(tape);
  });

  it('tree has single render pass with 1 draw', () => {
    expect(vm.tree).toHaveLength(1);
    expect(vm.tree[0]?.kind).toBe('render');
    expect(vm.tree[0]?.draws).toHaveLength(1);
    expect(vm.tree[0]?.draws[0]?.eventKind).toBe('draw');
    expect(vm.tree[0]?.draws[0]?.drawIdx).toBe(0);
  });

  it('passIdx numbering starts at 0', () => {
    expect(vm.tree[0]?.passIdx).toBe(0);
  });

  it('draws array has single entry with correct fields', () => {
    expect(vm.draws).toHaveLength(1);
    const d = vm.draws[0]!;

    // passIdx computed via findPassIdx
    expect(d.passIdx).toBe(0);
    expect(d.frameIdx).toBe(0);

    // bindings are populated from extractDrawInfo (non-empty for hello-cube with BGL)
    expect(d.bindings).toBeDefined();
    expect(Array.isArray(d.bindings)).toBe(true);

    // drawCall has expected shape
    expect(d.drawCall).toBeDefined();
    expect(d.drawCall.pipelineKind).toBe('render');
    expect(typeof d.drawCall.pipelineHandleId).toBe('string');
    expect(d.drawCall.vertexCount).toBe(3);

    // colorAttachmentHandleId is string (from beginRenderPass)
    expect(typeof d.colorAttachmentHandleId).toBe('string');
  });

  it('meta reflects single-pass single-frame tape', () => {
    expect(vm.meta.totalDraws).toBe(1);
    expect(vm.meta.totalPasses).toBe(1);
    expect(vm.meta.hasCompute).toBe(false);
  });

  it('AC-02: tree == computePassOffsets (pass/draw counts)', () => {
    // Each PassNode's draw count equals (endDrawIdx - startDrawIdx + 1)
    // from the corresponding PassOffset computed on the same events.
    const tape = loadHelloCubeTape();
    const offsets = computePassOffsets(tape.events);

    expect(vm.tree.length).toBe(offsets.length);
    for (let i = 0; i < offsets.length; i++) {
      const offset = offsets[i]!;
      const node = vm.tree[i]!;
      const expectedDrawCount = offset.endDrawIdx - offset.startDrawIdx + 1;
      expect(node.draws.length).toBe(expectedDrawCount);
    }
  });
});

// ============================================================================
// w11 tests — compute-mixed fixture
// ============================================================================

describe('buildViewModel — compute-mixed fixture (w11)', () => {
  let vm: ViewModel;

  beforeAll(() => {
    const events = makeComputeMixedEvents();
    const tape = makeTapeFromEvents(events);
    vm = buildViewModel(tape);
  });

  it('tree has 3 entries: render / compute / render', () => {
    expect(vm.tree).toHaveLength(3);
    expect(vm.tree[0]?.kind).toBe('render');
    expect(vm.tree[1]?.kind).toBe('compute');
    expect(vm.tree[2]?.kind).toBe('render');
  });

  it('passIdx is contiguous 0,1,2', () => {
    expect(vm.tree[0]?.passIdx).toBe(0);
    expect(vm.tree[1]?.passIdx).toBe(1);
    expect(vm.tree[2]?.passIdx).toBe(2);
  });

  it('render pass 0 has 1 draw, compute pass has 1 dispatch, render pass 1 has 1 draw', () => {
    expect(vm.tree[0]?.draws).toHaveLength(1);
    expect(vm.tree[0]?.draws[0]?.eventKind).toBe('draw');

    expect(vm.tree[1]?.draws).toHaveLength(1);
    expect(vm.tree[1]?.draws[0]?.eventKind).toBe('dispatchWorkgroups');

    expect(vm.tree[2]?.draws).toHaveLength(1);
    expect(vm.tree[2]?.draws[0]?.eventKind).toBe('draw');
  });

  it('draws array has 3 entries with correct passIdx', () => {
    expect(vm.draws).toHaveLength(3);
    expect(vm.draws[0]?.passIdx).toBe(0);
    expect(vm.draws[1]?.passIdx).toBe(1);
    expect(vm.draws[2]?.passIdx).toBe(2);
  });

  it('compute draw entry has pipelineKind compute', () => {
    expect(vm.draws[1]?.drawCall.pipelineKind).toBe('compute');
  });

  it('AC-03/AC-04: compute pass appears in tree with dispatch sub-item', () => {
    const computeNode = vm.tree.find((n) => n.kind === 'compute');
    expect(computeNode).toBeDefined();
    expect(computeNode?.draws.length).toBeGreaterThanOrEqual(1);
    expect(computeNode?.draws[0]?.eventKind).toBe('dispatchWorkgroups');
  });

  it('meta reflects mixed tree', () => {
    expect(vm.meta.totalDraws).toBe(3);
    expect(vm.meta.totalPasses).toBe(3);
    expect(vm.meta.hasCompute).toBe(true);
  });

  it('AC-02: tree pass/draw counts match computePassOffsets', () => {
    const events = makeComputeMixedEvents();
    const tape = makeTapeFromEvents(events);
    const offsets = computePassOffsets(tape.events);

    expect(vm.tree.length).toBe(offsets.length);
    for (let i = 0; i < offsets.length; i++) {
      const offset = offsets[i]!;
      const node = vm.tree[i]!;
      const expectedDrawCount = offset.endDrawIdx - offset.startDrawIdx + 1;
      expect(node.draws.length).toBe(expectedDrawCount);
    }
  });
});

// ============================================================================
// w11 tests — empty tape boundary
// ============================================================================

describe('buildViewModel — empty tape (w11)', () => {
  let vm: ViewModel;

  beforeAll(() => {
    const tape = makeEmptyTape();
    vm = buildViewModel(tape);
  });

  it('AC-11: empty tape produces empty state', () => {
    expect(vm.tree).toEqual([]);
    expect(vm.draws).toEqual([]);
  });

  it('meta reflects empty tape', () => {
    expect(vm.meta.totalDraws).toBe(0);
    expect(vm.meta.totalPasses).toBe(0);
    expect(vm.meta.hasCompute).toBe(false);
  });
});

// ============================================================================
// w11 tests — multi-pass render-only tape
// ============================================================================

describe('buildViewModel — multi-pass render-only (w11)', () => {
  let vm: ViewModel;

  beforeAll(() => {
    const events = makeMultiPassRenderOnlyEvents();
    const tape = makeTapeFromEvents(events);
    vm = buildViewModel(tape);
  });

  it('tree has 2 render entries', () => {
    expect(vm.tree).toHaveLength(2);
    expect(vm.tree[0]?.kind).toBe('render');
    expect(vm.tree[1]?.kind).toBe('render');
  });

  it('pass 0 has 1 draw, pass 1 has 2 draws', () => {
    expect(vm.tree[0]?.draws).toHaveLength(1);
    expect(vm.tree[1]?.draws).toHaveLength(2);
  });

  it('meta reflects 2 render passes', () => {
    expect(vm.meta.totalDraws).toBe(3);
    expect(vm.meta.totalPasses).toBe(2);
    expect(vm.meta.hasCompute).toBe(false);
  });

  it('AC-02: pass/draw counts match computePassOffsets', () => {
    const events = makeMultiPassRenderOnlyEvents();
    const tape = makeTapeFromEvents(events);
    const offsets = computePassOffsets(tape.events);

    expect(vm.tree.length).toBe(offsets.length);
    for (let i = 0; i < offsets.length; i++) {
      const offset = offsets[i]!;
      const node = vm.tree[i]!;
      const expectedDrawCount = offset.endDrawIdx - offset.startDrawIdx + 1;
      expect(node.draws.length).toBe(expectedDrawCount);
    }
  });
});

// ============================================================================
// F-3 tests — empty pass before non-empty pass (fix: empty range, no collision)
// ============================================================================

describe('buildViewModel — empty pass before draw pass (F-3)', () => {
  let vm: ViewModel;

  beforeAll(() => {
    const events = makeEmptyPassBeforeDrawEvents();
    const tape = makeTapeFromEvents(events);
    vm = buildViewModel(tape);
  });

  it('tree has 2 entries (empty pass A + draw pass B)', () => {
    expect(vm.tree).toHaveLength(2);
    expect(vm.tree[0]?.kind).toBe('render');
    expect(vm.tree[1]?.kind).toBe('render');
  });

  it('empty pass (A) produces 0 draws in tree node', () => {
    expect(vm.tree[0]?.draws).toHaveLength(0);
  });

  it('non-empty pass (B) produces 1 draw in tree node', () => {
    expect(vm.tree[1]?.draws).toHaveLength(1);
    expect(vm.tree[1]?.draws[0]?.drawIdx).toBe(0);
  });

  it('no drawIdx collision: empty pass A draw count = 0, pass B draw = [0]', () => {
    // Pass A should contribute 0 draws, Pass B should have the only draw.
    // Collision would be: both passes reference the same draw.
    // drawIdx is implicit as the array index in vm.draws.
    const allDraws = vm.draws;
    expect(allDraws).toHaveLength(1);
    expect(allDraws[0]!.passIdx).toBe(1); // Pass B (not Pass A)
  });

  it('AC-02: pass/draw counts match computePassOffsets (empty range gives 0 draws)', () => {
    const events = makeEmptyPassBeforeDrawEvents();
    const tape = makeTapeFromEvents(events);
    const offsets = computePassOffsets(tape.events);

    expect(vm.tree.length).toBe(offsets.length);
    for (let i = 0; i < offsets.length; i++) {
      const offset = offsets[i]!;
      const node = vm.tree[i]!;
      const expectedDrawCount = offset.endDrawIdx - offset.startDrawIdx + 1;
      expect(node.draws.length).toBe(expectedDrawCount);
      if (i === 0) {
        expect(offset.startDrawIdx).toBe(0);
        expect(offset.endDrawIdx).toBe(-1);
        expect(expectedDrawCount).toBe(0);
        expect(node.draws.length).toBe(0);
      }
    }
  });
});
