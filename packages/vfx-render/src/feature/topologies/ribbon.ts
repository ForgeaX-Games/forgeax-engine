import { ok, type Result } from '@forgeax/engine-types';

export interface RibbonTopologyInput {
  readonly capacity: number;
  readonly stripKey: 'alive-index';
}

export interface RibbonTopologyOutput {
  readonly topology: 'ribbon';
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly indirectVertexCount: number;
  readonly dropped: number;
  readonly brokenStrips: number;
}

export function buildRibbonTopology(
  input: RibbonTopologyInput,
  requested: number,
  brokenStrips = 0,
): Result<RibbonTopologyOutput, never> {
  const produced = Math.min(input.capacity, Math.max(0, requested));
  return ok({
    topology: 'ribbon',
    vertexCount: produced * 2,
    indexCount: Math.max(0, produced - 1) * 6,
    indirectVertexCount: Math.max(0, produced - 1) * 6,
    dropped: Math.max(0, requested - produced),
    brokenStrips: Math.max(0, brokenStrips),
  });
}
