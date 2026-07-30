import { describe, expect, it } from 'vitest';
import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import { recordRenderFeatureGraphicsPass } from '../record/frame-targets';

type MatrixResult = {
  readonly acceptedCount: number;
  readonly errorCode: string | null;
  readonly operation: string | null;
  readonly reason: string | null;
  readonly generation: number;
  readonly releaseCount: number;
};

const ref = <Kind extends RenderFeaturePreparedRef['kind']>(
  kind: Kind,
  generation = 1,
): RenderFeaturePreparedRef<Kind> => ({ kind, generation });

const pipeline = ref('pipeline');
const bindings = ref('bindings');
const vertices = ref('vertex-data');

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
  generation: 1,
  attachments: [{ resource: 'color', format: 'rgba8unorm' }],
  pipeline,
  bindings: [bindings],
  vertexData: [vertices],
  indexData: [],
};

function runCase(
  descriptor: RenderFeatureGraphicsPassDescriptor,
  projectedState: RenderFeaturePreparedGraphicsState,
): MatrixResult {
  const result = recordRenderFeatureGraphicsPass(
    'synthetic.backend-matrix',
    descriptor,
    projectedState,
    { pipeline: 0, binding: 0, vertex: 0, index: 0, draw: 0 },
  );
  if (result.ok) {
    return {
      acceptedCount: result.value.acceptedDrawCount,
      errorCode: null,
      operation: null,
      reason: null,
      generation: projectedState.generation,
      releaseCount: 0,
    };
  }
  const detail = 'detail' in result.error ? result.error.detail : undefined;
  return {
    acceptedCount: 0,
    errorCode: result.error.code,
    operation: detail !== undefined && 'operation' in detail ? detail.operation : null,
    reason: detail !== undefined && 'reason' in detail ? detail.reason : null,
    generation: projectedState.generation,
    releaseCount: 0,
  };
}

const cases = [
  { name: 'accepted', descriptor: pass, projectedState: state },
  {
    name: 'missing capability',
    descriptor: pass,
    projectedState: { ...state, capabilityAvailable: false },
  },
  {
    name: 'stale generation',
    descriptor: pass,
    projectedState: { ...state, generation: 2 },
  },
] as const;

describe('prepared graphics backend case matrix', () => {
  it.each(cases)('keeps fixed comparison fields for $name', ({ descriptor, projectedState }) => {
    const first = runCase(descriptor, projectedState);
    const second = runCase(descriptor, projectedState);
    expect(Object.keys(first)).toEqual([
      'acceptedCount',
      'errorCode',
      'operation',
      'reason',
      'generation',
      'releaseCount',
    ]);
    expect(second).toEqual(first);
  });

  it('distinguishes accepted work from disabled and stale work', () => {
    const accepted = runCase(pass, state);
    const disabled = runCase(pass, { ...state, capabilityAvailable: false });
    const stale = runCase(pass, { ...state, generation: 2 });

    expect(accepted).toMatchObject({ acceptedCount: 1, errorCode: null, generation: 1 });
    expect(disabled).toMatchObject({
      acceptedCount: 0,
      errorCode: 'render-feature-preparation-failed',
    });
    expect(stale).toMatchObject({
      acceptedCount: 0,
      errorCode: 'render-feature-prepared-state-mismatch',
    });
    expect(disabled.releaseCount).toBe(0);
    expect(stale.releaseCount).toBe(0);
  });
});
