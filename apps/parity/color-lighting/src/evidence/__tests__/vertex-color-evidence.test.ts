import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { VERTEX_COLOR_CASE_IDS, type VertexColorCaseId } from '../../coverage/required-cases';

const caseReportSchema = JSON.parse(readFileSync(
  resolve(import.meta.dirname, '../../../schemas/case-report.schema.json'),
  'utf8',
)) as object;
const visualEvidenceSchema = JSON.parse(readFileSync(
  resolve(import.meta.dirname, '../../../schemas/visual-evidence.schema.json'),
  'utf8',
)) as object;
const validateCaseReport = new Ajv2020({ allErrors: true, strict: false }).compile(caseReportSchema);
const validateVisualEvidence = new Ajv2020({ allErrors: true, strict: false }).compile(visualEvidenceSchema);

const producer = (implementation: 'forgeax' | 'three') => ({
  implementation,
  version: implementation === 'three' ? 'r184' : 'workspace',
  renderer: 'webgpu',
  adapterId: implementation === 'three' ? 'three-r184-webgpu' : 'forgeax-webgpu',
  pinnedCommit: implementation === 'three' ? 'three-r184-pinned' : 'engine-source-sha',
  buildIdentity: implementation === 'three' ? 'three-webgpu-r184' : 'forgeax-browser-webgpu',
});

function reportFixture(caseId: VertexColorCaseId = VERTEX_COLOR_CASE_IDS[0]) {
  return {
    schemaVersion: 3,
    kind: 'vertex-color',
    caseId,
    required: true,
    invocationId: 'm5-test',
    backend: 'browser-webgpu',
    sourceSha: 'a'.repeat(64),
    sourceFixtureHash: 'b'.repeat(64),
    colorDomain: 'displayEncoded',
    frameCount: 300,
    epsilon: { rgb: 0.05, alpha: 0.05 },
    producers: { forgeax: producer('forgeax'), three: producer('three') },
    samples: [{
      id: 'triangle-centroid',
      coordinate: [0.5, 0.5],
      expected: [0.2, 0.4, 0.8, 1],
      observed: {
        forgeax: [0.2, 0.4, 0.8, 1],
        three: [0.2, 0.4, 0.8, 1],
      },
      rgbMaxDelta: 0,
      alphaDelta: 0,
      verdict: 'passed',
      confidence: 'high',
    }],
    falsifier: { kind: 'white-color', verdict: 'failed', observed: 'colored sample changed beyond epsilon' },
    artifacts: ['artifact://m5/browser/vertex-color-vec3/forgeax', 'artifact://m5/browser/vertex-color-vec3/three'],
    verdict: 'passed',
    status: 'complete',
  };
}

function visualFixture(caseId: VertexColorCaseId = VERTEX_COLOR_CASE_IDS[0]) {
  return {
    evidenceKind: 'vertex-color',
    caseId,
    width: 64,
    height: 64,
    background: [0, 0, 0, 1],
    framing: 'fixed-camera-centroid',
    colorDomain: 'displayEncoded',
    frameCount: 300,
    epsilon: { rgb: 0.05, alpha: 0.05 },
    sourceFixtureHash: 'b'.repeat(64),
    producers: { forgeax: producer('forgeax'), three: producer('three') },
    artifacts: [
      { kind: 'forgeax-final', url: 'artifact://forgeax', caseId, width: 64, height: 64, background: [0, 0, 0, 1], frameId: 299, rawHash: 'a'.repeat(64), observed: 'colored sample is visible', verdict: 'pass', confidence: 'high' },
      { kind: 'three-primary-final', url: 'artifact://three', caseId, width: 64, height: 64, background: [0, 0, 0, 1], frameId: 299, rawHash: 'b'.repeat(64), observed: 'independent r184 sample is visible', verdict: 'pass', confidence: 'high' },
      { kind: 'diff-roi', url: 'artifact://diff', caseId, width: 64, height: 64, background: [0, 0, 0, 1], frameId: 299, rawHash: 'c'.repeat(64), observed: 'RGB and alpha remain within epsilon', verdict: 'pass', confidence: 'high' },
    ],
  };
}

describe('vertex-color evidence contract', () => {
  it('accepts one complete report for every required case', () => {
    for (const caseId of VERTEX_COLOR_CASE_IDS) {
      expect(validateCaseReport(reportFixture(caseId)), caseId).toBe(true);
    }
  });

  it.each([
    ['missing Three producer', (value: ReturnType<typeof reportFixture>) => ({ ...value, producers: { forgeax: value.producers.forgeax } })],
    ['self comparison', (value: ReturnType<typeof reportFixture>) => ({ ...value, producers: { forgeax: value.producers.forgeax, three: value.producers.forgeax } })],
    ['wrong domain', (value: ReturnType<typeof reportFixture>) => ({ ...value, colorDomain: 'linearLdr' })],
    ['not executed', (value: ReturnType<typeof reportFixture>) => ({ ...value, frameCount: 0 })],
    ['wide epsilon', (value: ReturnType<typeof reportFixture>) => ({ ...value, epsilon: { rgb: 999999, alpha: 999999 } })],
  ])('%s is rejected closed', (_name, mutate) => {
    expect(validateCaseReport(mutate(reportFixture()))).toBe(false);
  });

  it('requires visual provenance and readback for the vertex-color lane', () => {
    expect(validateVisualEvidence(visualFixture())).toBe(true);
    expect(validateVisualEvidence({ ...visualFixture(), producers: undefined })).toBe(false);
    expect(validateVisualEvidence({ ...visualFixture(), colorDomain: 'linearLdr' })).toBe(false);
  });
});
