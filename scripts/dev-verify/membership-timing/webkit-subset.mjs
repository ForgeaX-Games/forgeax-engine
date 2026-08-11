import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const renderOwner = await import('@forgeax/engine-render');
const { MEMBERSHIP_TIMING_REASON_CODES, MEMBERSHIP_TIMING_REASON_MAPPING } = renderOwner;
const subsetSchema = JSON.parse(
  readFileSync(new URL('./webkit-subset.schema.json', import.meta.url), 'utf8'),
);
const fullMatrixContract = JSON.parse(
  readFileSync(new URL('./full-matrix-contract.json', import.meta.url), 'utf8'),
);

export const FULL_MATRIX_CONTRACT = Object.freeze(fullMatrixContract);
export const WEBKIT_SUBSET_KIND = 'webkit-deferred-membership-control-refusal';
export const FULL_MATRIX_ID = 'deferred-membership-timing-generation-4';

function error(message, path = '$') {
  return { path, message };
}

function reasonCode(name) {
  const code = MEMBERSHIP_TIMING_REASON_CODES.find((candidate) => candidate === name);
  if (code === undefined || MEMBERSHIP_TIMING_REASON_MAPPING[code] === undefined)
    throw new Error(`Render reason owner does not export ${name}`);
  return code;
}

const timestampQueryUnsupported = reasonCode('timestamp-query-unsupported');

function validateSchema(value) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validator = ajv.compile(subsetSchema);
  if (validator(value)) return [];
  return (validator.errors ?? []).map((item) =>
    error(item.message ?? 'invalid WebKit subset manifest', item.instancePath || '$'),
  );
}

export function validateWebkitSubsetManifest(manifest) {
  const errors = validateSchema(manifest);
  if (errors.length > 0) return { valid: false, errors };
  const byRoute = new Map(manifest.attempts.map((item) => [item.route, item]));
  const control = byRoute.get('webkit-cpu-control');
  const refused = byRoute.get('webkit-gpu-refused');
  if (manifest.subsetOf !== FULL_MATRIX_ID)
    errors.push(error(`subset must target ${FULL_MATRIX_ID}`, '$.subsetOf'));
  if (control?.expectedStatus !== 'accepted-control' || control.expectedReason !== null)
    errors.push(error('WebKit subset must declare an accepted CPU control attempt', '$.attempts'));
  if (
    refused?.expectedStatus !== 'refused' ||
    refused.expectedReason !== timestampQueryUnsupported
  ) {
    errors.push(
      error('WebKit subset must declare the Render timestamp-query refusal', '$.attempts'),
    );
  }
  if (control?.attemptId === refused?.attemptId)
    errors.push(error('WebKit subset attempt IDs must be unique', '$.attempts'));
  return { valid: errors.length === 0, errors };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkArtifact(descriptor, artifactRoot, name, errors) {
  if (descriptor === null || typeof descriptor !== 'object') {
    errors.push(error(`${name} artifact descriptor is missing`, `$.artifacts.${name}`));
    return;
  }
  const root = resolve(artifactRoot);
  const path = resolve(root, descriptor.path ?? '');
  if (path !== root && !path.startsWith(`${root}/`)) {
    errors.push(error(`${name} artifact escapes artifactRoot`, `$.artifacts.${name}.path`));
    return;
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    errors.push(error(`missing ${name} artifact: ${descriptor.path}`, `$.artifacts.${name}`));
    return;
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength !== descriptor.bytes)
    errors.push(
      error(`${name} artifact byte count does not match descriptor`, `$.artifacts.${name}.bytes`),
    );
  if (sha256(bytes) !== descriptor.sha256)
    errors.push(
      error(`${name} artifact SHA-256 does not match descriptor`, `$.artifacts.${name}.sha256`),
    );
  return bytes;
}

function checkRecord(record, declaration, artifactRoot) {
  const errors = [];
  if (record === undefined || record === null || typeof record !== 'object')
    return [error('record is missing')];
  if (record.recordKind !== 'attempt')
    errors.push(error('WebKit subset records must be attempts', '$.recordKind'));
  if (record.attemptId !== declaration.attemptId)
    errors.push(error('record attemptId does not match its declaration', '$.attemptId'));
  if (record.schemaVersion !== 1)
    errors.push(error('record schemaVersion must be 1', '$.schemaVersion'));
  if (record.evidenceKind !== 'real')
    errors.push(error('WebKit subset records must be real evidence', '$.evidenceKind'));
  if (typeof record.sourceHead !== 'string' || !/^[0-9a-f]{40}$/.test(record.sourceHead))
    errors.push(error('record sourceHead must be a full commit SHA', '$.sourceHead'));
  if (record.process?.pid <= 0)
    errors.push(error('real WebKit records require a live process id', '$.process.pid'));
  if (typeof record.payloadIdentity !== 'string' || record.payloadIdentity.length === 0)
    errors.push(error('record payloadIdentity is required', '$.payloadIdentity'));
  const provenance = record.provenance;
  if (provenance?.backendKind !== 'wgpu-webgl2')
    errors.push(
      error('WebKit records require backendKind=wgpu-webgl2', '$.provenance.backendKind'),
    );
  if (provenance?.compute !== false)
    errors.push(error('WebKit records require compute=false', '$.provenance.compute'));
  if (provenance?.timestampQuery !== false)
    errors.push(
      error('WebKit records require timestampQuery=false', '$.provenance.timestampQuery'),
    );
  if (provenance?.timestampPeriodNanoseconds !== null)
    errors.push(
      error(
        'WebKit records require timestampPeriodNanoseconds=null',
        '$.provenance.timestampPeriodNanoseconds',
      ),
    );
  if (provenance?.lights !== 128)
    errors.push(error('WebKit records require lights=128', '$.provenance.lights'));
  if (provenance?.frameTarget < 300 || provenance?.frames < 300)
    errors.push(
      error('WebKit records require at least 300 target and observed frames', '$.provenance'),
    );
  if (record.actualProducer !== 'cpu')
    errors.push(error('WebKit records require actualProducer=cpu', '$.actualProducer'));
  if (!Array.isArray(record.references) || record.references.length !== 0)
    errors.push(error('WebKit subset records must not declare nested references', '$.references'));
  if (record.gpu !== null) errors.push(error('WebKit records must not claim GPU timing', '$.gpu'));
  if (record.timing?.gpu !== null)
    errors.push(error('WebKit records must not claim GPU timing phases', '$.timing.gpu'));
  if (record.status === 'accepted-control') {
    if (record.reason !== null)
      errors.push(error('accepted-control must have reason=null', '$.reason'));
    if (record.membership === null || record.outputHashes?.membership === null)
      errors.push(error('accepted-control requires canonical membership output', '$.membership'));
    if (record.profile?.status !== 'complete' || record.profile?.droppedEventCount !== 0)
      errors.push(error('accepted-control requires complete ProfileCapture evidence', '$.profile'));
  } else if (record.status === 'refused') {
    if (record.reason?.code !== timestampQueryUnsupported)
      errors.push(error('refused WebKit attempt must use timestamp-query-unsupported', '$.reason'));
  } else {
    errors.push(error('WebKit subset status must be accepted-control or refused', '$.status'));
  }
  for (const [name, descriptor] of Object.entries(record.artifacts ?? {})) {
    const bytes = checkArtifact(descriptor, artifactRoot, name, errors);
    if (
      name === 'pixel' &&
      bytes !== undefined &&
      record.outputHashes?.pixel !== null &&
      sha256(bytes) !== record.outputHashes?.pixel
    )
      errors.push(
        error('pixel artifact does not match outputHashes.pixel', '$.outputHashes.pixel'),
      );
    if (
      name === 'membership' &&
      bytes !== undefined &&
      record.outputHashes?.membership !== null &&
      sha256(bytes) !== record.outputHashes?.membership
    )
      errors.push(
        error(
          'membership artifact does not match outputHashes.membership',
          '$.outputHashes.membership',
        ),
      );
  }
  return errors;
}

export function validateWebkitSubsetRecord(record, manifest, artifactRoot) {
  const declaration = manifest.attempts.find((item) => item.attemptId === record?.attemptId);
  const errors =
    declaration === undefined
      ? [error(`record attempt is not declared: ${record?.attemptId}`, '$.attemptId')]
      : checkRecord(record, declaration, artifactRoot);
  return { valid: errors.length === 0, errors };
}

export function joinWebkitSubsetCapture({ manifest, records, artifactRoot, rawComparison }) {
  const errors = [...validateWebkitSubsetManifest(manifest).errors];
  if (!Array.isArray(records) || records.length !== 2)
    errors.push(error('WebKit subset join requires exactly two attempt records', '$.records'));
  if (rawComparison?.pixelHashEqual !== true || rawComparison?.pixelBytesEqual !== true)
    errors.push(
      error('WebKit control/refusal raw pixel comparison did not pass', '$.rawComparison'),
    );
  const seen = new Set();
  for (const record of records ?? []) {
    if (seen.has(record?.attemptId))
      errors.push(error('WebKit subset record attempt IDs must be unique', '$.records'));
    seen.add(record?.attemptId);
    const validation = validateWebkitSubsetRecord(record, manifest, artifactRoot);
    errors.push(
      ...validation.errors.map((item) => ({
        ...item,
        path: `$.records[${record?.attemptId}]${item.path}`,
      })),
    );
    const declaration = manifest.attempts.find((item) => item.attemptId === record?.attemptId);
    if (declaration !== undefined) {
      if (record.status !== declaration.expectedStatus)
        errors.push(
          error(
            'record status differs from its declaration',
            `$.records[${record.attemptId}].status`,
          ),
        );
      if (record.actualProducer !== declaration.expectedProducer)
        errors.push(
          error(
            'record producer differs from its declaration',
            `$.records[${record.attemptId}].actualProducer`,
          ),
        );
    }
  }
  const routes = new Set((records ?? []).map((record) => record?.provenance?.backendKind));
  if (routes.size > 0 && !routes.has('wgpu-webgl2'))
    errors.push(error('WebKit subset has no wgpu-webgl2 records', '$.records'));
  return {
    valid: errors.length === 0,
    errors,
    artifactKind: 'declared-subset',
    completeMatrixReady: false,
    aggregateTarget: FULL_MATRIX_ID,
    aggregateReason:
      'the WebKit driver supplies a validated subset; Dawn and RhiNull rows remain required for the exact 20+32 matrix',
    counts: { topLevel: 2, nested: 0, acceptedGpu: 0, acceptedControl: 1, refused: 1 },
  };
}
