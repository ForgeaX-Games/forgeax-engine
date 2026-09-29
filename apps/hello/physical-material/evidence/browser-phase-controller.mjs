import { evaluateBrowserPairedSentinels } from './browser-executor.mjs';

/**
 * Browser phase state machine. Scene construction and GPU capture remain
 * caller-owned adapters; this module owns ordering, receipts, and finalize.
 */
export function createBrowserPhaseController({
  evidence,
  caseManifest,
  referenceArtifact,
  plans,
  captureFrame,
  preparePairStage,
  captureMutant,
  mutantReceipt,
  prepareIbl,
  evaluateRecords,
}) {
  let phase = 'direct';
  let pairStage = 'idle';
  let directRecords = [];
  let iblRecords = [];
  let iblCaptureStartFrame = Number.POSITIVE_INFINITY;
  let iblNonFiniteReported = false;
  const pairRecords = {};
  let additiveMutant;

  // A newly selected authored shader may need one submitted frame to finish
  // its pipeline build. Keep that warm-up frame out of every paired sample so
  // base/factor-zero and product/mutant comparisons observe the same ready
  // pipeline state rather than comparing a clear frame with a rendered one.
  const warmup = (stage) => `warmup:${stage}`;
  const isWarmup = (stage) => stage.startsWith('warmup:');
  const warmedStage = (stage) => stage.slice('warmup:'.length);

  function recordPair(stage, observation) {
    if (observation === undefined) return;
    pairRecords[stage] = observation;
  }

  async function advancePair(frameId, observation) {
    const stage = pairStage;
    if (stage === 'idle') {
      await preparePairStage('base');
      pairStage = warmup('base');
      return;
    }
    if (isWarmup(stage)) {
      pairStage = warmedStage(stage);
      return;
    }
    recordPair(stage, observation);
    if (stage === 'base') {
      await preparePairStage('factor-zero');
      pairStage = warmup('factor-zero');
    } else if (stage === 'factor-zero') {
      await preparePairStage('default');
      pairStage = warmup('default');
    } else if (stage === 'default') {
      await preparePairStage('custom');
      pairStage = warmup('custom');
    } else if (stage === 'custom') {
      await preparePairStage('additive-base');
      pairStage = warmup('additive-base');
    } else if (stage === 'additive-base') {
      additiveMutant = await captureMutant(frameId);
      pairStage = 'done';
    } else if (stage === 'done') {
      const pairedEvaluation = evaluateBrowserPairedSentinels({
        'factor-zero-base-parity': pairRecords.base && pairRecords['factor-zero']
          ? {
              base: pairRecords.base.observed,
              factorZero: pairRecords['factor-zero'].observed,
              baseObjectMask: pairRecords.base.objectMask,
              factorZeroObjectMask: pairRecords['factor-zero'].objectMask,
            }
          : undefined,
        'default-custom-surface-physical-parity': pairRecords.default && pairRecords.custom
          ? {
              defaultSurface: pairRecords.default.observed,
              customSurface: pairRecords.custom.observed,
              defaultObjectMask: pairRecords.default.objectMask,
              customObjectMask: pairRecords.custom.objectMask,
            }
          : undefined,
        'additive-coat-falsifier': pairRecords['additive-base'] && additiveMutant
          ? {
              baseline: pairRecords['additive-base'].observed,
              mutant: additiveMutant.observed,
              baselineObjectMask: pairRecords['additive-base'].objectMask,
              mutantObjectMask: additiveMutant.objectMask,
            }
          : undefined,
      }, referenceArtifact);
      evidence.pairedSentinelEvaluation = {
        ...pairedEvaluation,
        receipts: pairRecords,
        additive: pairRecords['additive-base'] && additiveMutant
          ? { verdict: pairedEvaluation.verdict, baseline: pairRecords['additive-base'], mutant: additiveMutant, receipt: mutantReceipt, productClosure: false }
          : { verdict: 'blocked', reason: 'browser-mutant-renderer-not-available', receipt: mutantReceipt, productClosure: false },
      };
      if (pairedEvaluation.verdict !== 'pass') evidence.errors.push('paired-sentinel-evaluator-failed');
      phase = 'ibl';
      iblCaptureStartFrame = frameId + 30;
      await prepareIbl(frameId);
    }
  }

  async function onFrame(frameId) {
    const capture = await captureFrame({ phase, frameId });
    if (phase === 'direct') {
      if (directRecords.length === 0) directRecords = capture.records;
      await advancePair(frameId, capture.observation);
      return;
    }
    if (frameId < iblCaptureStartFrame) return;
    if (iblRecords.length === 0 && capture.finite) iblRecords = capture.records;
    if (iblRecords.length === 0 && !capture.finite && frameId >= iblCaptureStartFrame + 120 && !iblNonFiniteReported) {
      iblNonFiniteReported = true;
      evidence.errors.push('ibl-linear-hdr-observation-non-finite');
    }
    if (iblRecords.length === 0) return;
    if (evidence.caseRecords.length !== 0) return;
    const records = [...directRecords, ...iblRecords];
    evidence.caseRecords = records;
    evidence.semanticEvaluation = await evaluateRecords(records, caseManifest, plans);
    evidence.ready = true;
  }

  return {
    onFrame,
    get phase() { return phase; },
    get records() { return [...directRecords, ...iblRecords]; },
  };
}
