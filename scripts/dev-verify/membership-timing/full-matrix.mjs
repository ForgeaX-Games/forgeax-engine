import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { FULL_MATRIX_CONTRACT, FULL_MATRIX_ID } from './webkit-subset.mjs';

const renderOwner = await import('@forgeax/engine-render');
const { MEMBERSHIP_TIMING_REASON_CODES } = renderOwner;

const LIGHT_MATRIX = [32, 64, 128, 256];
const TIMESTAMP_QUERY_UNSUPPORTED = MEMBERSHIP_TIMING_REASON_CODES.find(
  (code) => code === 'timestamp-query-unsupported',
);
const PERMITTED_GPU_REFUSALS = new Set([
  'timestamp-query-unsupported',
  'timestamp-period-unavailable',
  'timestamp-write-unavailable',
]);
const FULL_MATRIX_EXACT = Object.fromEntries(
  Object.entries(FULL_MATRIX_CONTRACT).filter(([key]) => key !== 'generation'),
);

function error(message, path = '$') {
  return { path, message };
}

function reasonCode(value) {
  return value?.code ?? null;
}

function isPermittedGpuRefusal(record, declaration) {
  return (
    (declaration === undefined || declaration.route === 'dawn-gpu') &&
    record?.status === 'refused' &&
    PERMITTED_GPU_REFUSALS.has(reasonCode(record.reason))
  );
}

function expectedChildren(manifest, attemptId) {
  return manifest.references
    .filter((item) => item.parentAttemptId === attemptId)
    .map((item) => item.referenceId)
    .sort();
}

export function createFullMatrixManifest({ sourceHead, corpusId = `real-${sourceHead}` }) {
  if (!/^[0-9a-f]{40}$/.test(sourceHead)) throw new Error('sourceHead must be a full commit SHA');
  const attempts = [];
  for (const lights of LIGHT_MATRIX) {
    const count = lights === 256 ? 1 : 5;
    for (let index = 1; index <= count; index += 1) {
      attempts.push({
        attemptId: `dawn-gpu-${lights}-${index}`,
        route: 'dawn-gpu',
        lights,
        expectedStatus: 'accepted',
        expectedProducer: 'gpu',
        expectedReason: null,
      });
    }
  }
  attempts.push(
    {
      attemptId: 'dawn-cpu-control',
      route: 'dawn-cpu-control',
      lights: 128,
      expectedStatus: 'accepted-control',
      expectedProducer: 'cpu',
      expectedReason: null,
    },
    {
      attemptId: 'webkit-cpu-control',
      route: 'webkit-cpu-control',
      lights: 128,
      expectedStatus: 'accepted-control',
      expectedProducer: 'cpu',
      expectedReason: null,
    },
    {
      attemptId: 'webkit-gpu-refused',
      route: 'webkit-gpu-refused',
      lights: 128,
      expectedStatus: 'refused',
      expectedProducer: 'cpu',
      expectedReason: TIMESTAMP_QUERY_UNSUPPORTED,
    },
    {
      attemptId: 'rhinull-gpu-refused',
      route: 'rhinull-gpu-refused',
      lights: 128,
      expectedStatus: 'refused',
      expectedProducer: 'cpu',
      expectedReason: TIMESTAMP_QUERY_UNSUPPORTED,
    },
  );
  const acceptedGpu = attempts.filter((item) => item.route === 'dawn-gpu');
  const references = acceptedGpu.flatMap((parent) => [
    {
      referenceId: `${parent.attemptId}/cpu-membership`,
      parentAttemptId: parent.attemptId,
      referenceKind: 'cpu-membership',
      expectedOutcome: 'accepted-reference',
    },
    {
      referenceId: `${parent.attemptId}/timing-omitted-pixel`,
      parentAttemptId: parent.attemptId,
      referenceKind: 'timing-omitted-pixel',
      expectedOutcome: 'accepted-reference',
    },
  ]);
  return {
    schemaVersion: 1,
    generation: FULL_MATRIX_CONTRACT.generation,
    evidenceKind: 'real',
    sourceHead,
    corpusId,
    attempts,
    references,
    exact: FULL_MATRIX_EXACT,
  };
}

export function validateFullMatrixManifest(manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== 1) errors.push(error('schemaVersion must be 1'));
  if (manifest?.generation !== FULL_MATRIX_CONTRACT.generation)
    errors.push(error('manifest generation is not the current full-matrix generation'));
  if (manifest?.evidenceKind !== 'real') errors.push(error('full matrix requires real evidence'));
  if (typeof manifest?.sourceHead !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.sourceHead))
    errors.push(error('manifest sourceHead must be a full commit SHA', '$.sourceHead'));
  if (typeof manifest?.corpusId !== 'string' || manifest.corpusId.length === 0)
    errors.push(error('manifest corpusId is required', '$.corpusId'));
  if (!Array.isArray(manifest?.attempts) || manifest.attempts.length !== 20)
    errors.push(error('full matrix requires exactly 20 attempt declarations', '$.attempts'));
  if (!Array.isArray(manifest?.references) || manifest.references.length !== 32)
    errors.push(error('full matrix requires exactly 32 reference declarations', '$.references'));
  if (JSON.stringify(manifest?.exact) !== JSON.stringify(FULL_MATRIX_EXACT))
    errors.push(error('manifest exact counts differ from the full-matrix contract', '$.exact'));

  const acceptedGpu = (manifest?.attempts ?? []).filter(
    (item) => item.route === 'dawn-gpu' && item.expectedStatus === 'accepted',
  );
  const acceptedByLights = Object.fromEntries(
    LIGHT_MATRIX.map((lights) => [
      lights,
      acceptedGpu.filter((item) => item.lights === lights).length,
    ]),
  );
  if (JSON.stringify(acceptedByLights) !== JSON.stringify(FULL_MATRIX_CONTRACT.acceptedGpuByLights))
    errors.push(error('accepted GPU declarations do not implement the light matrix', '$.attempts'));
  for (const route of [
    'dawn-cpu-control',
    'webkit-cpu-control',
    'webkit-gpu-refused',
    'rhinull-gpu-refused',
  ]) {
    if (!(manifest?.attempts ?? []).some((item) => item.route === route))
      errors.push(error(`manifest is missing required route ${route}`, '$.attempts'));
  }
  for (const item of (manifest?.attempts ?? []).filter(
    (candidate) =>
      candidate.route === 'webkit-gpu-refused' || candidate.route === 'rhinull-gpu-refused',
  )) {
    if (
      item.expectedStatus !== 'refused' ||
      item.expectedProducer !== 'cpu' ||
      item.expectedReason !== TIMESTAMP_QUERY_UNSUPPORTED
    )
      errors.push(
        error(`unsupported route ${item.route} must be a timestamp refusal`, '$.attempts'),
      );
  }
  const acceptedIds = new Set(acceptedGpu.map((item) => item.attemptId));
  const expectedReferenceIds = new Set(
    acceptedGpu.flatMap((item) => [
      `${item.attemptId}/cpu-membership`,
      `${item.attemptId}/timing-omitted-pixel`,
    ]),
  );
  const actualReferenceIds = new Set((manifest?.references ?? []).map((item) => item.referenceId));
  if (
    actualReferenceIds.size !== expectedReferenceIds.size ||
    [...expectedReferenceIds].some((id) => !actualReferenceIds.has(id))
  )
    errors.push(
      error(
        'references are not exactly two children of every accepted GPU attempt',
        '$.references',
      ),
    );
  for (const item of manifest?.references ?? []) {
    if (!acceptedIds.has(item.parentAttemptId) || item.expectedOutcome !== 'accepted-reference')
      errors.push(
        error(`reference ${item.referenceId} has an invalid parent or outcome`, '$.references'),
      );
  }
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
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
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
      error(`${name} artifact byte count does not match descriptor`, `$.artifacts.${name}`),
    );
  if (sha256(bytes) !== descriptor.sha256)
    errors.push(error(`${name} artifact SHA-256 does not match descriptor`, `$.artifacts.${name}`));
}

function checkCommon(record, manifest, artifactRoot, errors) {
  if (record?.schemaVersion !== 1) errors.push(error('record schemaVersion must be 1'));
  if (record?.evidenceKind !== 'real')
    errors.push(error('record evidenceKind must be real', '$.evidenceKind'));
  if (record?.sourceHead !== manifest.sourceHead)
    errors.push(error('record sourceHead differs from manifest', '$.sourceHead'));
  if (record?.process?.pid <= 0)
    errors.push(error('real record requires a process id', '$.process.pid'));
  if (typeof record?.process?.id !== 'string' || record.process.id.length === 0)
    errors.push(error('record process.id is required', '$.process.id'));
  if (typeof record?.payloadIdentity !== 'string' || record.payloadIdentity.length === 0)
    errors.push(error('record payloadIdentity is required', '$.payloadIdentity'));
  const provenance = record?.provenance;
  if (provenance?.frameTarget < 300 || provenance?.frames < 300)
    errors.push(error('real record requires 300 target and observed frames', '$.provenance'));
  if (provenance?.dimensions?.width < 1 || provenance?.dimensions?.height < 1)
    errors.push(error('record dimensions are required', '$.provenance.dimensions'));
  if (!record?.timing || !record?.outputHashes || !record?.artifacts)
    errors.push(error('record timing, outputHashes, and artifacts are required'));
  for (const [name, descriptor] of Object.entries(record?.artifacts ?? {}))
    checkArtifact(descriptor, artifactRoot, name, errors);
}

function checkAcceptedGpuTiming(record, errors) {
  const gpu = record.gpu;
  const timingGpu = record.timing?.gpu;
  if (
    gpu === null ||
    timingGpu === null ||
    typeof gpu !== 'object' ||
    typeof timingGpu !== 'object'
  ) {
    errors.push(error('accepted GPU attempt lacks GPU timing', '$.timing.gpu'));
    return;
  }
  if (JSON.stringify(gpu) !== JSON.stringify(timingGpu))
    errors.push(
      error('record GPU timing differs between terminal and timing projections', '$.timing.gpu'),
    );
  if (
    gpu.rawUnit !== 'ticks' ||
    !/^(0|[1-9]\d*)$/.test(gpu.rawBeginTick) ||
    !/^(0|[1-9]\d*)$/.test(gpu.rawEndTick) ||
    !/^(0|[1-9]\d*)$/.test(gpu.deltaTicks)
  ) {
    errors.push(error('accepted GPU timing must use decimal u64 ticks', '$.gpu'));
    return;
  }
  const begin = BigInt(gpu.rawBeginTick);
  const end = BigInt(gpu.rawEndTick);
  const delta = BigInt(gpu.deltaTicks);
  if (end <= begin || delta !== end - begin)
    errors.push(error('accepted GPU timing must have an advancing exact tick range', '$.gpu'));
  const period = record.provenance.timestampPeriodNanoseconds;
  if (gpu.timestampPeriodNanoseconds !== period)
    errors.push(
      error('GPU timing period differs from provenance period', '$.gpu.timestampPeriodNanoseconds'),
    );
  if (
    !Number.isFinite(period) ||
    period <= 0 ||
    !Number.isFinite(gpu.durationNanoseconds) ||
    gpu.durationNanoseconds <= 0 ||
    gpu.durationNanoseconds !== Number(delta) * period
  )
    errors.push(
      error(
        'accepted GPU timing duration must be finite, positive, and exact',
        '$.gpu.durationNanoseconds',
      ),
    );
  for (const [name, phase] of [
    ['cpu.encode', record.timing.cpu?.encode],
    ['cpu.submit', record.timing.cpu?.submit],
    ['async.queueCompletion', record.timing.async?.queueCompletion],
    ['async.readback', record.timing.async?.readback],
  ]) {
    if (
      phase === null ||
      typeof phase !== 'object' ||
      !Number.isFinite(phase.startNanoseconds) ||
      !Number.isFinite(phase.endNanoseconds) ||
      !Number.isFinite(phase.durationNanoseconds) ||
      phase.endNanoseconds < phase.startNanoseconds ||
      phase.durationNanoseconds < 0
    )
      errors.push(error(`accepted GPU timing phase is incomplete: ${name}`, '$.timing'));
  }
}

const ROUTE_FACTS = {
  'dawn-gpu': {
    backendKind: 'webgpu',
    compute: true,
    timestampQuery: true,
    period: 'positive',
    producer: 'gpu',
  },
  'dawn-cpu-control': {
    backendKind: 'webgpu',
    compute: true,
    timestampQuery: false,
    period: null,
    producer: 'cpu',
  },
  'webkit-cpu-control': {
    backendKind: 'wgpu-webgl2',
    compute: false,
    timestampQuery: false,
    period: null,
    producer: 'cpu',
  },
  'webkit-gpu-refused': {
    backendKind: 'wgpu-webgl2',
    compute: false,
    timestampQuery: false,
    period: null,
    producer: 'cpu',
  },
  'rhinull-gpu-refused': {
    backendKind: 'null',
    compute: true,
    timestampQuery: false,
    period: null,
    producer: 'cpu',
  },
};

function validateRouteFacts(record, declaration, errors) {
  const facts = ROUTE_FACTS[declaration.route];
  if (facts === undefined) {
    errors.push(error(`unknown route facts: ${declaration.route}`, '$.provenance'));
    return;
  }
  const provenance = record.provenance;
  if (provenance.backendKind !== facts.backendKind)
    errors.push(
      error(
        `route ${declaration.route} requires backendKind=${facts.backendKind}`,
        '$.provenance.backendKind',
      ),
    );
  if (provenance.compute !== facts.compute)
    errors.push(
      error(
        `route ${declaration.route} requires compute=${String(facts.compute)}`,
        '$.provenance.compute',
      ),
    );
  if (provenance.timestampQuery !== facts.timestampQuery)
    errors.push(
      error(
        `route ${declaration.route} requires timestampQuery=${String(facts.timestampQuery)}`,
        '$.provenance.timestampQuery',
      ),
    );
  if (facts.period === null && provenance.timestampPeriodNanoseconds !== null)
    errors.push(
      error(
        `route ${declaration.route} requires timestampPeriodNanoseconds=null`,
        '$.provenance.timestampPeriodNanoseconds',
      ),
    );
  if (
    facts.period === 'positive' &&
    !(
      typeof provenance.timestampPeriodNanoseconds === 'number' &&
      provenance.timestampPeriodNanoseconds > 0
    )
  )
    errors.push(
      error(
        `route ${declaration.route} requires a positive timestamp period`,
        '$.provenance.timestampPeriodNanoseconds',
      ),
    );
  const refusedGpuRoute = isPermittedGpuRefusal(record, declaration);
  if (
    record.actualProducer !== facts.producer &&
    !(refusedGpuRoute && record.actualProducer === 'cpu')
  )
    errors.push(
      error(
        `route ${declaration.route} requires actualProducer=${facts.producer}`,
        '$.actualProducer',
      ),
    );
}

function compareProvenance(parent, child, errors) {
  for (const key of [
    'sourceHead',
    'provenance.backendKind',
    'provenance.compute',
    'provenance.adapter',
    'provenance.environment',
    'provenance.configFingerprint',
    'provenance.seed',
    'provenance.frameTarget',
    'provenance.frames',
    'provenance.dimensions',
    'provenance.lights',
    'provenance.clusterGrid',
  ]) {
    const parts = key.split('.');
    let parentValue = parent;
    let childValue = child;
    for (const part of parts) {
      parentValue = parentValue?.[part];
      childValue = childValue?.[part];
    }
    if (JSON.stringify(parentValue) !== JSON.stringify(childValue))
      errors.push(error(`child provenance differs at ${key}`, '$.provenance'));
  }
}

function validateAttempt(record, declaration, manifest, errors) {
  if (record.recordKind !== 'attempt')
    errors.push(error('top-level recordKind must be attempt', '$.recordKind'));
  if (record.attemptId !== declaration.attemptId)
    errors.push(error('attemptId differs from its declaration', '$.attemptId'));
  const permittedGpuRefusal = isPermittedGpuRefusal(record, declaration);
  if (record.status !== declaration.expectedStatus && !permittedGpuRefusal)
    errors.push(
      error(
        `attempt status differs from manifest: expected ${declaration.expectedStatus}`,
        '$.status',
      ),
    );
  if (
    record.actualProducer !== declaration.expectedProducer &&
    !(permittedGpuRefusal && record.actualProducer === 'cpu')
  )
    errors.push(error('actualProducer differs from manifest', '$.actualProducer'));
  if (reasonCode(record.reason) !== declaration.expectedReason && !permittedGpuRefusal)
    errors.push(error('reason differs from manifest', '$.reason'));
  if (record.provenance.lights !== declaration.lights)
    errors.push(error('attempt light count differs from manifest', '$.provenance.lights'));
  validateRouteFacts(record, declaration, errors);
  const children = [...(record.references ?? [])].sort();
  if (
    JSON.stringify(children) !== JSON.stringify(expectedChildren(manifest, declaration.attemptId))
  )
    errors.push(error('parent child reference list differs from manifest', '$.references'));
  if (record.status === 'accepted') {
    if (record.actualProducer !== 'gpu' || record.gpu === null || record.timing.gpu === null)
      errors.push(error('accepted GPU attempt lacks GPU timing', '$'));
    else checkAcceptedGpuTiming(record, errors);
    if (
      record.membership === null ||
      record.outputHashes.membership === null ||
      record.outputHashes.pixel === null
    )
      errors.push(error('accepted GPU attempt lacks exact output hashes', '$.outputHashes'));
    if (record.profile?.status !== 'complete' || record.profile.droppedEventCount !== 0)
      errors.push(error('accepted GPU attempt lacks complete profile', '$.profile'));
    for (const phase of [
      record.timing.submissionToken,
      record.timing.dispatchId,
      record.timing.cpu?.encode,
      record.timing.cpu?.submit,
      record.timing.async?.queueCompletion,
      record.timing.async?.readback,
    ]) {
      if (phase === null || phase === undefined)
        errors.push(error('accepted GPU attempt lacks a complete timing phase set', '$.timing'));
    }
  }
  if (record.status === 'accepted-control') {
    if (record.actualProducer !== 'cpu' || record.gpu !== null || record.timing.gpu !== null)
      errors.push(error('accepted-control must be CPU and have no GPU timing', '$'));
    if (record.profile?.status !== 'complete' || record.profile.droppedEventCount !== 0)
      errors.push(error('accepted-control lacks complete profile', '$.profile'));
  }
  if (record.status === 'refused') {
    if (record.gpu !== null) errors.push(error('refused attempt must have gpu=null', '$.gpu'));
    if (
      declaration.route !== 'dawn-gpu' &&
      (declaration.expectedReason === null ||
        reasonCode(record.reason) !== TIMESTAMP_QUERY_UNSUPPORTED)
    )
      errors.push(error('refused attempt must carry the declared Render refusal', '$.reason'));
    if (declaration.route === 'dawn-gpu' && !PERMITTED_GPU_REFUSALS.has(reasonCode(record.reason)))
      errors.push(error('Dawn GPU refusal must use a permitted timestamp reason', '$.reason'));
  }
}

export function validateReference(record, declaration, parent, errors) {
  if (record.recordKind !== 'reference')
    errors.push(error('nested recordKind must be reference', '$.recordKind'));
  if (record.referenceId !== declaration.referenceId)
    errors.push(error('referenceId differs from its declaration', '$.referenceId'));
  if (record.parentAttemptId !== declaration.parentAttemptId)
    errors.push(error('reference parent differs from its declaration', '$.parentAttemptId'));
  if (record.referenceKind !== declaration.referenceKind)
    errors.push(error('reference kind differs from its declaration', '$.referenceKind'));
  if (record.terminal?.outcome !== declaration.expectedOutcome)
    errors.push(error('reference outcome differs from its declaration', '$.terminal.outcome'));
  if (record.terminal?.reason !== null)
    errors.push(error('accepted reference must have reason=null', '$.terminal.reason'));
  if (record.gpu !== null || JSON.stringify(record.references) !== '[]')
    errors.push(error('nested references cannot contain GPU timing or children', '$'));
  if (record.provenance.backendKind !== 'webgpu' || record.provenance.compute !== true)
    errors.push(error('nested references require the Dawn WebGPU route', '$.provenance'));
  if (declaration.referenceKind === 'cpu-membership') {
    const refusedGpuParent = isPermittedGpuRefusal(parent);
    if (
      record.actualProducer !== 'cpu' ||
      record.provenance.timestampQuery !== false ||
      record.provenance.timestampPeriodNanoseconds !== null
    )
      errors.push(error('cpu-membership reference route facts are invalid', '$'));
    if (record.outputHashes.membership === null)
      errors.push(
        error(
          'cpu-membership reference does not provide membership output',
          '$.outputHashes.membership',
        ),
      );
    else if (!refusedGpuParent && record.outputHashes.membership !== parent.outputHashes.membership)
      errors.push(
        error(
          'cpu-membership reference does not equal parent membership output',
          '$.outputHashes.membership',
        ),
      );
  } else {
    if (record.actualProducer !== 'gpu')
      errors.push(
        error('timing-omitted-pixel reference requires actualProducer=gpu', '$.actualProducer'),
      );
    if (
      record.outputHashes.pixel === null ||
      record.outputHashes.pixel !== parent.outputHashes.pixel
    )
      errors.push(
        error(
          'timing-omitted-pixel reference does not equal parent pixel output',
          '$.outputHashes.pixel',
        ),
      );
  }
  if (record.profile?.status !== 'complete' || record.profile.droppedEventCount !== 0)
    errors.push(error('accepted reference lacks complete profile', '$.profile'));
  compareProvenance(parent, record, errors);
}

function recordsFromDirectory(root) {
  const records = [];
  if (!existsSync(root)) return records;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) records.push(...recordsFromDirectory(path));
    else if (entry.isFile() && entry.name === 'record.json')
      records.push(JSON.parse(readFileSync(path, 'utf8')));
  }
  return records;
}

export function recordsFromPath(path) {
  const resolved = resolve(path);
  if (statSync(resolved).isDirectory()) return recordsFromDirectory(resolved);
  const value = JSON.parse(readFileSync(resolved, 'utf8'));
  return Array.isArray(value) ? value : [value];
}

export function validateRealCorpus({
  manifest,
  records,
  artifactRoot,
  artifactRootForRecord = () => artifactRoot,
}) {
  const errors = [...validateFullMatrixManifest(manifest).errors];
  const attempts = new Map((manifest.attempts ?? []).map((item) => [item.attemptId, item]));
  const references = new Map((manifest.references ?? []).map((item) => [item.referenceId, item]));
  const seenAttempts = new Map();
  const seenReferences = new Map();
  const seenProcessIds = new Set();
  const seenPayloads = new Set();
  const seenArtifacts = new Set();
  const parentRecords = new Map();
  const referenceRecords = [];

  for (const record of records ?? []) {
    if (record === null || typeof record !== 'object') {
      errors.push(error('record must be an object'));
      continue;
    }
    const root = artifactRootForRecord(record) ?? artifactRoot;
    checkCommon(record, manifest, root, errors);
    if (seenProcessIds.has(record.process?.id))
      errors.push(error(`process identity is reused: ${record.process?.id}`));
    seenProcessIds.add(record.process?.id);
    if (seenPayloads.has(record.payloadIdentity))
      errors.push(error(`payload identity is reused: ${record.payloadIdentity}`));
    seenPayloads.add(record.payloadIdentity);
    for (const descriptor of Object.values(record.artifacts ?? {})) {
      const path = `${resolve(root)}${sep}${descriptor?.path ?? ''}`;
      if (seenArtifacts.has(path)) errors.push(error(`artifact path is reused: ${path}`));
      seenArtifacts.add(path);
    }
    if (record.recordKind === 'attempt') {
      seenAttempts.set(record.attemptId, (seenAttempts.get(record.attemptId) ?? 0) + 1);
      const declaration = attempts.get(record.attemptId);
      if (declaration === undefined) {
        errors.push(error(`undeclared top-level attempt ${record.attemptId}`, '$.attemptId'));
        continue;
      }
      validateAttempt(record, declaration, manifest, errors);
      parentRecords.set(record.attemptId, record);
    } else if (record.recordKind === 'reference') {
      seenReferences.set(record.referenceId, (seenReferences.get(record.referenceId) ?? 0) + 1);
      referenceRecords.push(record);
    } else {
      errors.push(error('recordKind must be attempt or reference', '$.recordKind'));
    }
  }

  for (const record of referenceRecords) {
    const declaration = references.get(record.referenceId);
    const parent = parentRecords.get(record.parentAttemptId);
    if (declaration === undefined)
      errors.push(error(`undeclared nested reference ${record.referenceId}`, '$.referenceId'));
    else if (parent === undefined)
      errors.push(
        error(`reference parent is missing: ${record.parentAttemptId}`, '$.parentAttemptId'),
      );
    else validateReference(record, declaration, parent, errors);
  }

  if (
    (records ?? []).filter((record) => record.recordKind === 'attempt').length !==
    FULL_MATRIX_CONTRACT.topLevel
  )
    errors.push(error('real corpus does not contain exactly 20 top-level records'));
  if (
    (records ?? []).filter((record) => record.recordKind === 'reference').length !==
    FULL_MATRIX_CONTRACT.nested
  )
    errors.push(error('real corpus does not contain exactly 32 nested records'));
  for (const [id, count] of seenAttempts)
    if (count !== 1) errors.push(error(`top-level attempt ${id} is duplicated`));
  for (const [id, count] of seenReferences)
    if (count !== 1) errors.push(error(`nested reference ${id} is duplicated`));
  for (const id of attempts.keys())
    if (!seenAttempts.has(id)) errors.push(error(`missing top-level attempt ${id}`));
  for (const id of references.keys())
    if (!seenReferences.has(id)) errors.push(error(`missing nested reference ${id}`));

  const webkitRecords = (records ?? []).filter(
    (record) => record.provenance?.backendKind === 'wgpu-webgl2',
  );
  const webkitPixels = new Set(
    webkitRecords.map((record) => record.outputHashes?.pixel).filter((value) => value !== null),
  );
  if (webkitRecords.length !== 2 || webkitPixels.size !== 1)
    errors.push(
      error('WebKit control and refusal must provide identical real pixel output', '$.records'),
    );

  const counts = {
    topLevel: (records ?? []).filter((record) => record.recordKind === 'attempt').length,
    nested: (records ?? []).filter((record) => record.recordKind === 'reference').length,
    acceptedGpu: (records ?? []).filter(
      (record) =>
        record.recordKind === 'attempt' &&
        record.status === 'accepted' &&
        record.actualProducer === 'gpu',
    ).length,
    acceptedControl: (records ?? []).filter(
      (record) => record.recordKind === 'attempt' && record.status === 'accepted-control',
    ).length,
    refused: (records ?? []).filter(
      (record) => record.recordKind === 'attempt' && record.status === 'refused',
    ).length,
  };
  const acceptedGpuRecords = (records ?? []).filter(
    (record) =>
      record.recordKind === 'attempt' &&
      record.status === 'accepted' &&
      record.actualProducer === 'gpu',
  );
  const varianceReady = [32, 64, 128].every((lights) => {
    const deltas = new Set(
      acceptedGpuRecords
        .filter((record) => record.provenance?.lights === lights)
        .map((record) => record.gpu?.deltaTicks)
        .filter((value) => typeof value === 'string'),
    );
    return deltas.size >= 2;
  });
  const overflowReady = acceptedGpuRecords.some(
    (record) => record.provenance?.lights === 256 && record.membership?.overflow === true,
  );
  const truthfulnessReady = errors.length === 0;
  const optimizationReleaseReady =
    truthfulnessReady &&
    acceptedGpuRecords.length === FULL_MATRIX_CONTRACT.acceptedGpu &&
    varianceReady &&
    overflowReady;
  return {
    valid: truthfulnessReady,
    errors,
    counts,
    evidenceKind: manifest.evidenceKind,
    truthfulnessReady,
    optimizationReleaseReady,
    completeMatrixReady: truthfulnessReady,
    aggregateTarget: FULL_MATRIX_ID,
  };
}
