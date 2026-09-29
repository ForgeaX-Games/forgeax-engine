import {
  evaluateCaseRecordCore,
  evaluatePairedSentinelsCore,
  referenceBytes,
} from './evaluator-core.mjs';

async function referenceArtifactHash(plan) {
  const bytes = new TextEncoder().encode(referenceBytes(plan));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createBrowserCasePlans(manifest, referenceArtifact) {
  const references = new Map(referenceArtifact.cases.map((item) => [item.caseId, item]));
  return new Map(manifest.cases.map((item) => {
    const reference = references.get(item.caseId);
    return [item.caseId, {
      referenceId: `${referenceArtifact.artifactId}:${item.caseId}`,
      expectedLinearHdrMean: reference?.expectedLinearHdrMean,
      referenceSource: referenceArtifact.source,
      referenceRevision: referenceArtifact.revision,
      referenceConfigHash: referenceArtifact.configHash,
      referenceHash: reference?.referenceHash,
      metric: referenceArtifact.metric,
      epsilon: referenceArtifact.epsilon,
      roi: reference?.roi,
      camera: referenceArtifact.camera,
    }];
  }));
}

export async function evaluateBrowserRecords(records, manifest, plans) {
  const expected = new Set(manifest.cases.map((item) => item.caseId));
  const seen = new Set();
  const cases = [];
  for (const record of records) {
    const plan = plans.get(record.caseId);
    if (seen.has(record.caseId) || plan === undefined || !expected.has(record.caseId)) {
      cases.push({ caseId: record.caseId, verdict: 'fail', reason: 'case-identity-invalid' });
      continue;
    }
    seen.add(record.caseId);
    const hashMatches = await referenceArtifactHash(plan) === plan.referenceHash;
    cases.push({ caseId: record.caseId, ...evaluateCaseRecordCore(record, plan, hashMatches) });
  }
  for (const caseId of expected) {
    if (!seen.has(caseId)) cases.push({ caseId, verdict: 'fail', reason: 'case-missing' });
  }
  return {
    verdict: cases.length === expected.size && cases.every((item) => item.verdict === 'pass') ? 'pass' : 'fail',
    cases,
  };
}

export function evaluateBrowserPairedSentinels(sentinels, referenceArtifact) {
  const epsilon = referenceArtifact?.paired?.['factor-zero-base-parity']?.epsilon;
  const surfaceEpsilon = referenceArtifact?.paired?.['default-custom-surface-physical-parity']?.epsilon;
  const additive = referenceArtifact?.paired?.['additive-coat-falsifier'];
  const factorZero = sentinels?.['factor-zero-base-parity'];
  const surface = sentinels?.['default-custom-surface-physical-parity'];
  const mutation = sentinels?.['additive-coat-falsifier'];
  const visibleStages = [
    factorZero?.baseObjectMask,
    factorZero?.factorZeroObjectMask,
    surface?.defaultObjectMask,
    surface?.customObjectMask,
    mutation?.baselineObjectMask,
  ];
  if (visibleStages.some((mask) => mask?.coverage === undefined || mask.coverage <= 0.01)) {
    return { verdict: 'fail', reason: 'paired-stage-object-coverage-missing' };
  }
  return evaluatePairedSentinelsCore({
    'factor-zero-base-parity': {
      base: factorZero?.base,
      factorZero: factorZero?.factorZero,
      epsilon,
    },
    'default-custom-surface-physical-parity': {
      defaultSurface: surface?.defaultSurface,
      customSurface: surface?.customSurface,
      epsilon: surfaceEpsilon,
    },
    'additive-coat-falsifier': {
      metric: additive?.metric,
      baselineEnergy: mutation?.baseline?.reduce((sum, value) => sum + Math.abs(value), 0),
      mutatedEnergy: mutation?.mutant?.reduce((sum, value) => sum + Math.abs(value), 0),
      baselineNoise: additive?.baselineNoise,
      energyTolerance: additive?.energyTolerance,
    },
  });
}
