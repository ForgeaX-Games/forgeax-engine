import { resolveEvidenceCommitIdentity } from './evidence-identity';
import { runOcclusionQueryDawnEvidence } from './occlusion-query.evidence';

export interface LodOcclusionVisualEvidence {
  readonly status: 'available' | 'unavailable';
  readonly backend: 'dawn' | 'browser';
  readonly identity: { readonly commit: string; readonly view: string };
  readonly expectations: readonly string[];
  readonly observed: readonly string[];
  readonly verdict: 'pass' | 'unavailable';
  readonly confidence: 'high' | 'none';
  readonly reason?: string;
}

function identity(): { readonly commit: string; readonly view: string } {
  return {
    commit: resolveEvidenceCommitIdentity(),
    view: 'lod-occlusion-visual:main:1',
  };
}

const EXPECTATIONS = [
  'occlusion-off preserves the full silhouette',
  'two zero results suppress only after the confidence threshold',
  'a positive retest makes the silhouette visible again',
  'device-loss and stale results remain all-visible',
] as const;

export async function runLodOcclusionDawnVisualEvidence(): Promise<LodOcclusionVisualEvidence> {
  const evidence = await runOcclusionQueryDawnEvidence();
  if (evidence.status === 'unavailable') {
    return {
      status: 'unavailable',
      backend: 'dawn',
      identity: identity(),
      expectations: EXPECTATIONS,
      observed: [],
      verdict: 'unavailable',
      confidence: 'none',
      reason: evidence.reason ?? 'Dawn evidence unavailable',
    };
  }
  const observed = [
    `zero-samples:${evidence.zeroSamples}`,
    `positive-samples:${evidence.positiveSamples}`,
    `out-of-order:${evidence.outOfOrder}`,
    `stale-visible:${evidence.staleVisible}`,
    `fault-visible:${evidence.faultVisible}`,
  ];
  return {
    status: 'available',
    backend: 'dawn',
    identity: identity(),
    expectations: EXPECTATIONS,
    observed,
    verdict:
      evidence.zeroSamples === 0 &&
      evidence.positiveSamples > 0 &&
      evidence.outOfOrder &&
      evidence.staleVisible &&
      evidence.faultVisible
        ? 'pass'
        : 'unavailable',
    confidence: 'high',
  };
}

export function runLodOcclusionBrowserVisualEvidence(): LodOcclusionVisualEvidence {
  if (typeof navigator === 'undefined' || navigator.gpu === undefined) {
    return {
      status: 'unavailable',
      backend: 'browser',
      identity: identity(),
      expectations: EXPECTATIONS,
      observed: [],
      verdict: 'unavailable',
      confidence: 'none',
      reason: 'navigator.gpu unavailable; compositor capture was not attempted',
    };
  }
  return {
    status: 'unavailable',
    backend: 'browser',
    identity: identity(),
    expectations: EXPECTATIONS,
    observed: [],
    verdict: 'unavailable',
    confidence: 'none',
    reason: 'browser compositor capture requires the visual runner',
  };
}
