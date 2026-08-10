import { ok, type Result } from '@forgeax/engine-types';

export interface TrailTopologyInput {
  readonly capacity: number;
  readonly historyLength: number;
}

export interface TrailTopologyOutput {
  readonly topology: 'trail';
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly indirectVertexCount: number;
  readonly dropped: number;
  readonly brokenTrails: number;
}

export function buildTrailTopology(
  input: TrailTopologyInput,
  requested: number,
  brokenTrails = 0,
): Result<TrailTopologyOutput, never> {
  const produced = Math.min(input.capacity, Math.max(0, requested));
  const segments = Math.max(0, input.historyLength - 1);
  return ok({
    topology: 'trail',
    vertexCount: produced * input.historyLength * 2,
    indexCount: produced * segments * 6,
    indirectVertexCount: produced * segments * 6,
    dropped: Math.max(0, requested - produced),
    brokenTrails: Math.max(0, brokenTrails),
  });
}

export function trailContinuityBreaks(
  samples: readonly { readonly id: number; readonly connected: boolean }[],
): number {
  let breaks = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index]?.id !== samples[index - 1]?.id || samples[index]?.connected === false)
      breaks += 1;
  }
  return breaks;
}
