import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CLUSTER_GRID } from '../hdrp-pipeline';

const ownerSource = readFileSync(new URL('../hdrp-pipeline.ts', import.meta.url), 'utf8');
const recordSource = readFileSync(new URL('../record/frame-lighting.ts', import.meta.url), 'utf8');

describe('cluster grid default owner', () => {
  it('keeps both record-stage fallbacks on the pipeline owner', () => {
    expect(DEFAULT_CLUSTER_GRID).toEqual({ x: 16, y: 9, z: 24 });
    expect(
      ownerSource.match(/export const DEFAULT_CLUSTER_GRID\s*=\s*\{ x: 16, y: 9, z: 24 \}/g),
    ).toHaveLength(1);
    expect(recordSource.match(/clusterGrid \?\? DEFAULT_CLUSTER_GRID/g)).toHaveLength(2);
    expect(recordSource).not.toMatch(/clusterGrid \?\? \{\s*x: 16,\s*y: 9,\s*z: 24,\s*\}/);
  });
});
