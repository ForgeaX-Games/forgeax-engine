import {
  AUTO_EXPOSURE_SCENE_CASE,
  AUTO_EXPOSURE_THREE_R184_FIXTURE,
  THREE_R184_PROVENANCE,
  type StableFixtureIdentity,
} from '../contracts/auto-exposure-scene-case';

export const AC27_COMMON_STAGE_MAPPING = [
  { stage: 'linear-HDR', domain: 'linear-HDR' },
  { stage: 'tone-mapping', domain: 'linear-LDR' },
  { stage: 'output-encoding', domain: 'final-sRGB' },
  { stage: 'decoded-sRGB-roi', domain: 'decoded-sRGB' },
] as const;

export type AutoExposureAc27StageId = (typeof AC27_COMMON_STAGE_MAPPING)[number]['stage'];
export type AutoExposureAc27StageDomain = (typeof AC27_COMMON_STAGE_MAPPING)[number]['domain'];

export interface AutoExposureAc27StageObservation {
  readonly stage: AutoExposureAc27StageId;
  readonly domain: AutoExposureAc27StageDomain;
  readonly values: readonly number[];
  readonly rawHash: string;
}

export interface AutoExposureAc27ThreeProvenance {
  readonly implementation: 'three';
  readonly package: 'three';
  readonly version: '0.184.0';
  readonly commit: typeof THREE_R184_PROVENANCE.commit;
  readonly integrity: typeof THREE_R184_PROVENANCE.integrity;
  readonly backend: 'webgpu';
}

export interface AutoExposureAc27ForgeaxProvenance {
  readonly implementation: 'forgeax';
  readonly package: '@forgeax/engine';
  readonly version: string;
  readonly commit: string;
  readonly build: string;
  readonly backend: 'browser-webgpu' | 'dawn';
}

export type AutoExposureAc27Provenance = AutoExposureAc27ThreeProvenance | AutoExposureAc27ForgeaxProvenance;

export interface AutoExposureAc27RendererConfig {
  readonly toneMapping: 'ACESFilmicToneMapping';
  readonly toneMappingExposure: 1;
  readonly outputColorSpace: 'SRGBColorSpace';
  readonly lut: 'not-applicable';
  readonly temporal: 'not-applicable';
}

export interface AutoExposureAc27Capture {
  readonly side: 'forgeax' | 'three';
  readonly referenceLane: 'direct' | 'clustered';
  readonly testedRevision: string;
  readonly runner: { readonly kind: string; readonly id: string };
  readonly resolution: { readonly width: number; readonly height: number };
  readonly provenance: AutoExposureAc27Provenance;
  readonly fixtureIdentity: StableFixtureIdentity;
  /** Executable shared scene summary, not a relabellable identity-only tag. */
  readonly scene: typeof AUTO_EXPOSURE_THREE_R184_FIXTURE;
  readonly config: AutoExposureAc27RendererConfig;
  readonly stages: readonly AutoExposureAc27StageObservation[];
}

export type AutoExposureAc27JoinErrorCode =
  | 'producer-missing'
  | 'producer-side-mismatch'
  | 'revision-missing'
  | 'revision-mismatch'
  | 'runner-missing'
  | 'resolution-mismatch'
  | 'lane-mismatch'
  | 'three-provenance-mismatch'
  | 'forgeax-provenance-mismatch'
  | 'fixture-mismatch'
  | 'renderer-config-mismatch'
  | 'stage-mapping-invalid'
  | 'readback-missing'
  | 'readback-shape-mismatch'
  | 'readback-vacuous'
  | 'readback-non-finite'
  | 'raw-hash-invalid';

export interface AutoExposureAc27JoinError {
  readonly code: AutoExposureAc27JoinErrorCode;
  readonly detail: string;
}

export interface AutoExposureAc27JoinReport {
  readonly schemaVersion: 1;
  readonly kind: 'auto-exposure-three-r184-ac27';
  readonly caseId: typeof AUTO_EXPOSURE_SCENE_CASE.caseId;
  readonly referenceLane: 'direct' | 'clustered' | null;
  readonly testedRevision: string | null;
  readonly runner: { readonly forgeax: string | null; readonly three: string | null };
  readonly resolution: { readonly width: number; readonly height: number } | null;
  readonly provenance: {
    readonly three: typeof THREE_R184_PROVENANCE;
    readonly forgeax: AutoExposureAc27ForgeaxProvenance | null;
  };
  readonly fixtureIdentity: typeof AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity;
  readonly rendererFields: typeof AUTO_EXPOSURE_SCENE_CASE.rendererFields;
  readonly config: {
    readonly forgeax: AutoExposureAc27RendererConfig | null;
    readonly three: AutoExposureAc27RendererConfig | null;
  };
  readonly stageMapping: typeof AC27_COMMON_STAGE_MAPPING;
  readonly notApplicable: typeof AUTO_EXPOSURE_SCENE_CASE.notApplicable;
  readonly overallParityClaim: false;
  readonly readback: {
    readonly domain: 'decoded-sRGB';
    readonly roiEpsilon: number | null;
    readonly rawDelta: number | null;
  };
  readonly errors: readonly AutoExposureAc27JoinError[];
  readonly status: 'passed' | 'failed' | 'blocked';
  readonly reason?: string;
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REQUIRED_STAGE_IDS = new Set<AutoExposureAc27StageId>(AC27_COMMON_STAGE_MAPPING.map(({ stage }) => stage));

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sameIdentity(left: StableFixtureIdentity, right: StableFixtureIdentity): boolean {
  return Object.keys(left).length === Object.keys(right).length
    && (Object.keys(right) as (keyof StableFixtureIdentity)[]).every((key) => {
    const candidate = left[key];
    const expected = right[key];
    return isRecord(candidate)
      && candidate.id === expected.id
      && candidate.sha256 === expected.sha256;
  });
}

function sameRendererConfig(left: AutoExposureAc27RendererConfig, right: AutoExposureAc27RendererConfig): boolean {
  return left.toneMapping === right.toneMapping
    && left.toneMappingExposure === right.toneMappingExposure
    && left.outputColorSpace === right.outputColorSpace
    && left.lut === right.lut
    && left.temporal === right.temporal;
}

function expectedDomain(stage: AutoExposureAc27StageId): AutoExposureAc27StageDomain {
  for (const mapping of AC27_COMMON_STAGE_MAPPING) {
    if (mapping.stage === stage) return mapping.domain;
  }
  return 'decoded-sRGB';
}

function validateStageList(value: unknown, side: 'forgeax' | 'three', errors: AutoExposureAc27JoinError[]): AutoExposureAc27StageObservation[] | null {
  if (!Array.isArray(value) || value.length !== AC27_COMMON_STAGE_MAPPING.length) {
    errors.push({ code: 'stage-mapping-invalid', detail: `${side} must provide each common stage exactly once` });
    return null;
  }
  const seen = new Set<string>();
  const stages: AutoExposureAc27StageObservation[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)
      || typeof candidate.stage !== 'string'
      || typeof candidate.domain !== 'string'
      || !Array.isArray(candidate.values)
      || typeof candidate.rawHash !== 'string') {
      errors.push({ code: 'stage-mapping-invalid', detail: `${side} stage observation is malformed` });
      continue;
    }
    if (!REQUIRED_STAGE_IDS.has(candidate.stage as AutoExposureAc27StageId)
      || seen.has(candidate.stage)
      || candidate.domain !== expectedDomain(candidate.stage as AutoExposureAc27StageId)) {
      errors.push({ code: 'stage-mapping-invalid', detail: `${side} stage mapping contains an unknown, duplicate, or wrong domain` });
      continue;
    }
    seen.add(candidate.stage);
    if (!SHA256_PATTERN.test(candidate.rawHash)) {
      errors.push({ code: 'raw-hash-invalid', detail: `${side} ${candidate.stage} rawHash must be a lowercase SHA-256 digest` });
    }
    const values = candidate.values.filter((entry): entry is number => isFiniteNumber(entry));
    if (values.length !== candidate.values.length || values.length === 0) {
      errors.push({ code: 'readback-non-finite', detail: `${side} ${candidate.stage} values must be non-empty and finite` });
    }
    stages.push({
      stage: candidate.stage as AutoExposureAc27StageId,
      domain: candidate.domain as AutoExposureAc27StageDomain,
      values,
      rawHash: candidate.rawHash,
    });
  }
  if (seen.size !== REQUIRED_STAGE_IDS.size) {
    errors.push({ code: 'stage-mapping-invalid', detail: `${side} is missing one or more common stages` });
  }
  return stages;
}

function validateProvenance(value: unknown, side: 'forgeax' | 'three', errors: AutoExposureAc27JoinError[]): AutoExposureAc27Provenance | null {
  if (!isRecord(value) || value.implementation !== side) {
    errors.push({ code: side === 'three' ? 'three-provenance-mismatch' : 'forgeax-provenance-mismatch', detail: `${side} implementation identity is missing or wrong` });
    return null;
  }
  if (side === 'three') {
    const valid = value.package === THREE_R184_PROVENANCE.package
      && value.version === THREE_R184_PROVENANCE.version
      && value.commit === THREE_R184_PROVENANCE.commit
      && value.integrity === THREE_R184_PROVENANCE.integrity
      && value.backend === 'webgpu';
    if (!valid) errors.push({ code: 'three-provenance-mismatch', detail: 'Three provenance must be the pinned r184 WebGPU carrier' });
    return valid ? value as unknown as AutoExposureAc27ThreeProvenance : null;
  }
  const valid = value.package === '@forgeax/engine'
    && typeof value.version === 'string'
    && value.version.length > 0
    && typeof value.commit === 'string'
    && REVISION_PATTERN.test(value.commit)
    && typeof value.build === 'string'
    && value.build.length > 0
    && (value.backend === 'browser-webgpu' || value.backend === 'dawn');
  if (!valid) errors.push({ code: 'forgeax-provenance-mismatch', detail: 'ForgeaX provenance must name a real build, commit, and Browser/Dawn backend' });
  return valid ? value as unknown as AutoExposureAc27ForgeaxProvenance : null;
}

function validateCapture(value: unknown, side: 'forgeax' | 'three', errors: AutoExposureAc27JoinError[]): AutoExposureAc27Capture | null {
  if (!isRecord(value)) {
    errors.push({ code: 'producer-missing', detail: `${side} producer evidence is missing` });
    return null;
  }
  if (value.side !== side) {
    errors.push({ code: 'producer-side-mismatch', detail: `${side} producer side discriminator does not match its join slot` });
  }
  const provenance = validateProvenance(value.provenance, side, errors);
  const fixtureIdentity = isRecord(value.fixtureIdentity) ? value.fixtureIdentity as unknown as StableFixtureIdentity : null;
  if (fixtureIdentity === null || !sameIdentity(fixtureIdentity, AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity)) {
    errors.push({ code: 'fixture-mismatch', detail: `${side} must use the canonical asset/camera/light/input fixture identities` });
  }
  const scene = isRecord(value.scene) ? value.scene : null;
  if (scene === null || JSON.stringify(scene) !== JSON.stringify(AUTO_EXPOSURE_THREE_R184_FIXTURE)) {
    errors.push({ code: 'fixture-mismatch', detail: `${side} must provide the executable canonical hello-taa geometry, camera, light, and input summary` });
  }
  const testedRevision = typeof value.testedRevision === 'string' && REVISION_PATTERN.test(value.testedRevision) ? value.testedRevision : null;
  if (testedRevision === null) errors.push({ code: 'revision-missing', detail: `${side} testedRevision must be a full 40- or 64-character commit SHA` });
  const runner = isRecord(value.runner) && typeof value.runner.kind === 'string' && value.runner.kind.length > 0 && typeof value.runner.id === 'string' && value.runner.id.length > 0
    ? { kind: value.runner.kind, id: value.runner.id }
    : null;
  if (runner === null) errors.push({ code: 'runner-missing', detail: `${side} runner kind and id are required` });
  const resolution = isRecord(value.resolution) && Number.isInteger(value.resolution.width) && (value.resolution.width as number) > 0 && Number.isInteger(value.resolution.height) && (value.resolution.height as number) > 0
    ? { width: value.resolution.width as number, height: value.resolution.height as number }
    : null;
  if (resolution === null) errors.push({ code: 'resolution-mismatch', detail: `${side} resolution must be a positive integer size` });
  const config = isRecord(value.config) ? value.config : null;
  const expectedConfig = AUTO_EXPOSURE_SCENE_CASE.rendererConfig;
  if (config === null
    || config.toneMapping !== expectedConfig.toneMapping
    || config.toneMappingExposure !== expectedConfig.toneMappingExposure
    || config.outputColorSpace !== expectedConfig.outputColorSpace
    || config.lut !== expectedConfig.lut
    || config.temporal !== expectedConfig.temporal) {
    errors.push({ code: 'renderer-config-mismatch', detail: `${side} must explicitly pin tone mapping, exposure, output color space, LUT, and temporal settings` });
  }
  const stages = validateStageList(value.stages, side, errors);
  if (value.referenceLane !== 'direct' && value.referenceLane !== 'clustered') {
    errors.push({ code: 'lane-mismatch', detail: `${side} must identify the direct or clustered reference lane` });
  }
  if (provenance === null || fixtureIdentity === null || scene === null || testedRevision === null || runner === null || resolution === null || config === null || stages === null) return null;
  return {
    side,
    referenceLane: value.referenceLane as 'direct' | 'clustered',
    testedRevision,
    runner,
    resolution,
    provenance,
    fixtureIdentity,
    scene: scene as unknown as typeof AUTO_EXPOSURE_THREE_R184_FIXTURE,
    config: config as unknown as AutoExposureAc27RendererConfig,
    stages,
  };
}

function stageById(capture: AutoExposureAc27Capture, stage: AutoExposureAc27StageId): AutoExposureAc27StageObservation | undefined {
  return capture.stages.find((candidate) => candidate.stage === stage);
}

function maxDelta(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return 1;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result = Math.max(result, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
  }
  return result;
}

function differingValues(left: readonly number[], right: readonly number[]): number {
  let result = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) result += 1;
  }
  return result;
}

function baseReport(
  forgeax: AutoExposureAc27Capture | null,
  three: AutoExposureAc27Capture | null,
  errors: readonly AutoExposureAc27JoinError[],
): AutoExposureAc27JoinReport {
  return {
    schemaVersion: 1,
    kind: 'auto-exposure-three-r184-ac27',
    caseId: AUTO_EXPOSURE_SCENE_CASE.caseId,
    referenceLane: forgeax?.referenceLane === three?.referenceLane ? forgeax?.referenceLane ?? null : null,
    testedRevision: forgeax?.testedRevision === three?.testedRevision ? forgeax?.testedRevision ?? null : null,
    runner: { forgeax: forgeax?.runner.id ?? null, three: three?.runner.id ?? null },
    resolution: forgeax?.resolution.width === three?.resolution.width && forgeax?.resolution.height === three?.resolution.height
      ? forgeax?.resolution ?? null
      : null,
    provenance: {
      three: THREE_R184_PROVENANCE,
      forgeax: forgeax?.provenance.implementation === 'forgeax' ? forgeax.provenance : null,
    },
    fixtureIdentity: AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity,
    rendererFields: AUTO_EXPOSURE_SCENE_CASE.rendererFields,
    config: {
      forgeax: forgeax?.config ?? null,
      three: three?.config ?? null,
    },
    stageMapping: AC27_COMMON_STAGE_MAPPING,
    notApplicable: AUTO_EXPOSURE_SCENE_CASE.notApplicable,
    overallParityClaim: false,
    readback: { domain: 'decoded-sRGB', roiEpsilon: null, rawDelta: null },
    errors,
    status: errors.length === 0 ? 'passed' : 'blocked',
  };
}

/**
 * Join two independent AC-27 producers. Every identity and stage contract is
 * checked before a numeric verdict is possible; malformed or incomplete input
 * is always blocked and can never inherit a pass-valued default.
 */
export function joinAutoExposureAc27(input: { readonly forgeax?: unknown; readonly three?: unknown }): AutoExposureAc27JoinReport {
  const errors: AutoExposureAc27JoinError[] = [];
  const forgeax = validateCapture(input.forgeax, 'forgeax', errors);
  const three = validateCapture(input.three, 'three', errors);
  if (forgeax !== null && three !== null) {
    if (forgeax.testedRevision !== three.testedRevision) errors.push({ code: 'revision-mismatch', detail: 'both producers must be captured from the same tested revision' });
    if (forgeax.referenceLane !== three.referenceLane) errors.push({ code: 'lane-mismatch', detail: 'direct and clustered captures must each join their same reference lane' });
    if (forgeax.resolution.width !== three.resolution.width || forgeax.resolution.height !== three.resolution.height) errors.push({ code: 'resolution-mismatch', detail: 'both producers must use the same resolution' });
    if (!sameIdentity(forgeax.fixtureIdentity, three.fixtureIdentity)) errors.push({ code: 'fixture-mismatch', detail: 'producer fixture identities differ' });
    if (!sameRendererConfig(forgeax.config, three.config)) errors.push({ code: 'renderer-config-mismatch', detail: 'common renderer configuration differs between producers' });
    for (const mapping of AC27_COMMON_STAGE_MAPPING) {
      const left = stageById(forgeax, mapping.stage);
      const right = stageById(three, mapping.stage);
      if (left?.domain !== right?.domain) errors.push({ code: 'stage-mapping-invalid', detail: `${mapping.stage} domain differs between producers` });
    }
  }
  const report = baseReport(forgeax, three, errors);
  if (errors.length > 0 || forgeax === null || three === null) {
    return {
      ...report,
      status: 'blocked',
      reason: 'AC-27 evidence identities, configuration, and common-stage readbacks must be complete before comparison',
    };
  }
  const forgeaxReadback = stageById(forgeax, 'decoded-sRGB-roi');
  const threeReadback = stageById(three, 'decoded-sRGB-roi');
  if (forgeaxReadback === undefined || threeReadback === undefined) {
    const readbackError: AutoExposureAc27JoinError = { code: 'readback-missing', detail: 'both producers must provide decoded-sRGB ROI readback' };
    return { ...report, status: 'blocked', errors: [readbackError], reason: readbackError.detail };
  }
  if (forgeaxReadback.values.length !== threeReadback.values.length) {
    const shapeError: AutoExposureAc27JoinError = { code: 'readback-shape-mismatch', detail: 'decoded-sRGB ROI readback lengths differ' };
    return { ...report, status: 'blocked', errors: [shapeError], reason: shapeError.detail };
  }
  if (forgeaxReadback.values.every((value) => value === 0)
    || threeReadback.values.every((value) => value === 0)) {
    const vacuousError: AutoExposureAc27JoinError = {
      code: 'readback-vacuous',
      detail: 'decoded-sRGB ROI must contain a non-zero signal from the executable shared fixture',
    };
    return { ...report, status: 'blocked', errors: [vacuousError], reason: vacuousError.detail };
  }
  const roiEpsilon = maxDelta(forgeaxReadback.values, threeReadback.values);
  const rawDelta = differingValues(forgeaxReadback.values, threeReadback.values);
  const passed = roiEpsilon <= AUTO_EXPOSURE_SCENE_CASE.roiEpsilon;
  return {
    ...report,
    readback: { domain: 'decoded-sRGB', roiEpsilon, rawDelta },
    status: passed ? 'passed' : 'failed',
    ...(passed ? {} : { reason: 'common-stage decoded-sRGB ROI exceeds epsilon' }),
  };
}
