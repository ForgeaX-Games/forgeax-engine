import type { AutoExposureCapture } from './auto-exposure-reference';
import { joinAutoExposureAc27 } from './auto-exposure-ac27-join';
import { AUTO_EXPOSURE_SCENE_CASE, THREE_R184_PROVENANCE } from '../contracts/auto-exposure-scene-case';

export interface AutoExposureParityReport {
  readonly schemaVersion: 1;
  readonly kind: 'auto-exposure';
  readonly caseId: 'auto-exposure-three-r184';
  readonly testedRevision: string;
  readonly runner: { readonly kind: string; readonly id: string };
  readonly resolution: { readonly width: number; readonly height: number };
  readonly provenance: typeof THREE_R184_PROVENANCE;
  readonly fixtureIdentity: typeof AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity;
  readonly rendererFields: typeof AUTO_EXPOSURE_SCENE_CASE.rendererFields;
  readonly config: { readonly forgeax: Record<string, unknown>; readonly three: Record<string, unknown> };
  readonly stageMapping: readonly { readonly stage: string; readonly domain: string; readonly reference: 'common' | 'not-applicable' }[];
  readonly readback: { readonly domain: 'decoded-sRGB'; readonly roiEpsilon: number | null; readonly rawDelta: number | null };
  readonly notApplicable: typeof AUTO_EXPOSURE_SCENE_CASE.notApplicable;
  readonly overallParityClaim: false;
  readonly status: 'passed' | 'failed' | 'blocked';
  readonly reason?: string;
}

/**
 * Evaluate only the common decoded-sRGB stage. This is an evidence projection,
 * not a renderer or asset authority; missing producer evidence is blocked.
 */
export function evaluateAutoExposureParity(
  forgeax: AutoExposureCapture | undefined,
  three: AutoExposureCapture | undefined,
  metadata: { readonly testedRevision?: string; readonly runner?: { readonly kind: string; readonly id: string }; readonly resolution?: { readonly width: number; readonly height: number } } = {},
): AutoExposureParityReport {
  const config = {
    forgeax: forgeax === undefined ? {} : { ...forgeax.config },
    three: three === undefined ? {} : { ...three.config },
  };
  const base = {
    schemaVersion: 1 as const,
    kind: 'auto-exposure' as const,
    caseId: AUTO_EXPOSURE_SCENE_CASE.caseId,
    testedRevision: metadata.testedRevision ?? 'runtime-exact-head',
    runner: metadata.runner ?? { kind: 'unbound', id: 'evidence-join' },
    resolution: metadata.resolution ?? { width: 1, height: 1 },
    provenance: THREE_R184_PROVENANCE,
    fixtureIdentity: AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity,
    rendererFields: AUTO_EXPOSURE_SCENE_CASE.rendererFields,
    config,
    stageMapping: AUTO_EXPOSURE_SCENE_CASE.commonStages.map((stage) => ({
      stage,
      domain: stage === 'decoded-sRGB-roi' ? 'decoded-sRGB' : stage,
      reference: 'common' as const,
    })),
    notApplicable: AUTO_EXPOSURE_SCENE_CASE.notApplicable,
    overallParityClaim: false as const,
  };
  const joined = joinAutoExposureAc27({ forgeax, three });
  return {
    ...base,
    readback: joined.readback,
    status: joined.status,
    ...(joined.reason === undefined ? {} : { reason: joined.reason }),
  };
}
