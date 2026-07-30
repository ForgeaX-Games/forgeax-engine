import { describe, expect, it } from 'vitest';
import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import { recordRenderFeatureGraphicsPass } from '../record/frame-targets';

type RecordingLedger = {
  pipeline: number;
  binding: number;
  vertex: number;
  index: number;
  draw: number;
};

function ledger(): RecordingLedger {
  return { pipeline: 0, binding: 0, vertex: 0, index: 0, draw: 0 };
}

function ref<Kind extends RenderFeaturePreparedRef['kind']>(
  kind: Kind,
  generation = 3,
): RenderFeaturePreparedRef<Kind> {
  return { kind, generation };
}

const pipeline = ref('pipeline');
const bindings = ref('bindings');
const vertices = ref('vertex-data');
const indices = ref('index-data');

const pass: RenderFeatureGraphicsPassDescriptor = {
  attachments: {
    colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
  },
  draws: [
    {
      kind: 'draw',
      pipeline,
      bindings: [bindings],
      vertexData: [{ slot: 0, resource: vertices }],
      command: { vertexCount: 3, instanceCount: 1 },
    },
  ],
};

const state: RenderFeaturePreparedGraphicsState = {
  capabilityAvailable: true,
  generation: 3,
  attachments: [{ resource: 'color', format: 'rgba8unorm' }],
  pipeline,
  bindings: [bindings],
  vertexData: [vertices],
  indexData: [indices],
};

describe('host-owned prepared graphics recording', () => {
  it.each([
    ['pipeline', { pipeline: undefined }],
    ['bindings', { bindings: [] }],
    ['vertex', { vertexData: [] }],
    ['attachment', { attachments: [] }],
  ] as const)('rejects missing %s before any RHI mutation', (_label, change) => {
    const calls = ledger();
    const result = recordRenderFeatureGraphicsPass(
      'synthetic.invalid',
      pass,
      { ...state, ...change },
      calls,
    );
    expect(result.ok).toBe(false);
    expect(calls).toEqual(ledger());
  });

  it('rejects stale and foreign-kind records before recording the healthy feature', () => {
    const stale = ledger();
    const staleResult = recordRenderFeatureGraphicsPass(
      'synthetic.invalid',
      pass,
      { ...state, generation: 4 },
      stale,
    );
    expect(staleResult.ok).toBe(false);
    expect(stale).toEqual(ledger());

    const originalDraw = pass.draws[0];
    expect(originalDraw).toBeDefined();
    if (originalDraw === undefined) return;
    const foreign = ledger();
    const foreignResult = recordRenderFeatureGraphicsPass(
      'synthetic.invalid',
      { ...pass, draws: [{ ...originalDraw, pipeline: ref('bindings') as never }] },
      state,
      foreign,
    );
    expect(foreignResult.ok).toBe(false);
    expect(foreign).toEqual(ledger());
  });

  it('records a complete draw only after all validation succeeds', () => {
    const calls = ledger();
    const result = recordRenderFeatureGraphicsPass('synthetic.valid', pass, state, calls);
    expect(result).toMatchObject({ ok: true, value: { acceptedDrawCount: 1 } });
    expect(calls).toEqual({ pipeline: 1, binding: 1, vertex: 1, index: 0, draw: 1 });
  });
});
