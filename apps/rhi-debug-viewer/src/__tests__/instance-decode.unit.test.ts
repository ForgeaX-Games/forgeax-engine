// instance-decode.unit.test.ts — group-3 binding-0 InstanceData decoder unit tests (M3).
//
// Coverage:
//   1. Variant detection: stride 64 → 'mat4', stride 80 → 'mat4+region', stride 72 → 'unexpected-stride'
//   2. TRS math precision: translate(1,2,3) * rotateY(π/2) * scale(2,2,2) round-trip
//   3. Region variant: 'mat4+region' surfaces the [uMin, vMin, uW, vH] vec4
//   4. 'none' triggers: missing group-3 binding / instanceCount === 0 / non-buffer resource
//   5. 'no-blob': binding + resource present but tape blobPool has no bytes
//   6. 'buffer-truncated': gotBytes < 64 * instanceCount surfaces exact byte counts
//   7. Row-cap truncation: instanceCount = 300 → 256 rows + truncated=true
//
// Related: AC-03 / AC-04 / AC-05; plan-strategy §5.3.

// biome-ignore-all lint/style/noNonNullAssertion: test fixture element access is guarded by explicit loops with known lengths.
// biome-ignore-all lint/suspicious/noApproximativeNumericConstant: 0.7071 is the 4-decimal-rounded rotation output (AC-05); Math.SQRT1_2 (0.70710678...) would fail toBe() because the decoder rounds before returning.

import type { HandleId, InspectBindingEntry, RhiCallEvent, Tape } from '@forgeax/engine-rhi-debug';
import type {
  CreateDescriptor,
  DrawEntry,
  DrawPipelineState,
} from '@forgeax/engine-rhi-debug/frame-model';
import { describe, expect, it } from 'vitest';
import { decodeInstanceData, INSTANCE_MAX_ROWS } from '../instance-decode';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BUFFER_HANDLE: HandleId = 'buf-instances';
const BLOB_HASH = 'hash-instances';

function makeTape(events: readonly RhiCallEvent[], blob?: ArrayBuffer): Tape {
  const blobPool = new Map<string, ArrayBuffer>();
  if (blob) blobPool.set(BLOB_HASH, blob);
  return {
    formatVersion: 1,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm' as GPUTextureFormat,
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      storageBuffer: true,
      timestampQuery: false,
    },
    events,
    blobPool,
  };
}

function makeInitialDataEvent(
  handleId: HandleId = BUFFER_HANDLE,
  dataHash: string = BLOB_HASH,
): RhiCallEvent {
  return { kind: 'initialData', handleId, dataHash };
}

function makeBufferResource(handleId: HandleId = BUFFER_HANDLE): CreateDescriptor {
  return { kind: 'createBuffer', handleId, size: 0, usage: 0 };
}

function makeSamplerResource(handleId: HandleId): CreateDescriptor {
  return { kind: 'createSampler', handleId, desc: undefined };
}

function makeInstanceBinding(handleId: HandleId = BUFFER_HANDLE): InspectBindingEntry {
  return { groupIndex: 3, entryIndex: 0, handleId, kind: 'buffer' };
}

function makeDraw(opts: {
  bindings?: readonly InspectBindingEntry[];
  instanceCount?: number | undefined;
}): DrawEntry {
  return {
    frameIdx: 0,
    passIdx: 0,
    bindings: opts.bindings ?? [],
    drawCall: {
      pipelineKind: 'render',
      pipelineHandleId: 'pipe-0',
      vertexCount: 6,
      instanceCount: opts.instanceCount,
    },
    colorAttachmentHandleId: undefined,
    // The decoder never touches pipelineState / vertexBuffers / depthStencil —
    // an empty cast keeps this fixture minimal.
    pipelineState: {} as DrawPipelineState,
    vertexBuffers: new Map(),
    depthStencil: {
      depthStencilViewHandleId: undefined,
      depthStencilAttachment: undefined,
    },
  };
}

/** Identity mat4 as 16 column-major floats. */
function identityMat4Floats(): number[] {
  const m = new Array<number>(16).fill(0);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/**
 * Build a buffer holding N instances, each `stride` bytes. When `regions` is
 * provided the stride is 80 (mat4 + vec4); otherwise 64 (mat4 only).
 * `matsPerInstance[i]` must have length 16 (column-major floats).
 */
function buildInstanceBuffer(
  matsPerInstance: readonly (readonly number[])[],
  regions?: readonly (readonly number[])[],
): ArrayBuffer {
  const stride = regions ? 80 : 64;
  const buf = new ArrayBuffer(matsPerInstance.length * stride);
  const dv = new DataView(buf);
  for (let i = 0; i < matsPerInstance.length; i++) {
    const base = i * stride;
    const mat = matsPerInstance[i]!;
    for (let j = 0; j < 16; j++) {
      dv.setFloat32(base + j * 4, mat[j] ?? 0, true);
    }
    if (regions) {
      const region = regions[i]!;
      for (let j = 0; j < 4; j++) {
        dv.setFloat32(base + 64 + j * 4, region[j] ?? 0, true);
      }
    }
  }
  return buf;
}

/** Raw ArrayBuffer of given byte length, all zeros. */
function zeroBuffer(byteLength: number): ArrayBuffer {
  return new ArrayBuffer(byteLength);
}

// ---------------------------------------------------------------------------
// 1. Variant detection (AC-03)
// ---------------------------------------------------------------------------

describe('decodeInstanceData — variant detection (AC-03)', () => {
  it('stride 64 → variant "mat4" with 4-column rows', () => {
    const blob = buildInstanceBuffer([identityMat4Floats()]);
    const tape = makeTape([makeInitialDataEvent()], blob);
    const resources = new Map<HandleId, CreateDescriptor>([[BUFFER_HANDLE, makeBufferResource()]]);
    const draw = makeDraw({ bindings: [makeInstanceBinding()], instanceCount: 1 });

    const result = decodeInstanceData(draw, tape, resources);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.variant).toBe('mat4');
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]!.region).toBeUndefined();
  });

  it('stride 80 → variant "mat4+region" surfaces region column', () => {
    const region = [0.25, 0.5, 0.5, 0.5];
    const blob = buildInstanceBuffer([identityMat4Floats()], [region]);
    const tape = makeTape([makeInitialDataEvent()], blob);
    const resources = new Map<HandleId, CreateDescriptor>([[BUFFER_HANDLE, makeBufferResource()]]);
    const draw = makeDraw({ bindings: [makeInstanceBinding()], instanceCount: 1 });

    const result = decodeInstanceData(draw, tape, resources);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.variant).toBe('mat4+region');
    expect(result.instances[0]!.region).toEqual([0.25, 0.5, 0.5, 0.5]);
  });

  it('stride 72 (neither 64 nor 80, above 64-B floor) → unexpected-stride', () => {
    // instanceCount=1, gotBytes=72 → gotBytes > 64 → unexpected-stride, strideBytes=72
    const blob = zeroBuffer(72);
    const tape = makeTape([makeInitialDataEvent()], blob);
    const resources = new Map<HandleId, CreateDescriptor>([[BUFFER_HANDLE, makeBufferResource()]]);
    const draw = makeDraw({ bindings: [makeInstanceBinding()], instanceCount: 1 });

    const result = decodeInstanceData(draw, tape, resources);
    expect(result.kind).toBe('unexpected-stride');
    if (result.kind !== 'unexpected-stride') return;
    expect(result.strideBytes).toBe(72);
  });
});

// ---------------------------------------------------------------------------
// 2. TRS math precision (AC-05)
// ---------------------------------------------------------------------------

describe('decodeInstanceData — TRS math precision (AC-05)', () => {
  it('decodes translate(1,2,3) * rotateY(π/2) * scale(2,2,2)', () => {
    // Column-major mat4 for M = T * Ry(π/2) * S(2,2,2):
    //   col0 = [ 0, 0, -2, 0 ]   (Ry * S applied to x-axis, then translation w=0)
    //   col1 = [ 0, 2,  0, 0 ]
    //   col2 = [ 2, 0,  0, 0 ]
    //   col3 = [ 1, 2,  3, 1 ]
    const mat = [
      0,
      0,
      -2,
      0, // col0
      0,
      2,
      0,
      0, // col1
      2,
      0,
      0,
      0, // col2
      1,
      2,
      3,
      1, // col3 (translation + homogeneous)
    ];
    const blob = buildInstanceBuffer([mat]);
    const tape = makeTape([makeInitialDataEvent()], blob);
    const resources = new Map<HandleId, CreateDescriptor>([[BUFFER_HANDLE, makeBufferResource()]]);
    const draw = makeDraw({ bindings: [makeInstanceBinding()], instanceCount: 1 });

    const result = decodeInstanceData(draw, tape, resources);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const inst = result.instances[0]!;

    expect(inst.position).toEqual([1, 2, 3]);
    expect(inst.scale[0]).toBeCloseTo(2, 6);
    expect(inst.scale[1]).toBeCloseTo(2, 6);
    expect(inst.scale[2]).toBeCloseTo(2, 6);

    // Ry(π/2) quaternion = [0, sin(π/4), 0, cos(π/4)] ≈ [0, 0.7071, 0, 0.7071]
    expect(inst.rotation[0]).toBe(0);
    expect(inst.rotation[1]).toBe(0.7071);
    expect(inst.rotation[2]).toBe(0);
    expect(inst.rotation[3]).toBe(0.7071);
  });

  it('identity mat4 → position (0,0,0), scale (1,1,1), rotation (0,0,0,1)', () => {
    const blob = buildInstanceBuffer([identityMat4Floats()]);
    const tape = makeTape([makeInitialDataEvent()], blob);
    const resources = new Map<HandleId, CreateDescriptor>([[BUFFER_HANDLE, makeBufferResource()]]);
    const draw = makeDraw({ bindings: [makeInstanceBinding()], instanceCount: 1 });

    const result = decodeInstanceData(draw, tape, resources);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const inst = result.instances[0]!;
    expect(inst.position).toEqual([0, 0, 0]);
    expect(inst.scale).toEqual([1, 1, 1]);
    expect(inst.rotation).toEqual([0, 0, 0, 1]);
  });

  it('singular mat4 (all-zero) → identity quaternion fallback, position/scale still resolve', () => {
    const zeroMat = new Array<number>(16).fill(0);
    const blob = buildInstanceBuffer([zeroMat]);
    const tape = makeTape([makeInitialDataEvent()], blob);
    const resources = new Map<HandleId, CreateDescriptor>([[BUFFER_HANDLE, makeBufferResource()]]);
    const draw = makeDraw({ bindings: [makeInstanceBinding()], instanceCount: 1 });

    const result = decodeInstanceData(draw, tape, resources);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const inst = result.instances[0]!;
    expect(inst.position).toEqual([0, 0, 0]);
    expect(inst.scale).toEqual([0, 0, 0]);
    expect(inst.rotation).toEqual([0, 0, 0, 1]);
  });
});

// ---------------------------------------------------------------------------
// 3. 'none' triggers (AC-04 + boundary table)
// ---------------------------------------------------------------------------

describe('decodeInstanceData — "none" triggers (AC-04)', () => {
  it('no group-3 binding-0 (e.g. fullscreen tonemap pass) → none', () => {
    const tape = makeTape([]);
    const resources = new Map<HandleId, CreateDescriptor>();
    // Draw with an unrelated binding, no group=3 entry=0
    const otherBinding: InspectBindingEntry = {
      groupIndex: 0,
      entryIndex: 0,
      handleId: 'buf-uniforms',
      kind: 'buffer',
    };
    const draw = makeDraw({ bindings: [otherBinding], instanceCount: 4 });

    expect(decodeInstanceData(draw, tape, resources).kind).toBe('none');
  });

  it('instanceCount === 0 → none (aligns with missing-binding semantics)', () => {
    const blob = buildInstanceBuffer([identityMat4Floats()]);
    const tape = makeTape([makeInitialDataEvent()], blob);
    const resources = new Map<HandleId, CreateDescriptor>([[BUFFER_HANDLE, makeBufferResource()]]);
    const draw = makeDraw({ bindings: [makeInstanceBinding()], instanceCount: 0 });

    expect(decodeInstanceData(draw, tape, resources).kind).toBe('none');
  });

  it('binding points at a non-buffer resource (sampler) → none', () => {
    const samplerHandle: HandleId = 'sampler-0';
    const tape = makeTape([]);
    const resources = new Map<HandleId, CreateDescriptor>([
      [samplerHandle, makeSamplerResource(samplerHandle)],
    ]);
    const draw = makeDraw({
      bindings: [makeInstanceBinding(samplerHandle)],
      instanceCount: 4,
    });

    expect(decodeInstanceData(draw, tape, resources).kind).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// 4. 'no-blob' — binding present but tape blobPool has no bytes
// ---------------------------------------------------------------------------

describe('decodeInstanceData — no-blob boundary', () => {
  it('binding + buffer resource but no initialData/writeBuffer event → no-blob', () => {
    // Tape has zero events → nothing populates blobPool for this handle.
    const tape = makeTape([]);
    const resources = new Map<HandleId, CreateDescriptor>([[BUFFER_HANDLE, makeBufferResource()]]);
    const draw = makeDraw({ bindings: [makeInstanceBinding()], instanceCount: 4 });

    expect(decodeInstanceData(draw, tape, resources).kind).toBe('no-blob');
  });
});

// ---------------------------------------------------------------------------
// 5. 'buffer-truncated' — bytes below the 64 * instanceCount floor
// ---------------------------------------------------------------------------

describe('decodeInstanceData — buffer-truncated boundary', () => {
  it('bytes < 64 * instanceCount → buffer-truncated with exact byte counts', () => {
    // instanceCount=4 → expect 256 B for mat4 variant, provide 200.
    const blob = zeroBuffer(200);
    const tape = makeTape([makeInitialDataEvent()], blob);
    const resources = new Map<HandleId, CreateDescriptor>([[BUFFER_HANDLE, makeBufferResource()]]);
    const draw = makeDraw({ bindings: [makeInstanceBinding()], instanceCount: 4 });

    const result = decodeInstanceData(draw, tape, resources);
    expect(result.kind).toBe('buffer-truncated');
    if (result.kind !== 'buffer-truncated') return;
    expect(result.gotBytes).toBe(200);
    expect(result.expectedBytes).toBe(256);
  });
});

// ---------------------------------------------------------------------------
// 6. Row-cap truncation — instanceCount > INSTANCE_MAX_ROWS
// ---------------------------------------------------------------------------

describe('decodeInstanceData — row-cap truncation', () => {
  it('instanceCount > 256 → first 256 rows, truncated=true', () => {
    const N = 300;
    const mats: number[][] = [];
    for (let i = 0; i < N; i++) {
      const m = identityMat4Floats();
      // Distinct translation per row so we can spot truncation ordering.
      m[12] = i;
      mats.push(m);
    }
    const blob = buildInstanceBuffer(mats);
    const tape = makeTape([makeInitialDataEvent()], blob);
    const resources = new Map<HandleId, CreateDescriptor>([[BUFFER_HANDLE, makeBufferResource()]]);
    const draw = makeDraw({ bindings: [makeInstanceBinding()], instanceCount: N });

    const result = decodeInstanceData(draw, tape, resources);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.variant).toBe('mat4');
    expect(result.instances).toHaveLength(INSTANCE_MAX_ROWS);
    expect(result.truncated).toBe(true);
    // First row keeps its translation; last visible row = index 255.
    expect(result.instances[0]!.position[0]).toBe(0);
    expect(result.instances[INSTANCE_MAX_ROWS - 1]!.position[0]).toBe(INSTANCE_MAX_ROWS - 1);
  });

  it('instanceCount <= 256 → truncated=false', () => {
    const blob = buildInstanceBuffer([identityMat4Floats(), identityMat4Floats()]);
    const tape = makeTape([makeInitialDataEvent()], blob);
    const resources = new Map<HandleId, CreateDescriptor>([[BUFFER_HANDLE, makeBufferResource()]]);
    const draw = makeDraw({ bindings: [makeInstanceBinding()], instanceCount: 2 });

    const result = decodeInstanceData(draw, tape, resources);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.truncated).toBe(false);
    expect(result.instances).toHaveLength(2);
  });
});
