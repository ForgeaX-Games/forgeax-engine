import { ok, type Result } from '@forgeax/engine-types';

export interface BeamTopologyInput {
  readonly capacity: number;
  readonly endpointField: 'velocity';
}

export interface BeamTopologyOutput {
  readonly topology: 'beam';
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly indirectVertexCount: number;
  readonly dropped: number;
  readonly degenerate: number;
}

export function buildBeamTopology(
  input: BeamTopologyInput,
  requested: number,
  degenerate = 0,
): Result<BeamTopologyOutput, never> {
  const produced = Math.min(input.capacity, Math.max(0, requested));
  return ok({
    topology: 'beam',
    vertexCount: produced * 2,
    indexCount: produced * 6,
    indirectVertexCount: produced * 6,
    dropped: Math.max(0, requested - produced),
    degenerate: Math.max(0, degenerate),
  });
}

export function beamIsDegenerate(
  start: readonly [number, number, number],
  endpoint: readonly [number, number, number],
): boolean {
  const dx = endpoint[0] - start[0];
  const dy = endpoint[1] - start[1];
  const dz = endpoint[2] - start[2];
  return dx * dx + dy * dy + dz * dz <= 1e-10;
}
