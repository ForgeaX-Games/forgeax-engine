import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shadowPassPath = fileURLToPath(
  new URL('../../../render/src/record/shadow-pass.ts', import.meta.url),
);
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
  it('uses the upload order for typed directional, point, and spot shadow offsets', () => {
    expectValidatedOrderedLoop(
      'function recordShadowCasterDraws(',
      'i',
      'shadowPass.setBindGroup(2, shadowMeshBindGroup',
    );
    expect(shadowPass).toContain('export function encodeDirectionalShadowPass(');
    expect(shadowPass).toContain('export function encodePointShadowPass(');
    expect(shadowPass).toContain('export function encodeSpotShadowPass(');
    const spotBody = sourceAfter('export function encodeSpotShadowPass(');
    expect(spotBody).toContain('recordShadowCasterDraws(');
    expect(spotBody).toContain(
      "buildMatchedRenderableIndices(c.dispatch, { LightMode: ['ShadowCaster'] })",
    );
    expect(shadowPass).not.toContain('export function recordShadowPass(');
    expect(shadowPass).not.toContain('export function recordPointShadowPass(');
    expect(shadowPass).not.toContain('export function recordSpotShadowPass(');
    expect(shadowPass).not.toContain('function recordSpotShadowGeometry(');
  });
});
