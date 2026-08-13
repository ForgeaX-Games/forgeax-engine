import parityPackage from '../../package.json' with { type: 'json' };
import byteDiff from '../../cases/m0/byte-diff.json' with { type: 'json' };
import invalidBudget from '../../cases/m0/invalid-budget.json' with { type: 'json' };
import missingPrimary from '../../cases/m0/missing-primary.json' with { type: 'json' };
import positiveMinimal from '../../cases/m0/positive-minimal.json' with { type: 'json' };
import sameProvenance from '../../cases/m0/same-provenance.json' with { type: 'json' };
import selfCompare from '../../cases/m0/self-compare.json' with { type: 'json' };
import alphaCase from '../../cases/material-alpha/material-alpha-blend.json' with { type: 'json' };
import alphaEqualCase from '../../cases/material-alpha/material-alpha-mask-equal.json' with { type: 'json' };
import alphaExplicitCase from '../../cases/material-alpha/material-alpha-mask-explicit.json' with { type: 'json' };
import alphaDefaultCase from '../../cases/material-alpha/material-alpha-mask-default.json' with { type: 'json' };
import alphaOneCase from '../../cases/material-alpha/material-alpha-mask-one.json' with { type: 'json' };
import alphaZeroCase from '../../cases/material-alpha/material-alpha-mask-zero.json' with { type: 'json' };
import alphaRgbaCase from '../../cases/material-alpha/material-alpha-rgba-factor.json' with { type: 'json' };
import capabilityLoss from '../../cases/ibl/capability-loss.json' with { type: 'json' };
import constantEnvironment from '../../cases/ibl/constant-environment.json' with { type: 'json' };
import directionalUrp from '../../cases/direct-light/cases/directional-urp.json' with { type: 'json' };
import khrSpotUrp from '../../cases/direct-light/cases/khr-spot-urp.json' with { type: 'json' };
import pointUrp from '../../cases/direct-light/cases/point-urp.json' with { type: 'json' };
import spotUrp from '../../cases/direct-light/cases/spot-urp.json' with { type: 'json' };
import transparentHdrp from '../../cases/transparency-post/transparent-hdr-hdrp.json' with { type: 'json' };
import transparentUrp from '../../cases/transparency-post/transparent-ldr-urp.json' with { type: 'json' };
import falsificationManifest from '../../cases/default/falsification/manifest.json' with { type: 'json' };
import { M1_REQUIRED_CASES } from '../report/m1-required';
import { TONE_REQUIRED_CASES } from '../report/tone-required';

export type ParityCaseOwner = 'm0' | 'm1' | 'm2' | 'm3' | 'm4' | 'm5' | 'm6';
export type ParityBackendId = 'browser-webgpu' | 'dawn' | 'webkit-webgl2';

export interface RequiredCaseAuthorityEntry {
  readonly caseId: string;
  readonly required: boolean;
  readonly owner: ParityCaseOwner;
  readonly applicableBackends: readonly ParityBackendId[];
  readonly matrixRequiredBackends: readonly ParityBackendId[];
}

interface MatrixDeclaration {
  readonly requiredBackends: readonly string[];
  readonly requiredPipelines: readonly string[];
}

const matrix = (parityPackage as { parityMatrix: MatrixDeclaration }).parityMatrix;

function entry(
  caseId: string,
  required: boolean,
  owner: ParityCaseOwner,
  matrixRequiredBackends: readonly ParityBackendId[] = ['browser-webgpu'],
  applicableBackends: readonly ParityBackendId[] = matrixRequiredBackends,
): RequiredCaseAuthorityEntry {
  return { caseId, required, owner, applicableBackends, matrixRequiredBackends };
}

const webkitSentinelCaseIds = new Set([
  'default-srgb-texture',
  'material-alpha-mask-default',
  'material-alpha-blend',
  'tone-aces-filmic-2',
  'direct-directional-urp',
  'transparent-ldr-urp',
]);

function browserBackends(caseId: string): readonly ParityBackendId[] {
  return webkitSentinelCaseIds.has(caseId)
    ? ['browser-webgpu', 'webkit-webgl2']
    : ['browser-webgpu'];
}

const m0Cases = [
  positiveMinimal,
  selfCompare,
  sameProvenance,
  missingPrimary,
  invalidBudget,
  byteDiff,
].map((fixture) => entry(fixture.caseId, fixture.required, 'm0', []));

const m1Cases = [
  ...M1_REQUIRED_CASES.map((fixture) => {
    const backends = browserBackends(fixture.caseId);
    return entry(fixture.caseId, fixture.required, 'm1', backends, backends);
  }),
  ...falsificationManifest.cases.map((fixture) => entry(fixture.caseId, false, 'm1')),
];

const m2Cases = [
  alphaRgbaCase,
  alphaDefaultCase,
  alphaExplicitCase,
  alphaZeroCase,
  alphaOneCase,
  alphaEqualCase,
  alphaCase,
].map((fixture) => {
  const backends = browserBackends(fixture.caseId);
  return entry(fixture.caseId, true, 'm2', backends, backends);
});

const m4Cases = [
  directionalUrp,
  khrSpotUrp,
  pointUrp,
  spotUrp,
].map((fixture) => entry(fixture.caseId, true, 'm4', ['browser-webgpu', 'dawn']));

const m5Cases = [
  entry(constantEnvironment.caseId, true, 'm5', ['browser-webgpu', 'dawn']),
  entry(capabilityLoss.caseId, false, 'm5'),
];

const m6Cases = [
  entry(transparentHdrp.caseId, transparentHdrp.required, 'm6', ['browser-webgpu', 'dawn']),
  entry(transparentUrp.caseId, transparentUrp.required, 'm6', ['browser-webgpu', 'dawn', 'webkit-webgl2']),
];

const m3Cases = TONE_REQUIRED_CASES.map((fixture) => {
  const backends = browserBackends(fixture.caseId);
  return entry(fixture.caseId, fixture.required, 'm3', backends, backends);
});

const m4AuthorityCases = m4Cases.map((fixture) => {
  if (fixture.caseId !== 'direct-directional-urp') return fixture;
  return entry(fixture.caseId, fixture.required, fixture.owner, ['browser-webgpu', 'dawn', 'webkit-webgl2']);
});

export const PARITY_CASE_AUTHORITY = [
  ...m0Cases,
  ...m1Cases,
  ...m2Cases,
  ...m3Cases,
  ...m4AuthorityCases,
  ...m5Cases,
  ...m6Cases,
] as const satisfies readonly RequiredCaseAuthorityEntry[];

export const PARITY_REQUIRED_CASES = PARITY_CASE_AUTHORITY.filter((fixture) => fixture.required);
export const PARITY_REQUIRED_CASE_IDS = PARITY_REQUIRED_CASES.map((fixture) => fixture.caseId);
export const PARITY_REQUIRED_BACKEND_IDS = matrix.requiredBackends as readonly ParityBackendId[];
export const PARITY_REQUIRED_PIPELINE_IDS = matrix.requiredPipelines;
export const PARITY_REQUIRED_WEBKIT_CASE_IDS = PARITY_CASE_AUTHORITY
  .filter((entry) => entry.required && entry.matrixRequiredBackends.includes('webkit-webgl2'))
  .map((entry) => entry.caseId);
