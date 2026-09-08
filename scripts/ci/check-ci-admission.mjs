#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitPacket, compareMatchedPairs } from './check-full-run-terminal-slo.mjs';
import { normalizeRunPacket } from './normalize-run-packet.mjs';
import {
  classifyRequiredContextAdmission,
  projectRequiredContextRoster,
  REQUIRED_CHECK_NAMES,
} from './required-ci-checks.mjs';

const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const contractPath = resolve(scriptDirectory, 'full-run-terminal-slo-contract.json');
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const RECOVERY_ACTIONS = new Set(contract.recovery?.actions ?? []);
const FAILURE_LAYERS = new Set(contract.recovery?.failureLayers ?? []);
const FAILURE_LAYER_ORDER = new Map(
  [...(contract.recovery?.failureLayers ?? [])].map((layer, index) => [layer, index]),
);

function clone(value) {
  return value === undefined ? null : structuredClone(value);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstValue(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}

function recoveryEnvelope(details, failureLayer) {
  if (!details) return null;
  if (!FAILURE_LAYERS.has(failureLayer)) {
    throw new Error(`Unknown admission recovery failure layer: ${failureLayer}`);
  }
  return { ...details, failureLayer };
}

function orderedRecoveryActions(candidates) {
  const unique = new Map();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = [
      candidate.failureLayer,
      candidate.code,
      candidate.property,
      JSON.stringify(candidate.observed),
    ].join('\u0000');
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()].sort(
    (left, right) =>
      FAILURE_LAYER_ORDER.get(left.failureLayer) - FAILURE_LAYER_ORDER.get(right.failureLayer),
  );
}

const IDENTITY_FIELDS = Object.freeze({
  runId: ['runId', 'run_id', 'id', 'database_id'],
  runAttempt: ['runAttempt', 'run_attempt', 'attempt'],
  headSha: ['headSha', 'head_sha'],
  treatmentId: ['treatmentId', 'treatment_id'],
});

function identityComparable(field, value) {
  if (value === null || value === undefined || value === '') return null;
  if (field === 'runId' || field === 'runAttempt') {
    const number = Number(value);
    return Number.isFinite(number) ? number : String(value);
  }
  if (field === 'headSha') return String(value).toLowerCase();
  return String(value);
}

function sourceIdentity(source, sourceName) {
  const values = {};
  const object = record(source) ? source : {};
  for (const [field, aliases] of Object.entries(IDENTITY_FIELDS)) {
    values[field] = firstValue(...aliases.map((alias) => object[alias]));
  }
  return { sourceName, values };
}

function sourceIdentityValues(source, field) {
  const object = record(source) ? source : {};
  return IDENTITY_FIELDS[field]
    .map((alias) => object[alias])
    .filter((value) => value !== null && value !== undefined && value !== '');
}

function projectIdentity(input) {
  const supplied = record(input.identity) ? input.identity : {};
  const run = record(input.run) ? input.run : {};
  const suppliedSource = sourceIdentity(supplied, 'identity');
  const runSource = sourceIdentity(run, 'run');
  return {
    runId: firstValue(runSource.values.runId, suppliedSource.values.runId),
    runAttempt: firstValue(runSource.values.runAttempt, suppliedSource.values.runAttempt),
    headSha: firstValue(runSource.values.headSha, suppliedSource.values.headSha),
    treatmentId: firstValue(runSource.values.treatmentId, suppliedSource.values.treatmentId),
  };
}

function identityMismatch(input) {
  const suppliedSource = record(input.identity) ? input.identity : {};
  const runSource = record(input.run) ? input.run : {};
  const supplied = sourceIdentity(suppliedSource, 'identity').values;
  const run = sourceIdentity(runSource, 'run').values;
  for (const field of Object.keys(IDENTITY_FIELDS)) {
    const runValues = sourceIdentityValues(runSource, field);
    const suppliedValues = sourceIdentityValues(suppliedSource, field);
    const sourceValues = [...runValues, ...suppliedValues].map((value) =>
      identityComparable(field, value),
    );
    const distinctSourceValues = [...new Set(sourceValues.filter((value) => value !== null))];
    if (distinctSourceValues.length > 1) {
      return {
        code: `identity-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-mismatch`,
        property: `identity.${field}`,
        expected: run[field] ?? supplied[field],
        observed: distinctSourceValues[1],
        detail: `Identity aliases disagree for ${field}`,
        action: 'recollect-evidence',
      };
    }
    const suppliedValue = identityComparable(field, supplied[field]);
    const runValue = identityComparable(field, run[field]);
    if (suppliedValue !== null && runValue !== null && suppliedValue !== runValue) {
      return {
        code: `identity-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-mismatch`,
        property: `identity.${field}`,
        expected: run[field],
        observed: supplied[field],
        detail: `Supplied ${field} does not match the run source`,
        action: 'recollect-evidence',
      };
    }
  }
  return null;
}

function proofMatchesIdentity(proof, identity) {
  return (
    record(proof) &&
    proof.workflow === 'ci.yml' &&
    proof.excluded === true &&
    typeof proof.headSha === 'string' &&
    typeof identity.headSha === 'string' &&
    proof.headSha.toLowerCase() === identity.headSha.toLowerCase()
  );
}

function validateAdmissionIdentity(identity) {
  if (!record(identity)) {
    return {
      code: 'identity-missing',
      property: 'identity',
      expected: 'runId, positive runAttempt, full headSha, treatmentId',
      observed: identity ?? null,
      detail: 'Admission identity tuple is required before completion',
      action: 'recollect-evidence',
    };
  }
  if (identity.runId === null || identity.runId === undefined || identity.runId === '') {
    return {
      code: 'identity-run-id-missing',
      property: 'identity.runId',
      expected: 'runId',
      observed: identity.runId ?? null,
      detail: 'Run identity is required before completion',
      action: 'recollect-evidence',
    };
  }
  if (!Number.isInteger(Number(identity.runAttempt)) || Number(identity.runAttempt) < 1) {
    return {
      code: 'identity-attempt-invalid',
      property: 'identity.runAttempt',
      expected: 'positive integer',
      observed: identity.runAttempt ?? null,
      detail: 'Run attempt must be positive before completion',
      action: 'recollect-evidence',
    };
  }
  if (typeof identity.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(identity.headSha)) {
    return {
      code: 'identity-head-invalid',
      property: 'identity.headSha',
      expected: 'full 40-character SHA',
      observed: identity.headSha ?? null,
      detail: 'Full source head identity is required before completion',
      action: 'recollect-evidence',
    };
  }
  if (typeof identity.treatmentId !== 'string' || identity.treatmentId.trim() === '') {
    return {
      code: 'identity-treatment-missing',
      property: 'identity.treatmentId',
      expected: 'treatmentId',
      observed: identity.treatmentId ?? null,
      detail: 'Treatment identity is required before completion',
      action: 'recollect-evidence',
    };
  }
  return null;
}

function validatePathFilterIdentity(identity) {
  if (!record(identity)) {
    return {
      code: 'identity-missing',
      property: 'identity',
      expected: 'full headSha',
      observed: identity ?? null,
      detail: 'Path-filter proof identity requires the pull request head SHA',
      action: 'recollect-evidence',
    };
  }
  if (typeof identity.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(identity.headSha)) {
    return {
      code: 'identity-head-invalid',
      property: 'identity.headSha',
      expected: 'full 40-character SHA',
      observed: identity.headSha ?? null,
      detail: 'Full source head identity is required for path-filter proof',
      action: 'recollect-evidence',
    };
  }
  return null;
}

function recoveryFor(status, decision, roster) {
  const reason = decision.reasonCodes?.[0] ?? status;
  const defaults = {
    'path-filtered': {
      code: 'path-filter-proof-missing',
      property: 'pathFilterProof',
      expected: 'identity-bound ci.yml exclusion proof',
      action: 'recollect-evidence',
    },
    'ordinary-push-main': {
      code: 'ordinary-push-not-pr',
      property: 'run.event',
      expected: 'pull_request',
      action: 'recollect-evidence',
    },
    'normal-ci-run': {
      code: 'run-not-terminal',
      property: 'run.status',
      expected: 'completed with complete required roster',
      action: 'wait-for-terminality',
    },
    'operational-skip': {
      code: 'required-context-skipped',
      property: 'roster.observed',
      expected: 'terminal non-skipped required contexts',
      action: 'restore-roster-classification',
    },
    'zero-job': {
      code: 'zero-job',
      property: 'evidence.jobs',
      expected: 'at least one required context job',
      action: 'recollect-evidence',
    },
    'api-error': {
      code: 'api-error',
      property: 'evidence',
      expected: 'readable run and job evidence',
      action: 'recollect-evidence',
    },
    'partial-roster': {
      code: 'partial-roster',
      property: 'roster',
      expected: REQUIRED_CHECK_NAMES,
      action: 'restore-roster-classification',
    },
    'genuine-failure': {
      code: 'genuine-failure',
      property: 'roster.failedContexts',
      expected: 'all required contexts successful',
      action: 'recollect-evidence',
    },
  };
  const fallback = defaults[status] ?? defaults['api-error'];
  const details = {
    ...fallback,
    observed:
      status === 'partial-roster'
        ? {
            missing: roster.missing,
            duplicate: roster.duplicate,
            extra: roster.extra,
            malformed: roster.malformed,
          }
        : (decision.reasonCodes ?? roster.observed),
    detail: `Admission is not complete: ${reason}`,
  };
  if (!RECOVERY_ACTIONS.has(details.action)) {
    details.action = 'recollect-evidence';
  }
  return recoveryEnvelope(details, 'source');
}

function rosterProjection(jobs, decision) {
  const projected = projectRequiredContextRoster(jobs);
  return {
    authority: {
      path: 'scripts/ci/required-ci-checks.json',
      statusAuthority: 'scripts/ci/required-ci-checks.mjs#REQUIRED_CONTEXT_ADMISSION_STATUSES',
    },
    expected: [...REQUIRED_CHECK_NAMES],
    observed: decision.observedContexts ?? projected.observed,
    missing: decision.missingContexts ?? projected.missing,
    duplicate: decision.duplicateContexts ?? projected.duplicate,
    extra: projected.extra,
    malformed: decision.malformedJobs ?? [],
    skipped: decision.skippedContexts ?? [],
    failed: decision.failedContexts ?? [],
  };
}

/**
 * Evaluate local CI evidence without querying GitHub or mutating checks.
 *
 * The optional `packet` is one terminal evidence packet. The optional `pairs`
 * array contains `{ baseline, treatment }` packet pairs and is evaluated only
 * by the deterministic matched-pair comparator. Results retain the comparator
 * verdict/classification and its evidence-only recovery action; this module
 * never executes recovery. The admission `status` union remains owned by
 * `required-ci-checks.mjs`.
 *
 * @param {{identity?:object,run?:object|null,jobs?:Array<object>|null,packet?:object|null,pairs?:Array<object>|null,pathFiltered?:boolean,pathFilterProof?:object,apiError?:unknown}} input
 * @returns {{status:string,fallbackEligible:boolean,identity:object,roster:object,evidence:object,recoveryAction:object|null,recoveryActions:Array<object>}}
 */
export function projectCiAdmission(input = {}) {
  const source = record(input) ? input : {};
  const identity = projectIdentity(source);
  const decision = classifyRequiredContextAdmission({
    run: source.run ?? null,
    jobs: source.jobs ?? null,
    pathFiltered:
      source.pathFiltered === true && proofMatchesIdentity(source.pathFilterProof, identity),
    apiError: source.apiError ?? null,
  });
  const roster = rosterProjection(source.jobs, decision);
  const noRunPathFilter =
    decision.status === 'path-filtered' &&
    source.run == null &&
    source.jobs == null &&
    source.packet == null;
  const pathProof = proofMatchesIdentity(source.pathFilterProof, identity);
  const identityError = recoveryEnvelope(
    identityMismatch(source) ??
      (noRunPathFilter
        ? validatePathFilterIdentity(identity)
        : validateAdmissionIdentity(identity)),
    'source',
  );
  const packetNormalization = isPacketInput(source.packet)
    ? normalizeRunPacket(source.packet, {
        runId: identity.runId,
        runAttempt: identity.runAttempt,
        headSha: identity.headSha,
        treatmentId: identity.treatmentId,
        inputFingerprint: firstValue(
          source.packet?.inputFingerprint,
          source.packet?.input_fingerprint,
          source.packet?.run?.inputFingerprint,
          source.packet?.run?.input_fingerprint,
        ),
        declaredRoster: REQUIRED_CHECK_NAMES,
      })
    : null;
  const verifierPacket = isVerifierPacket(source.packet);
  const packetProjection = verifierPacket ? admitPacket(source.packet) : null;
  const comparisonRequested = Array.isArray(source.pairs);
  const comparison = comparisonRequested
    ? compareMatchedPairs(Array.isArray(source.pairs) ? source.pairs : [])
    : null;
  const packetIdentityError = recoveryEnvelope(
    verifierPacket && packetProjection
      ? identityMismatch({ identity, run: packetProjection.identity })
      : null,
    'source',
  );
  const packetError =
    packetIdentityError ??
    (packetNormalization && !verifierPacket && !packetNormalization.admissible
      ? recoveryFromNormalization(packetNormalization)
      : packetProjection && !['admissible', 'slo-breach'].includes(packetProjection.classification)
        ? packetProjection.recoveryAction
        : null);
  const fallbackEligible =
    decision.status === 'path-filtered' && pathProof && !identityError && !packetError;
  const complete =
    decision.status === 'normal-ci-run' &&
    decision.complete === true &&
    !identityError &&
    !packetError;
  const status = decision.status;
  const comparisonRecovery = comparison?.recoveryAction ?? null;
  const terminalNormalRun = status === 'normal-ci-run' && decision.complete === true;
  const topologyRecovery =
    terminalNormalRun || (status === 'path-filtered' && pathProof)
      ? null
      : recoveryFor(status, decision, roster);
  const recoveryActions = orderedRecoveryActions([
    identityError,
    topologyRecovery,
    packetError,
    comparisonRecovery,
  ]);
  const recovery = recoveryActions[0] ?? null;
  return {
    status,
    fallbackEligible,
    identity: clone(identity),
    roster,
    evidence: {
      run: clone(source.run ?? null),
      jobs: clone(source.jobs ?? null),
      pathFilterProof: clone(source.pathFilterProof ?? null),
      reasonCodes: [...(decision.reasonCodes ?? [])],
      terminal: decision.terminal === true,
      complete,
      packet: packetProjection,
      packetNormalization,
      comparison,
    },
    recoveryAction: recovery,
    recoveryActions,
  };
}

function isPacketInput(value) {
  return record(value) && Object.keys(value).length > 0;
}

function isVerifierPacket(value) {
  return (
    isPacketInput(value) &&
    value.schemaVersion === contract.schemaVersion &&
    record(value.identity) &&
    record(value.terminal)
  );
}

function recoveryFromNormalization(normalized) {
  const reason = normalized?.reasons?.[0] ?? {};
  return recoveryEnvelope(
    {
      code: normalized?.code ?? 'packet-invalid',
      property: `packet.${reason.scope ?? 'evidence'}`,
      expected: 'normalizer-admissible packet evidence',
      observed: normalized?.reasonCodes ?? [],
      detail: 'Packet normalization rejected the supplied evidence before verification',
      action: 'recollect-evidence',
    },
    'delivery',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.stdin.isTTY ? {} : JSON.parse(await new Response(process.stdin).text());
  console.log(JSON.stringify(projectCiAdmission(input), null, 2));
}
