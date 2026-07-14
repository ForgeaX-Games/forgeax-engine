import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shadowPassPath = fileURLToPath(new URL('../record/shadow-pass.ts', import.meta.url));
const shadowPass = readFileSync(shadowPassPath, 'utf8');

function sourceAfter(signature: string): string {
  const start = shadowPass.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  return shadowPass.slice(start);
}

function expectValidatedOrderedLoop(
  signature: string,
  indexName: string,
  dynamicOffsetBindGroup: string,
): void {
  const body = sourceAfter(signature);
  expect(body).toContain(
    `for (let ${indexName} = 0; ${indexName} < validatedOrdered.length; ${indexName}++)`,
  );
  expect(body).toContain(`${dynamicOffsetBindGroup}, [${indexName} * MESH_PER_ENTITY_STRIDE]`);
}

describe('shadow mesh SSBO order', () => {
  it('uses the upload order for directional, point, and spot shadow offsets', () => {
    expectValidatedOrderedLoop(
      'function recordShadowCasterDraws(',
      'i',
      'shadowPass.setBindGroup(2, shadowMeshBindGroup',
    );
    expectValidatedOrderedLoop(
      'export function recordPointShadowPass(',
      'ei',
      'pass.setBindGroup(2, meshBindGroup',
    );
    expectValidatedOrderedLoop(
      'function recordSpotShadowGeometry(',
      'ei',
      'pass.setBindGroup(2, meshBindGroup',
    );
  });
});
