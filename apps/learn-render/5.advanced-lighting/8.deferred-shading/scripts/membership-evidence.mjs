import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const renderOwner = await import('@forgeax/engine-render');
const { MEMBERSHIP_TIMING_REASON_CODES, MEMBERSHIP_TIMING_REASON_MAPPING } = renderOwner;

function ownerCode(name) {
  const code = MEMBERSHIP_TIMING_REASON_CODES.find((candidate) => candidate === name);
  if (code === undefined) throw new Error(`Render reason owner does not export ${name}`);
  return code;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const payloadIdentities = new WeakMap();
let payloadSerial = 0;

function objectIdentity(value) {
  if (value === null || typeof value !== 'object') return 'none';
  let identity = payloadIdentities.get(value);
  if (identity === undefined) {
    identity = `object-${++payloadSerial}`;
    payloadIdentities.set(value, identity);
  }
  return identity;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function atomicWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

function artifact(root, relativePath, bytes, artifactRoot) {
  const path = join(root, relativePath);
  atomicWrite(path, bytes);
  return { path: relative(resolve(artifactRoot, '.'), path), bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function declarationFor(manifest, input) {
  if (input.recordKind === 'attempt') {
    if (input.attemptId === undefined || input.referenceId !== undefined || input.parentAttemptId !== undefined) {
      throw new Error('attempt records require attemptId and forbid reference identity');
    }
    const declaration = manifest.attempts.find((item) => item.attemptId === input.attemptId);
    if (declaration === undefined) throw new Error(`attemptId is not predeclared: ${input.attemptId}`);
    return declaration;
  }
  if (input.referenceId === undefined || input.parentAttemptId === undefined || input.attemptId !== undefined) {
    throw new Error('reference records require referenceId + parentAttemptId and forbid attemptId');
  }
  const declaration = manifest.references.find((item) => item.referenceId === input.referenceId);
  if (declaration === undefined) throw new Error(`referenceId is not predeclared: ${input.referenceId}`);
  if (declaration.parentAttemptId !== input.parentAttemptId || declaration.referenceKind !== input.referenceKind) {
    throw new Error(`reference declaration mismatch: ${input.referenceId}`);
  }
  return declaration;
}

function reasonObject(code, detail) {
  if (code === null) return null;
  if (!MEMBERSHIP_TIMING_REASON_MAPPING[code]) throw new Error(`unknown Render reason code: ${code}`);
  return detail === undefined ? { code } : { code, detail };
}

function failureCode(input, profile) {
  if (typeof input.reasonCode === 'string') return ownerCode(input.reasonCode);
  if (input.timing && typeof input.timing.code === 'string') return ownerCode(input.timing.code);
  if (input.mode === 'gpu' && input.evidence?.timestampQuery === false) return ownerCode('timestamp-query-unsupported');
  if (input.mode === 'gpu' && input.evidence?.timestampQuery === true && !(input.evidence.timestampPeriodNanoseconds > 0)) return ownerCode('timestamp-period-unavailable');
  if (profile.status !== 'complete' || profile.droppedEventCount !== 0) return ownerCode('profile-incomplete');
  if (input.referenceKind === 'cpu-membership' && input.membership === null) return ownerCode('membership-output-mismatch');
  if (input.referenceKind === 'timing-omitted-pixel' && input.pixels === null) return ownerCode('pixel-output-mismatch');
  return ownerCode('terminal-record-incomplete');
}

function completeProfile(profile, profileArtifact) {
  const completeness = profile?.completeness;
  const status =
    completeness?.status === 'complete' && completeness.droppedEventCount === 0
      ? 'complete'
      : completeness?.status === 'not-requested'
        ? 'not-requested'
        : 'incomplete';
  return {
    status,
    droppedEventCount:
      typeof completeness?.droppedEventCount === 'number' ? completeness.droppedEventCount : 0,
    artifact: profileArtifact,
  };
}

function timingRecord(input, gpuTiming) {
  const source = input.timing ?? {};
  return {
    gpu: gpuTiming,
    submissionToken: typeof source.submissionToken === 'string' ? source.submissionToken : null,
    dispatchId: typeof source.dispatchId === 'string' ? source.dispatchId : null,
    cpu: source.cpu ?? { encode: null, submit: null },
    async: source.async ?? { queueCompletion: null, readback: null },
  };
}

/**
 * Write one terminal attempt or nested-reference record. The ID declaration
 * is checked before any artifact is published; all artifacts then use atomic
 * sibling writes and the terminal record is published last.
 */
export function writeMembershipEvidence(input) {
  const root = resolve(input.outputDir);
  const artifactRoot = resolve(input.artifactRoot ?? root);
  mkdirSync(root, { recursive: true });
  const manifest = input.manifest ?? { attempts: [], references: [] };
  const declaration = declarationFor(manifest, input);
  const startedAt = input.startedAt ?? new Date().toISOString();
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  const identifier = input.recordKind === 'attempt' ? input.attemptId : input.referenceId;
  const profileValue =
    input.profile ?? { completeness: { status: 'not-requested', droppedEventCount: 0 } };
  const membership = input.membership ?? input.timing?.membership ?? null;
  const inputPixels = input.pixels === null || input.pixels === undefined ? null : input.pixels;
  const pixels = inputPixels === null ? null : Buffer.from(inputPixels);
  const payloadIdentity =
    input.payloadIdentity ??
    `${process.pid}:${objectIdentity(membership)}:${objectIdentity(inputPixels)}`;
  const profileBytes = jsonBytes(profileValue);
  const membershipBytes = membership === null ? Buffer.alloc(0) : jsonBytes(membership);
  const pixelBytes = pixels ?? Buffer.alloc(0);
  const profileArtifact = artifact(root, 'profile.json', profileBytes, artifactRoot);
  const membershipArtifact = artifact(root, 'membership.json', membershipBytes, artifactRoot);
  const pixelArtifact = artifact(root, 'frame.rgba', pixelBytes, artifactRoot);
  const evidence = input.evidence ?? {};
  const actualProducer =
    input.timing?.actualProducer ??
    input.actualProducer ??
    evidence.actualProducer ??
    (input.mode === 'gpu' ? 'gpu' : 'cpu');
  const profile = completeProfile(profileValue, profileArtifact);
  const gpuTiming = input.timing?.gpu ?? null;
  const timing = timingRecord(input, gpuTiming);
  const outputHashes = {
    membership: membership === null ? null : sha256(membershipBytes),
    pixel: pixels === null ? null : sha256(pixelBytes),
  };
  const hasPixels = pixels !== null && pixels.byteLength > 0;
  const hasMembership = membership !== null;
  const profileOk = profile.status === 'complete' && profile.droppedEventCount === 0;
  let status;
  let outcome;
  let reasonCodeValue = null;
  if (input.mode === 'gpu' && evidence.timestampQuery === false) {
    reasonCodeValue = ownerCode('timestamp-query-unsupported');
  } else if (input.mode === 'gpu' && evidence.timestampQuery === true && !(evidence.timestampPeriodNanoseconds > 0)) {
    reasonCodeValue = ownerCode('timestamp-period-unavailable');
  }
  const declaredChildren = input.recordKind === 'attempt'
    ? manifest.references.filter((item) => item.parentAttemptId === input.attemptId)
    : [];
  let references = input.references ?? [];
  const gpuPhasesComplete =
    timing.submissionToken !== null &&
    timing.dispatchId !== null &&
    timing.cpu.encode !== null &&
    timing.cpu.submit !== null &&
    timing.async.queueCompletion !== null &&
    timing.async.readback !== null;
  if (input.recordKind === 'attempt' && input.mode === 'gpu' && actualProducer === 'gpu' && gpuTiming !== null && hasMembership && hasPixels && profileOk) {
    if (declaredChildren.length !== 2) throw new Error(`accepted GPU attempt must declare exactly two nested references: ${input.attemptId}`);
    if (gpuPhasesComplete && input.references === undefined) {
      throw new Error(`accepted GPU attempt requires separately executed child references: ${input.attemptId}`);
    }
    if (input.references !== undefined) references = input.references;
  }
  if (input.recordKind === 'attempt' && input.references !== undefined && JSON.stringify([...input.references].sort()) !== JSON.stringify(declaredChildren.map((item) => item.referenceId).sort())) {
    throw new Error(`attempt child references do not match the feature manifest: ${input.attemptId}`);
  }
  if (input.recordKind === 'attempt') {
    if (reasonCodeValue !== null) status = 'refused';
    else if (input.mode === 'gpu' && actualProducer === 'gpu' && gpuTiming !== null && gpuPhasesComplete && hasMembership && hasPixels && profileOk && references.length === 2) status = 'accepted';
    else if (input.mode === 'cpu-control' && actualProducer === 'cpu' && hasMembership && hasPixels && profileOk) status = 'accepted-control';
    else {
      reasonCodeValue = reasonCodeValue ?? failureCode({ ...input, membership, pixels }, profile);
      status = MEMBERSHIP_TIMING_REASON_MAPPING[reasonCodeValue].topLevel;
    }
  } else if (reasonCodeValue !== null) {
    outcome = MEMBERSHIP_TIMING_REASON_MAPPING[reasonCodeValue].reference;
  } else if (input.referenceKind === 'cpu-membership' && input.mode === 'cpu-control' && hasMembership && profileOk) {
    outcome = 'accepted-reference';
  } else if (input.referenceKind === 'timing-omitted-pixel' && input.mode === 'omitted' && hasPixels) {
    outcome = 'accepted-reference';
  } else {
    reasonCodeValue = failureCode({ ...input, membership, pixels }, profile);
    outcome = MEMBERSHIP_TIMING_REASON_MAPPING[reasonCodeValue].reference;
  }
  const provenance = {
    backendKind: evidence.backendKind ?? 'unknown',
    compute: evidence.compute === true,
    timestampQuery: evidence.timestampQuery === true,
    timestampPeriodNanoseconds: typeof evidence.timestampPeriodNanoseconds === 'number' ? evidence.timestampPeriodNanoseconds : null,
    adapter: evidence.adapter ?? 'unknown',
    environment: evidence.environment ?? 'unknown',
    configFingerprint: input.configFingerprint ?? 'deferred-membership-timing-generation-4',
    seed: input.seed ?? 13,
    frameTarget: input.frameTarget ?? 300,
    frames: input.frames ?? 0,
    dimensions: input.dimensions ?? { width: 512, height: 512 },
    lights: input.lights,
    clusterGrid: input.clusterGrid ?? { x: 16, y: 9, z: 24 },
  };
  const common = {
    schemaVersion: 1,
    evidenceKind: input.evidenceKind ?? 'real',
    sourceHead: input.sourceHead,
    command: input.command ?? ['deferred-membership-evidence', identifier],
    process: {
      id: input.processId ?? `${identifier}-${process.pid}-${Date.now()}-${++payloadSerial}`,
      pid: process.pid,
      startedAt,
      finishedAt,
    },
    payloadIdentity,
    provenance,
    artifacts: { record: null, profile: profileArtifact, membership: membershipArtifact, pixel: pixelArtifact },
    profile,
    timing,
    outputHashes,
  };
  const record = input.recordKind === 'attempt'
    ? { ...common, recordKind: 'attempt', attemptId: input.attemptId, status, reason: reasonObject(reasonCodeValue, input.reasonDetail), actualProducer, gpu: gpuTiming, membership, references }
    : { ...common, recordKind: 'reference', referenceId: input.referenceId, parentAttemptId: input.parentAttemptId, referenceKind: input.referenceKind, terminal: { outcome, reason: reasonObject(reasonCodeValue, input.reasonDetail) }, actualProducer, gpu: null, membership, references: [] };
  const recordPayload = jsonBytes({
    schemaVersion: 1,
    recordKind: record.recordKind,
    identity: input.recordKind === 'attempt' ? { attemptId: input.attemptId } : { referenceId: input.referenceId, parentAttemptId: input.parentAttemptId },
    sourceHead: record.sourceHead,
    provenance: record.provenance,
    outputHashes: record.outputHashes,
    timing: record.timing,
  });
  common.artifacts.record = artifact(root, 'record.payload.json', recordPayload, artifactRoot);
  const recordBytes = jsonBytes(record);
  atomicWrite(join(root, 'record.json'), recordBytes);
  return {
    record,
    children: [],
    paths: {
      root,
      record: join(root, 'record.json'),
      profile: join(root, 'profile.json'),
      membership: join(root, 'membership.json'),
      pixel: join(root, 'frame.rgba'),
    },
  };
}
