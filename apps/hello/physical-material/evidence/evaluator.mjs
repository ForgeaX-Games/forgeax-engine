import { createHash } from 'node:crypto';
import {
  REFERENCE_VERSION,
  evaluateCaseRecordCore,
  evaluatePairedSentinelsCore,
  finiteVector,
  maxDelta,
  referenceBytes,
} from './evaluator-core.mjs';

export function referenceArtifactHash(plan) {
  return createHash('sha256').update(referenceBytes(plan)).digest('hex');
}

function expectedCaseIds(manifest) {
  return new Set(manifest.cases.map((item) => item.caseId));
}

export function referencePlan(item, index, roiWidth = 50, roiHeight = 75) {
  const reference = item.reference;
  return {
    referenceId: `${REFERENCE_VERSION}:${item.caseId}`,
    camera: reference?.camera ?? 'perspective-fov-45-at-origin',
    roi: reference?.roi ?? {
      x: (index % 4) * roiWidth,
      y: Math.floor(index / 4) * roiHeight,
      width: roiWidth,
      height: roiHeight,
    },
    metric: reference?.metric ?? 'linear-hdr-rgb-mean',
    epsilon: reference?.epsilon ?? 0.05,
    expectedLinearHdrMean: reference?.expectedLinearHdrMean,
    referenceSource: reference?.source,
    referenceRevision: reference?.revision,
    referenceConfigHash: reference?.configHash,
    referenceHash: reference?.hash,
  };
}

export function evaluateCaseRecord(record, plan) {
  return evaluateCaseRecordCore(record, plan, referenceArtifactHash(plan) === plan?.referenceHash);
}

export function evaluateCaseRecords(records, manifest, plans) {
  const expected = expectedCaseIds(manifest);
  const seen = new Set();
  const evaluated = [];
  for (const record of records) {
    if (seen.has(record.caseId) || !expected.has(record.caseId)) {
      evaluated.push({ caseId: record.caseId, verdict: 'fail', reason: 'case-identity-invalid' });
      continue;
    }
    seen.add(record.caseId);
    evaluated.push({
      caseId: record.caseId,
      ...evaluateCaseRecord(record, plans.get(record.caseId)),
    });
  }
  for (const caseId of expected) {
    if (!seen.has(caseId)) evaluated.push({ caseId, verdict: 'fail', reason: 'case-missing' });
  }
  const pass = evaluated.length === expected.size && evaluated.every((item) => item.verdict === 'pass');
  return { verdict: pass ? 'pass' : 'fail', cases: evaluated };
}

export function evaluatePairedSentinels(sentinels) {
  return evaluatePairedSentinelsCore(sentinels);
}
