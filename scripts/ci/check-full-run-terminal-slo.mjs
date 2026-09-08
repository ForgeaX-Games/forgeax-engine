#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultContractPath = resolve(scriptDirectory, 'full-run-terminal-slo-contract.json');
const defaultRosterPath = resolve(scriptDirectory, 'required-ci-checks.json');
const authorizedRetryClasses = new Set([
  'authorized-test-retry',
  'authorized-transport-retry',
  'authorized-browser-transport-retry',
  'authorized-artifact-upload-retry',
  'authorized-artifact-download-retry',
  'authorized-webkit-crash-retry',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const defaultFailureLayers = readJson(defaultContractPath).recovery?.failureLayers;

function configuredFailureLayers(contract = null) {
  const layers = contract?.recovery?.failureLayers ?? defaultFailureLayers;
  if (!Array.isArray(layers) || layers.some((layer) => typeof layer !== 'string')) {
    throw new Error('Terminal SLO contract must declare recovery.failureLayers');
  }
  return new Set(layers);
}

function fingerprint(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function recoveryAction(
  { code, property, expected, observed = null, detail, action },
  failureLayer,
  contract = null,
) {
  if (!configuredFailureLayers(contract).has(failureLayer)) {
    throw new Error(`Unknown terminal SLO recovery failure layer: ${failureLayer}`);
  }
  return { code, failureLayer, property, expected, observed, detail, action };
}

function result(classification, packet, recovery = null) {
  return {
    classification,
    identity: packet?.identity ?? null,
    classifications: packet?.classifications ?? null,
    rosterAuthority: packet?.rosterAuthority ?? null,
    recoveryAction: recovery,
  };
}

function invalid(packet, details) {
  return result('invalid-evidence', packet, recoveryAction(details, 'source'));
}

function unknown(packet, details) {
  return result('unknown-evidence', packet, recoveryAction(details, 'source'));
}

function loadContract(contractPath = defaultContractPath) {
  const contract = readJson(contractPath);
  if (!isRecord(contract) || contract.schemaVersion !== 1) {
    throw new Error(`Unsupported terminal SLO contract at ${contractPath}`);
  }
  return contract;
}

function loadRoster(rosterPath = defaultRosterPath) {
  const roster = readJson(rosterPath);
  if (
    !Array.isArray(roster) ||
    roster.some((name) => typeof name !== 'string' || name.length === 0)
  ) {
    throw new Error(`Invalid required CI roster at ${rosterPath}`);
  }
  if (new Set(roster).size !== roster.length) {
    throw new Error(`Duplicate required CI context in ${rosterPath}`);
  }
  return { names: roster, path: rosterPath, fingerprint: fingerprint(rosterPath) };
}

function identityKey(identity) {
  return [identity?.runId, identity?.runAttempt, identity?.headSha, identity?.treatmentId].join(
    '|',
  );
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function validateIdentity(packet) {
  const identity = packet?.identity;
  if (!isRecord(identity)) {
    return {
      code: 'identity-missing',
      property: 'identity',
      expected: 'runId, runAttempt, headSha, treatmentId',
      detail: 'Packet identity tuple is absent',
      action: 'recollect-evidence',
    };
  }
  for (const field of ['runId', 'runAttempt', 'headSha', 'treatmentId']) {
    if (!hasValue(identity[field])) {
      return {
        code: 'identity-field-missing',
        property: `identity.${field}`,
        expected: field,
        detail: `Identity field ${field} is required`,
        action: 'recollect-evidence',
      };
    }
  }
  if (!Number.isInteger(Number(identity.runAttempt)) || Number(identity.runAttempt) < 1) {
    return {
      code: 'identity-attempt-invalid',
      property: 'identity.runAttempt',
      expected: 'positive integer',
      observed: identity.runAttempt,
      detail: 'Run attempt must be positive',
      action: 'recollect-evidence',
    };
  }
  if (typeof identity.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(identity.headSha)) {
    return {
      code: 'identity-head-invalid',
      property: 'identity.headSha',
      expected: 'full 40-character SHA',
      observed: identity.headSha,
      detail: 'Full source head identity is required',
      action: 'recollect-evidence',
    };
  }
  return null;
}

function validateSource(packet) {
  const source = packet?.source;
  if (!isRecord(source) || !hasValue(source.producerId) || !hasValue(source.fingerprint)) {
    return {
      code: 'provenance-missing',
      property: 'source',
      expected: 'producerId and fingerprint',
      detail: 'Producer provenance is required',
      action: 'recollect-evidence',
    };
  }
  if (hasValue(source.runId) && String(source.runId) !== String(packet.identity.runId)) {
    return {
      code: 'foreign-run',
      property: 'source.runId',
      expected: packet.identity.runId,
      observed: source.runId,
      detail: 'Source evidence belongs to another run',
      action: 'discard-foreign-evidence',
    };
  }
  if (
    hasValue(source.runAttempt) &&
    Number(source.runAttempt) !== Number(packet.identity.runAttempt)
  ) {
    return {
      code: 'foreign-attempt',
      property: 'source.runAttempt',
      expected: packet.identity.runAttempt,
      observed: source.runAttempt,
      detail: 'Source evidence belongs to another attempt',
      action: 'discard-foreign-evidence',
    };
  }
  if (hasValue(source.headSha) && source.headSha !== packet.identity.headSha) {
    return {
      code: 'foreign-head',
      property: 'source.headSha',
      expected: packet.identity.headSha,
      observed: source.headSha,
      detail: 'Source evidence belongs to another head',
      action: 'discard-foreign-evidence',
    };
  }
  return null;
}

function validateDuplicateEvidence(packet) {
  if (!Array.isArray(packet?.evidence)) return null;
  const seen = new Set();
  for (const row of packet.evidence) {
    if (!isRecord(row)) {
      return {
        code: 'evidence-invalid',
        property: 'evidence',
        expected: 'identity-bearing evidence rows',
        observed: row,
        detail: 'Evidence rows must be objects',
        action: 'recollect-evidence',
      };
    }
    const key = identityKey(row);
    if (seen.has(key)) {
      return {
        code: 'duplicate-identity',
        property: 'identity',
        expected: 'one evidence row per identity tuple',
        observed: row,
        detail: 'Duplicate run, attempt, head, and treatment evidence was supplied',
        action: 'discard-foreign-evidence',
      };
    }
    seen.add(key);
  }
  return null;
}

function validateRoster(packet, roster, contract) {
  const authority = packet?.rosterAuthority;
  if (!isRecord(authority)) {
    return {
      kind: 'unknown',
      details: {
        code: 'roster-authority-missing',
        property: 'rosterAuthority',
        expected: {
          path: contract.rosterAuthority.path,
          fingerprint: roster.fingerprint,
        },
        observed: authority ?? null,
        detail: 'Packet must identify the loaded authoritative roster',
        action: 'recollect-evidence',
      },
    };
  }
  if (authority.path !== contract.rosterAuthority.path) {
    return {
      kind: 'invalid',
      details: {
        code: 'roster-authority-foreign',
        property: 'rosterAuthority.path',
        expected: contract.rosterAuthority.path,
        observed: authority.path ?? null,
        detail: 'Packet roster authority is not the declared source',
        action: 'discard-foreign-evidence',
      },
    };
  }
  if (!hasValue(authority.fingerprint)) {
    return {
      kind: 'unknown',
      details: {
        code: 'roster-authority-fingerprint-missing',
        property: 'rosterAuthority.fingerprint',
        expected: roster.fingerprint,
        observed: null,
        detail: 'Packet roster authority fingerprint is required',
        action: 'recollect-evidence',
      },
    };
  }
  if (authority.fingerprint !== roster.fingerprint) {
    return {
      kind: 'invalid',
      details: {
        code: 'roster-authority-stale',
        property: 'rosterAuthority.fingerprint',
        expected: roster.fingerprint,
        observed: authority.fingerprint,
        detail: 'Packet roster authority fingerprint is stale or foreign',
        action: 'discard-foreign-evidence',
      },
    };
  }
  const observed = packet?.classifications;
  if (!isRecord(observed)) {
    return {
      kind: 'unknown',
      details: {
        code: 'roster-missing',
        property: 'classifications',
        expected: roster.names,
        detail: 'Every authoritative context needs a classification',
        action: 'restore-roster-classification',
      },
    };
  }
  const expectedNames = new Set(roster.names);
  const observedNames = Object.keys(observed);
  const extras = observedNames.filter((name) => !expectedNames.has(name));
  if (extras.length > 0) {
    return {
      kind: 'invalid',
      details: {
        code: 'roster-extra-context',
        property: 'classifications',
        expected: roster.names,
        observed: extras,
        detail: 'Evidence contains a context outside the authoritative roster',
        action: 'discard-foreign-evidence',
      },
    };
  }
  const missing = roster.names.filter((name) => !isRecord(observed[name]));
  if (missing.length > 0) {
    return {
      kind: 'unknown',
      details: {
        code: 'roster-missing-context',
        property: `classifications.${missing[0]}`,
        expected: 'one classification object',
        observed: observed[missing[0]] ?? null,
        detail: 'A required context has no classification',
        action: 'restore-roster-classification',
      },
    };
  }
  const allowed = new Set(contract.classifications);
  for (const name of roster.names) {
    const entry = observed[name];
    if (!allowed.has(entry.classification)) {
      return {
        kind: 'invalid',
        details: {
          code: 'classification-unknown',
          property: `classifications.${name}.classification`,
          expected: contract.classifications,
          observed: entry.classification,
          detail: 'Classification is outside the closed contract vocabulary',
          action: 'restore-roster-classification',
        },
      };
    }
    if (entry.classification === 'intentional-skip') {
      for (const field of ['predicate', 'reason', 'semanticCoverageFingerprint']) {
        if (!hasValue(entry[field])) {
          return {
            kind: 'invalid',
            details: {
              code: 'intentional-skip-incomplete',
              property: `classifications.${name}.${field}`,
              expected: field,
              observed: entry[field] ?? null,
              detail:
                'Intentional skips require predicate, reason, and semantic coverage fingerprint',
              action: 'restore-roster-classification',
            },
          };
        }
      }
    }
    if (['missing', 'nonterminal'].includes(entry.classification)) {
      return {
        kind: 'unknown',
        details: {
          code: `context-${entry.classification}`,
          property: `classifications.${name}.classification`,
          expected: 'terminal classification',
          observed: entry.classification,
          detail: 'Context is not terminal evidence',
          action: 'wait-for-terminality',
        },
      };
    }
  }
  return null;
}

function parseTimestamp(value) {
  if (!hasValue(value)) return null;
  const milliseconds = Date.parse(String(value));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function timingSourceBinding(
  owner,
  packet,
  property,
  missingCode,
  foreignPrefix,
  requireTreatment = false,
) {
  const source = owner?.source;
  if (!isRecord(source)) {
    return {
      kind: 'unknown',
      details: {
        code: missingCode,
        property: `${property}.source`,
        expected: 'source.runId, source.runAttempt, and source.headSha',
        observed: source ?? null,
        detail: 'Timing boundaries require explicit source/run/attempt binding',
        action: 'recollect-evidence',
      },
    };
  }
  for (const field of ['runId', 'runAttempt', 'headSha']) {
    if (!hasValue(source[field])) {
      return {
        kind: 'unknown',
        details: {
          code: `${missingCode}-${field}`,
          property: `${property}.source.${field}`,
          expected: field,
          observed: source[field] ?? null,
          detail: 'Timing source binding is incomplete',
          action: 'recollect-evidence',
        },
      };
    }
  }
  if (requireTreatment && !hasValue(source.treatmentId)) {
    return {
      kind: 'unknown',
      details: {
        code: `${missingCode}-treatmentId`,
        property: `${property}.source.treatmentId`,
        expected: 'treatmentId',
        observed: null,
        detail: 'Timing source treatment binding is incomplete',
        action: 'recollect-evidence',
      },
    };
  }
  if (hasValue(source.treatmentId)) {
    const expectedTreatment = packet.identity.treatmentId;
    if (!hasValue(expectedTreatment)) {
      return {
        kind: 'unknown',
        details: {
          code: `${missingCode}-treatmentId`,
          property: `${property}.source.treatmentId`,
          expected: 'treatmentId',
          observed: source.treatmentId,
          detail: 'Timing source treatment binding requires packet treatment identity',
          action: 'recollect-evidence',
        },
      };
    }
    if (String(source.treatmentId) !== String(expectedTreatment)) {
      return {
        kind: 'invalid',
        details: {
          code: `${foreignPrefix}-treatment`,
          property: `${property}.source.treatmentId`,
          expected: expectedTreatment,
          observed: source.treatmentId,
          detail: 'Timing source belongs to another treatment identity',
          action: 'discard-foreign-evidence',
        },
      };
    }
  }
  for (const field of ['runId', 'runAttempt', 'headSha']) {
    const expected = packet.identity[field];
    const matches =
      field === 'runAttempt'
        ? Number(source[field]) === Number(expected)
        : String(source[field]) === String(expected);
    if (!matches) {
      return {
        kind: 'invalid',
        details: {
          code: `${foreignPrefix}-${field}`,
          property: `${property}.source.${field}`,
          expected,
          observed: source[field],
          detail: 'Timing source belongs to another packet identity',
          action: 'discard-foreign-evidence',
        },
      };
    }
  }
  return { kind: 'valid', source };
}

function timingResult(packet, classification, timing = null, recovery = null) {
  return {
    classification,
    identity: packet?.identity ?? null,
    timing,
    recoveryAction: recovery,
  };
}

function timingInvalid(packet, details) {
  return timingResult(packet, 'invalid-evidence', null, recoveryAction(details, 'terminal'));
}

function timingUnknown(packet, details) {
  return timingResult(packet, 'unknown-evidence', null, recoveryAction(details, 'terminal'));
}

function timingSeconds(milliseconds) {
  return Number((milliseconds / 1000).toFixed(6));
}

function terminalClock(packet, options = {}) {
  const terminal = packet?.terminal;
  if (!isRecord(terminal)) {
    return {
      kind: 'unknown',
      details: {
        code: 'terminal-clock-missing',
        property: 'terminal',
        expected: 'createdAt and terminalAt from the same run and attempt',
        observed: terminal ?? null,
        detail: 'Terminal wall evidence is incomplete',
        action: 'recollect-evidence',
      },
    };
  }
  const observedTerminalState = terminalConclusion(terminal);
  if (
    hasValue(observedTerminalState) &&
    !['completed', 'success', 'failure', 'cancelled', 'superseded'].includes(observedTerminalState)
  ) {
    return {
      kind: 'unknown',
      details: {
        code: 'terminal-state-nonterminal',
        property: 'terminal.state',
        expected: ['completed', 'success', 'failure'],
        observed: observedTerminalState,
        detail: 'Run terminal state is absent or nonterminal',
        action: 'wait-for-terminality',
      },
    };
  }
  if (!hasValue(terminal.createdAt) || !hasValue(terminal.terminalAt)) {
    if (!hasValue(terminal.terminalAt) && hasValue(terminal.updatedAt)) {
      return {
        kind: 'unknown',
        details: {
          code: 'terminal-clock-fallback',
          property: 'terminal.updatedAt',
          expected: 'source-provenanced createdAt and terminalAt',
          observed: terminal.updatedAt,
          detail: 'Diagnostic updatedAt cannot become the terminal SLO clock',
          action: 'recollect-evidence',
        },
      };
    }
    return {
      kind: 'unknown',
      details: {
        code: 'terminal-clock-missing',
        property: 'terminal',
        expected: 'createdAt and terminalAt from the same run and attempt',
        observed: terminal,
        detail: 'Terminal wall evidence is incomplete',
        action: 'recollect-evidence',
      },
    };
  }
  const createdMilliseconds = parseTimestamp(terminal.createdAt);
  const terminalMilliseconds = parseTimestamp(terminal.terminalAt);
  if (createdMilliseconds === null || terminalMilliseconds === null) {
    return {
      kind: 'invalid',
      details: {
        code: 'terminal-clock-invalid',
        property: 'terminal.createdAt',
        expected: 'parseable source timestamps',
        observed: { createdAt: terminal.createdAt, terminalAt: terminal.terminalAt },
        detail: 'Terminal clock values are not parseable',
        action: 'recollect-evidence',
      },
    };
  }
  for (const field of ['runId', 'runAttempt', 'treatmentId']) {
    if (hasValue(terminal[field])) {
      const matches =
        field === 'runAttempt'
          ? Number(terminal[field]) === Number(packet.identity[field])
          : String(terminal[field]) === String(packet.identity[field]);
      if (!matches) {
        return {
          kind: 'invalid',
          details: {
            code: `terminal-clock-foreign-${field === 'runId' ? 'run' : field === 'runAttempt' ? 'attempt' : 'treatment'}`,
            property: `terminal.${field}`,
            expected: packet.identity[field],
            observed: terminal[field],
            detail: 'Terminal clock belongs to another run identity',
            action: 'discard-foreign-evidence',
          },
        };
      }
    }
  }
  const binding = timingSourceBinding(
    terminal,
    packet,
    'terminal',
    'terminal-clock-source-missing',
    'terminal-clock-foreign',
    options.requireTreatment === true,
  );
  if (binding.kind !== 'valid') return binding;
  if (terminalMilliseconds < createdMilliseconds) {
    return {
      kind: 'invalid',
      details: {
        code: 'terminal-clock-reversed',
        property: 'terminal.terminalAt',
        expected: `at or after ${terminal.createdAt}`,
        observed: terminal.terminalAt,
        detail: 'Terminal boundary precedes run creation',
        action: 'recollect-evidence',
      },
    };
  }
  const terminalState = terminalConclusion(terminal);
  if (!['completed', 'success', 'failure', 'cancelled', 'superseded'].includes(terminalState)) {
    return {
      kind: 'unknown',
      details: {
        code: 'terminal-state-nonterminal',
        property: 'terminal.state',
        expected: ['completed', 'success', 'failure'],
        observed: terminalState ?? null,
        detail: 'Run terminal state is absent or nonterminal',
        action: 'wait-for-terminality',
      },
    };
  }
  return { kind: 'valid', createdMilliseconds, terminalMilliseconds, terminal };
}

function jobClock(job, packet, options = {}) {
  if (hasValue(job.runId) && String(job.runId) !== String(packet.identity.runId)) {
    return {
      kind: 'invalid',
      details: {
        code: 'job-clock-foreign-run',
        property: `jobs.${job.name}.runId`,
        expected: packet.identity.runId,
        observed: job.runId,
        detail: 'Job timing belongs to another run',
        action: 'discard-foreign-evidence',
      },
    };
  }
  if (hasValue(job.runAttempt) && Number(job.runAttempt) !== Number(packet.identity.runAttempt)) {
    return {
      kind: 'invalid',
      details: {
        code: 'job-clock-foreign-attempt',
        property: `jobs.${job.name}.runAttempt`,
        expected: packet.identity.runAttempt,
        observed: job.runAttempt,
        detail: 'Job timing belongs to another run attempt',
        action: 'discard-foreign-evidence',
      },
    };
  }
  if (
    hasValue(job.treatmentId) &&
    String(job.treatmentId) !== String(packet.identity.treatmentId)
  ) {
    return {
      kind: 'invalid',
      details: {
        code: 'job-clock-foreign-treatment',
        property: `jobs.${job.name}.treatmentId`,
        expected: packet.identity.treatmentId,
        observed: job.treatmentId,
        detail: 'Job timing belongs to another treatment identity',
        action: 'discard-foreign-evidence',
      },
    };
  }
  const binding = timingSourceBinding(
    job,
    packet,
    `jobs.${job.name}`,
    'job-clock-source-missing',
    'job-clock-foreign',
    options.requireTreatment === true,
  );
  if (binding.kind !== 'valid') return binding;
  const created = parseTimestamp(job.createdAt);
  const started = parseTimestamp(job.startedAt);
  const completed = parseTimestamp(job.completedAt);
  if ([created, started, completed].some((value) => value === null)) {
    return {
      kind: 'unknown',
      details: {
        code: 'job-clock-missing',
        property: `jobs.${job.name}`,
        expected: 'createdAt, startedAt, and completedAt',
        observed: job,
        detail: 'Executed job timing is incomplete',
        action: 'recollect-evidence',
      },
    };
  }
  if (started < created || completed < started) {
    return {
      kind: 'invalid',
      details: {
        code: 'job-clock-reversed',
        property: `jobs.${job.name}`,
        expected: 'createdAt <= startedAt <= completedAt',
        observed: {
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
        },
        detail: 'Job timing boundaries are reversed',
        action: 'recollect-evidence',
      },
    };
  }
  const timing = {
    queueSeconds: timingSeconds(started - created),
    activeSeconds: timingSeconds(completed - started),
    totalSeconds: timingSeconds(completed - created),
  };
  for (const field of Object.keys(timing)) {
    if (hasValue(job[field]) && Math.abs(Number(job[field]) - timing[field]) > 1e-6) {
      return {
        kind: 'invalid',
        details: {
          code: 'job-clock-arithmetic',
          property: `jobs.${job.name}.${field}`,
          expected: timing[field],
          observed: job[field],
          detail: 'Provided job timing disagrees with source boundaries',
          action: 'recollect-evidence',
        },
      };
    }
  }
  return { kind: 'valid', timing, completedMilliseconds: completed, job };
}

function projectTerminalTiming(packet, options = {}) {
  const contract = options.contract ?? loadContract(options.contractPath);
  const clock = terminalClock(packet, {
    requireTreatment: options.requireTreatmentSource === true,
  });
  if (clock.kind === 'unknown') return timingUnknown(packet, clock.details);
  if (clock.kind === 'invalid') return timingInvalid(packet, clock.details);
  const terminalWallSeconds = timingSeconds(clock.terminalMilliseconds - clock.createdMilliseconds);
  const timingJobs = Array.isArray(packet?.jobs) ? packet.jobs : [];
  const rosterOrder = options.roster?.names ?? loadRoster().names;
  const classifications = packet?.classifications ?? {};
  const rows = [];
  for (const name of rosterOrder) {
    const entry = classifications[name];
    if (!entry || entry.classification === 'intentional-skip') continue;
    const job = timingJobs.find((candidate) => candidate?.name === name);
    if (!job) {
      return timingUnknown(packet, {
        code: 'job-clock-missing',
        property: `jobs.${name}`,
        expected: 'timing for every executed context',
        observed: null,
        detail: 'Executed roster context has no timing row',
        action: 'recollect-evidence',
      });
    }
    const parsed = jobClock(job, packet, {
      requireTreatment: options.requireTreatmentSource === true,
    });
    if (parsed.kind === 'unknown') return timingUnknown(packet, parsed.details);
    if (parsed.kind === 'invalid') return timingInvalid(packet, parsed.details);
    rows.push(parsed);
  }
  if (rows.length === 0) {
    return timingUnknown(packet, {
      code: 'critical-path-missing',
      property: 'timing.requiredCriticalPathCompletedAt',
      expected: 'at least one executed required context',
      observed: null,
      detail: 'No required terminal work exists for critical-path attribution',
      action: 'restore-roster-classification',
    });
  }
  const queueSeconds = Number(
    rows.reduce((sum, row) => sum + row.timing.queueSeconds, 0).toFixed(6),
  );
  const activeSeconds = Number(
    rows.reduce((sum, row) => sum + row.timing.activeSeconds, 0).toFixed(6),
  );
  const totalSeconds = Number(
    rows.reduce((sum, row) => sum + row.timing.totalSeconds, 0).toFixed(6),
  );
  if (Math.abs(queueSeconds + activeSeconds - totalSeconds) > 1e-6) {
    return timingInvalid(packet, {
      code: 'job-clock-arithmetic',
      property: 'timing.totalSeconds',
      expected: queueSeconds + activeSeconds,
      observed: totalSeconds,
      detail: 'Queue plus active timing must equal total timing',
      action: 'recollect-evidence',
    });
  }
  const criticalMilliseconds = Math.max(...rows.map((row) => row.completedMilliseconds));
  const criticalOwners = rows
    .filter((row) => row.completedMilliseconds === criticalMilliseconds)
    .map((row) => row.job.name)
    .sort((left, right) => rosterOrder.indexOf(left) - rosterOrder.indexOf(right));
  const tailSeconds = timingSeconds(clock.terminalMilliseconds - criticalMilliseconds);
  if (tailSeconds < 0) {
    return timingInvalid(packet, {
      code: 'critical-boundary-after-terminal',
      property: 'timing.requiredCriticalPathCompletedAt',
      expected: 'at or before terminalAt',
      observed: criticalMilliseconds,
      detail: 'Required critical completion exceeds terminal boundary',
      action: 'recollect-evidence',
    });
  }
  return timingResult(
    packet,
    terminalWallSeconds > contract.terminalWall.maxSeconds ? 'slo-breach' : 'admissible',
    {
      terminalWallSeconds,
      diagnosticUpdatedAt: packet.terminal.updatedAt ?? null,
      queueSeconds,
      preStartSeconds: queueSeconds,
      activeSeconds,
      totalSeconds,
      jobCount: rows.length,
      requiredCriticalOwners: criticalOwners,
      requiredCriticalPathCompletedAt: new Date(criticalMilliseconds).toISOString(),
      postCriticalReportingTailSeconds: tailSeconds,
    },
    terminalWallSeconds > contract.terminalWall.maxSeconds
      ? recoveryAction(
          {
            code: 'terminal-wall-exceeded',
            property: 'timing.terminalWallSeconds',
            expected: contract.terminalWall.maxSeconds,
            observed: terminalWallSeconds,
            detail: 'Creation-to-terminal wall exceeds the SLO threshold',
            action: 'recollect-evidence',
          },
          'terminal',
        )
      : null,
  );
}

function evidenceSources(packet) {
  const provenance = isRecord(packet?.provenance) ? packet.provenance : {};
  return {
    producer: provenance.producer ?? packet?.producer ?? packet?.source ?? null,
    artifact: provenance.artifact ?? packet?.artifact ?? null,
    report:
      provenance.report ??
      packet?.report ??
      packet?.consumedReport ??
      packet?.consumed?.report ??
      null,
  };
}

function validateEvidenceIdentity(row, packet, property, identityField) {
  if (!isRecord(row)) {
    return {
      kind: 'unknown',
      details: {
        code: 'provenance-missing',
        property,
        expected: `${identityField} identity, runId, runAttempt, headSha, treatmentId, fingerprint`,
        observed: row ?? null,
        detail: `${identityField} provenance is missing`,
        action: 'recollect-evidence',
      },
    };
  }
  for (const field of ['runId', 'runAttempt', 'headSha', 'treatmentId', 'fingerprint']) {
    if (!hasValue(row[field])) {
      return {
        kind: 'unknown',
        details: {
          code: 'provenance-field-missing',
          property: `${property}.${field}`,
          expected: field,
          observed: row[field] ?? null,
          detail: `Consumed ${identityField} evidence lacks ${field}`,
          action: 'recollect-evidence',
        },
      };
    }
  }
  if (!hasValue(row[identityField])) {
    return {
      kind: 'unknown',
      details: {
        code: 'provenance-identity-missing',
        property: `${property}.${identityField}`,
        expected: identityField,
        observed: null,
        detail: `Consumed ${identityField} identity is required`,
        action: 'recollect-evidence',
      },
    };
  }
  for (const field of ['runId', 'runAttempt', 'headSha', 'treatmentId']) {
    const expected = packet.identity[field];
    const matches =
      field === 'runAttempt'
        ? Number(row[field]) === Number(expected)
        : String(row[field]) === String(expected);
    if (!matches) {
      return {
        kind: 'invalid',
        details: {
          code: `provenance-foreign-${field}`,
          property: `${property}.${field}`,
          expected,
          observed: row[field],
          detail: `Consumed ${identityField} evidence belongs to another ${field}`,
          action: 'discard-foreign-evidence',
        },
      };
    }
  }
  return { kind: 'valid', row };
}

function projectProvenance(packet) {
  const sources = evidenceSources(packet);
  const rows = {};
  for (const [name, identityField] of [
    ['producer', 'producerId'],
    ['artifact', 'artifactId'],
    ['report', 'reportId'],
  ]) {
    const checked = validateEvidenceIdentity(
      sources[name],
      packet,
      `provenance.${name}`,
      identityField,
    );
    if (checked.kind !== 'valid') return checked;
    rows[name] = checked.row;
  }
  return { kind: 'valid', provenance: rows };
}

function declaredCapacity(job, contract) {
  const capacity = isRecord(job?.capacity) ? job.capacity : null;
  const declaration = capacity?.declared ?? capacity;
  const pool = declaration?.pool ?? declaration?.name ?? capacity?.declaredPool;
  const expected = contract.capacityPools?.[pool];
  if (!expected) return null;
  if (hasValue(declaration?.vcpus) && Number(declaration.vcpus) !== expected.vcpus)
    return { pool, contradiction: 'vcpus', expected };
  if (hasValue(declaration?.memoryGiB) && Number(declaration.memoryGiB) !== expected.memoryGiB)
    return { pool, contradiction: 'memoryGiB', expected };
  return { pool, vcpus: expected.vcpus, memoryGiB: expected.memoryGiB };
}

function projectCapacity(packet, contract, roster) {
  const jobs = Array.isArray(packet?.jobs) ? packet.jobs : [];
  const rows = [];
  for (const name of roster.names) {
    const entry = packet.classifications?.[name];
    if (!entry || entry.classification === 'intentional-skip') continue;
    const job = jobs.find((candidate) => candidate?.name === name);
    if (!job) continue;
    const declared = declaredCapacity(job, contract);
    if (!declared) {
      return {
        kind: 'unknown',
        details: {
          code: 'capacity-declaration-missing',
          property: `jobs.${name}.capacity.declared`,
          expected: Object.keys(contract.capacityPools ?? {}),
          observed: job.capacity ?? job.runnerLabel ?? null,
          detail: 'A standard or heavy virtual capacity declaration is required',
          action: 'measure-capacity',
        },
      };
    }
    if (declared.contradiction) {
      return {
        kind: 'invalid',
        details: {
          code: 'capacity-declaration-contradictory',
          property: `jobs.${name}.capacity.declared.${declared.contradiction}`,
          expected: declared.expected[declared.contradiction],
          observed: job.capacity?.declared?.[declared.contradiction],
          detail: 'Declared virtual capacity disagrees with the closed pool contract',
          action: 'discard-foreign-evidence',
        },
      };
    }
    const observation = job.capacity?.observation ?? job.capacity?.observed;
    if (!isRecord(observation)) {
      return {
        kind: 'unknown',
        details: {
          code: 'capacity-observation-missing',
          property: `jobs.${name}.capacity.observation`,
          expected: 'measured vcpus and memoryGiB or explicit unavailable status',
          observed: job.runnerLabel ?? null,
          detail: 'Runner labels do not measure host capacity',
          action: 'measure-capacity',
        },
      };
    }
    if (observation.status === 'unavailable') {
      if (!hasValue(observation.reason)) {
        return {
          kind: 'invalid',
          details: {
            code: 'capacity-unavailable-reason-missing',
            property: `jobs.${name}.capacity.observation.reason`,
            expected: 'reason for unavailable measurement',
            observed: null,
            detail: 'Unavailable capacity must remain explicit and explained',
            action: 'measure-capacity',
          },
        };
      }
      rows.push({
        name,
        declared,
        observation: { status: 'unavailable', reason: observation.reason },
      });
      continue;
    }
    if (
      !Number.isFinite(Number(observation.vcpus)) ||
      !Number.isFinite(Number(observation.memoryGiB)) ||
      !hasValue(observation.source)
    ) {
      return {
        kind: 'unknown',
        details: {
          code: 'capacity-observation-invalid',
          property: `jobs.${name}.capacity.observation`,
          expected: 'vcpus, memoryGiB, and measurement source',
          observed: observation,
          detail: 'Measured capacity is incomplete',
          action: 'measure-capacity',
        },
      };
    }
    if (
      Number(observation.vcpus) < declared.vcpus ||
      Number(observation.memoryGiB) < declared.memoryGiB
    ) {
      return {
        kind: 'invalid',
        details: {
          code: 'capacity-below-declaration',
          property:
            Number(observation.vcpus) < declared.vcpus
              ? `jobs.${name}.capacity.observation.vcpus`
              : `jobs.${name}.capacity.observation.memoryGiB`,
          expected: declared,
          observed: observation,
          detail: 'Measured host capacity is below the declared virtual contract',
          action: 'discard-foreign-evidence',
        },
      };
    }
    rows.push({ name, declared, observation });
  }
  return { kind: 'valid', capacity: { jobs: rows } };
}

function projectFailures(packet, roster) {
  const failures = Array.isArray(packet?.failures)
    ? packet.failures
    : Array.isArray(packet?.firstFailures)
      ? packet.firstFailures
      : [];
  const parsed = [];
  for (const [index, failure] of failures.entries()) {
    if (
      !isRecord(failure) ||
      !hasValue(failure.context) ||
      !roster.names.includes(failure.context)
    ) {
      return {
        kind: 'invalid',
        details: {
          code: 'failure-context-invalid',
          property: `failures[${index}].context`,
          expected: roster.names,
          observed: failure?.context ?? null,
          detail: 'Failure context must be an authoritative required context',
          action: 'restore-roster-classification',
        },
      };
    }
    if (isRecord(failure.retry) && !authorizedRetryClasses.has(failure.retry.class)) {
      return {
        kind: 'invalid',
        details: {
          code: 'retry-class-unauthorized',
          property: `failures[${index}].retry.class`,
          expected: [...authorizedRetryClasses],
          observed: failure.retry.class ?? null,
          detail: 'Failure retry class is outside the closed authorized vocabulary',
          action: 'discard-foreign-evidence',
        },
      };
    }
    const occurred = parseTimestamp(failure.occurredAt);
    if (occurred === null) {
      return {
        kind: 'unknown',
        details: {
          code: 'first-failure-timestamp-missing',
          property: `failures[${index}].occurredAt`,
          expected: 'parseable failure timestamp',
          observed: failure.occurredAt ?? null,
          detail: 'First-failure ordering needs a source timestamp',
          action: 'recollect-evidence',
        },
      };
    }
    for (const field of ['runId', 'runAttempt', 'headSha', 'treatmentId']) {
      const matches =
        field === 'runAttempt'
          ? Number(failure[field]) === Number(packet.identity[field])
          : String(failure[field]) === String(packet.identity[field]);
      if (!hasValue(failure[field]) || !matches) {
        return {
          kind: 'invalid',
          details: {
            code: 'first-failure-foreign-identity',
            property: `failures[${index}].${field}`,
            expected: packet.identity[field],
            observed: failure[field] ?? null,
            detail: 'First-failure evidence must belong to this packet identity',
            action: 'discard-foreign-evidence',
          },
        };
      }
    }
    parsed.push({ ...failure, occurredMilliseconds: occurred });
  }
  parsed.sort(
    (left, right) =>
      left.occurredMilliseconds - right.occurredMilliseconds ||
      roster.names.indexOf(left.context) - roster.names.indexOf(right.context) ||
      left.context.localeCompare(right.context),
  );
  const earliest = parsed[0]?.occurredMilliseconds;
  const first =
    earliest === undefined
      ? []
      : parsed.filter((failure) => failure.occurredMilliseconds === earliest);
  return {
    kind: 'valid',
    firstFailure: first.length
      ? {
          occurredAt: new Date(earliest).toISOString(),
          contexts: first.map((failure) => failure.context),
          entries: first.map(({ occurredMilliseconds, ...failure }) => failure),
        }
      : null,
  };
}

function projectRetries(packet, roster) {
  const retries = Array.isArray(packet?.retries) ? packet.retries : [];
  for (const [index, retry] of retries.entries()) {
    if (!isRecord(retry) || !roster.names.includes(retry.context)) {
      return {
        kind: 'invalid',
        details: {
          code: 'retry-context-invalid',
          property: `retries[${index}].context`,
          expected: roster.names,
          observed: retry?.context ?? null,
          detail: 'Retry relation must name an authoritative context',
          action: 'restore-roster-classification',
        },
      };
    }
    const attempt = Number(retry.attempt);
    const maxAttempts = Number(retry.maxAttempts);
    if (!authorizedRetryClasses.has(retry.class)) {
      return {
        kind: 'invalid',
        details: {
          code: 'retry-class-unauthorized',
          property: `retries[${index}].class`,
          expected: [...authorizedRetryClasses],
          observed: retry.class ?? null,
          detail: 'Retry class is outside the closed authorized vocabulary',
          action: 'discard-foreign-evidence',
        },
      };
    }
    if (
      !Number.isInteger(attempt) ||
      !Number.isInteger(maxAttempts) ||
      attempt < 1 ||
      maxAttempts < 1
    ) {
      return {
        kind: 'unknown',
        details: {
          code: 'retry-bound-missing',
          property: `retries[${index}]`,
          expected: 'positive integer attempt and maxAttempts',
          observed: retry,
          detail: 'Retry history must declare a bounded relation',
          action: 'recollect-evidence',
        },
      };
    }
    for (const field of ['runId', 'runAttempt', 'headSha', 'treatmentId']) {
      if (!hasValue(retry[field])) continue;
      const matches =
        field === 'runAttempt'
          ? Number(retry[field]) === Number(packet.identity[field])
          : String(retry[field]) === String(packet.identity[field]);
      if (!matches) {
        return {
          kind: 'invalid',
          details: {
            code: 'retry-foreign-identity',
            property: `retries[${index}].${field}`,
            expected: packet.identity[field],
            observed: retry[field],
            detail: 'Retry relation belongs to another packet identity',
            action: 'discard-foreign-evidence',
          },
        };
      }
    }
    if (attempt > maxAttempts) {
      return {
        kind: 'invalid',
        details: {
          code: 'retry-bound-exceeded',
          property: `retries[${index}].attempt`,
          expected: `at most ${maxAttempts}`,
          observed: attempt,
          detail: 'Retry history exceeds its authorized bound',
          action: 'discard-foreign-evidence',
        },
      };
    }
  }
  return { kind: 'valid', retries };
}

function projectM3Evidence(packet, contract, roster) {
  const provenance = projectProvenance(packet);
  if (provenance.kind !== 'valid') return provenance;
  const capacity = projectCapacity(packet, contract, roster);
  if (capacity.kind !== 'valid') return capacity;
  const failures = projectFailures(packet, roster);
  if (failures.kind !== 'valid') return failures;
  const retries = projectRetries(packet, roster);
  if (retries.kind !== 'valid') return retries;
  return {
    kind: 'valid',
    provenance: provenance.provenance,
    capacity: capacity.capacity,
    firstFailure: failures.firstFailure,
    retries: retries.retries,
  };
}

function projectCorrectness(packet, roster) {
  const nonSuccessContexts = roster.names.filter((name) => {
    const classification = packet.classifications?.[name]?.classification;
    return ['executed-failure', 'cancelled', 'superseded'].includes(classification);
  });
  const terminalState = terminalConclusion(packet.terminal);
  const terminalNonSuccess = ['failure', 'cancelled', 'superseded'].includes(terminalState);
  if (nonSuccessContexts.length === 0 && !terminalNonSuccess) return null;
  return {
    contexts: nonSuccessContexts,
    terminalState: terminalNonSuccess ? terminalState : null,
  };
}

function terminalConclusion(terminal) {
  return terminal?.conclusion ?? terminal?.state ?? terminal?.status;
}

function admitPacket(packet, options = {}) {
  const contract = options.contract ?? loadContract(options.contractPath);
  const roster =
    options.roster ??
    loadRoster(
      options.rosterPath ??
        resolve(scriptDirectory, contract.rosterAuthority.path.split('/').pop()),
    );
  if (packet === null || packet === undefined) {
    return unknown(packet, {
      code: 'packet-missing',
      property: 'packet',
      expected: 'one terminal evidence packet',
      observed: null,
      detail: 'No terminal evidence packet was supplied',
      action: 'recollect-evidence',
    });
  }
  if (!isRecord(packet) || packet.schemaVersion !== contract.schemaVersion) {
    return invalid(packet, {
      code: 'packet-invalid',
      property: 'schemaVersion',
      expected: contract.schemaVersion,
      observed: packet?.schemaVersion ?? null,
      detail: 'Packet schema is missing or incompatible',
      action: 'recollect-evidence',
    });
  }
  const identityError = validateIdentity(packet);
  if (identityError) return invalid(packet, identityError);
  const sourceError = validateSource(packet);
  if (sourceError) return invalid(packet, sourceError);
  const duplicateError = validateDuplicateEvidence(packet);
  if (duplicateError) return invalid(packet, duplicateError);
  const rosterResult = validateRoster(packet, roster, contract);
  if (rosterResult) {
    return rosterResult.kind === 'invalid'
      ? invalid(packet, rosterResult.details)
      : unknown(packet, rosterResult.details);
  }
  const timing = projectTerminalTiming(packet, {
    contract,
    roster,
    requireTreatmentSource: true,
  });
  let admitted =
    timing.classification === 'admissible' || timing.classification === 'slo-breach'
      ? {
          ...result(timing.classification, packet, timing.recoveryAction),
          timing: timing.timing,
        }
      : result(timing.classification, packet, timing.recoveryAction);
  if (
    options.skipEvidence ||
    !isRecord(packet.terminal) ||
    !['admissible', 'slo-breach'].includes(timing.classification)
  )
    return admitted;
  const evidence = projectM3Evidence(packet, contract, roster);
  if (evidence.kind !== 'valid') {
    return result(
      evidence.kind === 'invalid' ? 'invalid-evidence' : 'unknown-evidence',
      packet,
      recoveryAction(evidence.details, 'delivery'),
    );
  }
  admitted = {
    ...admitted,
    provenance: evidence.provenance,
    capacity: evidence.capacity,
    firstFailure: evidence.firstFailure,
    retries: evidence.retries,
    correctnessFailure: projectCorrectness(packet, roster),
  };
  return admitted;
}

function projectEvidence(packet, options = {}) {
  const contract = options.contract ?? loadContract(options.contractPath);
  const roster = options.roster ?? loadRoster(options.rosterPath);
  const admitted = admitPacket(packet, { ...options, contract, roster, skipEvidence: true });
  if (!isRecord(packet?.terminal)) return admitted;
  if (!['admissible', 'slo-breach'].includes(admitted.classification)) return admitted;
  const evidence = projectM3Evidence(packet, contract, roster);
  if (evidence.kind !== 'valid') {
    return {
      ...admitted,
      classification: evidence.kind === 'invalid' ? 'invalid-evidence' : 'unknown-evidence',
      recoveryAction: recoveryAction(evidence.details, 'delivery'),
    };
  }
  return {
    ...admitted,
    provenance: evidence.provenance,
    capacity: evidence.capacity,
    firstFailure: evidence.firstFailure,
    retries: evidence.retries,
    correctnessFailure: projectCorrectness(packet, roster),
  };
}

function matchedResult(verdict, pairs = [], recovery = null, details = {}) {
  return {
    verdict,
    classification: verdict,
    matchedPairs: pairs.length,
    pairs,
    recoveryAction: recovery,
    ...details,
  };
}

function pairRecovery(pairIndex, side, recovery, fallbackAction) {
  const action = recovery ?? {
    code: 'matched-packet-invalid',
    property: `pairs[${pairIndex}].${side}`,
    expected: 'admissible terminal evidence',
    observed: null,
    detail: 'Matched packet evidence could not be admitted',
    action: fallbackAction,
  };
  const actionName =
    recovery &&
    recovery.action === 'recollect-evidence' &&
    /terminal|nonterminal/.test(recovery.code)
      ? 'wait-for-terminality'
      : (action.action ?? fallbackAction);
  return {
    ...action,
    property: `pairs[${pairIndex}].${side}.${action.property}`,
    action: actionName,
  };
}

function compareIdentity(baseline, treatment, pairIndex) {
  const baselineIdentity = baseline.identity;
  const treatmentIdentity = treatment.identity;
  if (baselineIdentity.headSha !== treatmentIdentity.headSha) {
    return {
      code: 'matched-head-mismatch',
      property: `pairs[${pairIndex}].treatment.identity.headSha`,
      expected: baselineIdentity.headSha,
      observed: treatmentIdentity.headSha,
      detail: 'Baseline and treatment must use the same exact source head',
      action: 'discard-foreign-evidence',
    };
  }
  if (baselineIdentity.treatmentId === treatmentIdentity.treatmentId) {
    return {
      code: 'matched-treatment-id-mismatch',
      property: `pairs[${pairIndex}].treatment.identity.treatmentId`,
      expected: 'different baseline and treatment identities',
      observed: treatmentIdentity.treatmentId,
      detail: 'A matched pair must contain distinct baseline and treatment observations',
      action: 'discard-foreign-evidence',
    };
  }
  const baselineAuthority = baseline.rosterAuthority ?? {};
  const treatmentAuthority = treatment.rosterAuthority ?? {};
  for (const field of ['path', 'fingerprint']) {
    if (baselineAuthority[field] !== treatmentAuthority[field]) {
      return {
        code: 'matched-roster-mismatch',
        property: `pairs[${pairIndex}].treatment.rosterAuthority.${field}`,
        expected: baselineAuthority[field] ?? null,
        observed: treatmentAuthority[field] ?? null,
        detail: 'Baseline and treatment must use one roster authority',
        action: 'discard-foreign-evidence',
      };
    }
  }
  return null;
}

function compareCapacity(baseline, treatment, pairIndex) {
  const baselineJobs = new Map((baseline.capacity?.jobs ?? []).map((job) => [job.name, job]));
  const treatmentJobs = new Map((treatment.capacity?.jobs ?? []).map((job) => [job.name, job]));
  for (const [name, baselineJob] of baselineJobs) {
    const treatmentJob = treatmentJobs.get(name);
    if (!treatmentJob) {
      return {
        code: 'treatment-capacity-changed',
        property: `pairs[${pairIndex}].treatment.capacity.jobs.${name}`,
        expected: baselineJob.declared,
        observed: null,
        detail: 'Treatment lost a declared capacity observation',
        action: 'measure-capacity',
      };
    }
    if (JSON.stringify(baselineJob.declared) !== JSON.stringify(treatmentJob.declared)) {
      return {
        code: 'treatment-capacity-changed',
        property: `pairs[${pairIndex}].treatment.capacity.jobs.${name}.declared`,
        expected: baselineJob.declared,
        observed: treatmentJob.declared,
        detail: 'Treatment changed the matched virtual capacity contract',
        action: 'discard-foreign-evidence',
      };
    }
  }
  return null;
}

function compareCorrectness(baseline, treatment, roster, pairIndex) {
  for (const name of roster.names) {
    const expected = baseline.classifications?.[name];
    const observed = treatment.classifications?.[name];
    if (!observed) {
      return {
        code: 'treatment-required-context-lost',
        property: `pairs[${pairIndex}].treatment.classifications.${name}`,
        expected: expected?.classification ?? 'classification object',
        observed: null,
        detail: 'Treatment lost an authoritative required context',
        action: 'restore-roster-classification',
      };
    }
    if (expected?.classification === 'intentional-skip') {
      const sameSkip = ['predicate', 'reason', 'semanticCoverageFingerprint'].every(
        (field) => expected[field] === observed[field],
      );
      if (observed.classification !== 'intentional-skip' || !sameSkip) {
        return {
          code: 'treatment-skip-changed',
          property: `pairs[${pairIndex}].treatment.classifications.${name}`,
          expected,
          observed,
          detail: 'Treatment changed an intentional skip or its semantic coverage',
          action: 'restore-roster-classification',
        };
      }
      continue;
    }
    if (
      expected?.classification === 'executed-success' &&
      observed.classification !== 'executed-success'
    ) {
      return {
        code: 'treatment-correctness-regression',
        property: `pairs[${pairIndex}].treatment.classifications.${name}.classification`,
        expected: 'executed-success',
        observed: observed.classification,
        detail: 'Treatment did not preserve required context correctness',
        action: 'recollect-evidence',
      };
    }
  }
  return null;
}

function compareRetryStability(baseline, treatment, pairIndex) {
  const baselineCounts = new Map();
  const baselineFrequency = new Map();
  for (const retry of baseline.retries ?? []) {
    baselineCounts.set(
      retry.context,
      Math.max(baselineCounts.get(retry.context) ?? 0, retry.attempt),
    );
    baselineFrequency.set(retry.context, (baselineFrequency.get(retry.context) ?? 0) + 1);
  }
  const treatmentFrequency = new Map();
  for (const retry of treatment.retries ?? []) {
    treatmentFrequency.set(retry.context, (treatmentFrequency.get(retry.context) ?? 0) + 1);
    if (retry.attempt > (baselineCounts.get(retry.context) ?? 0)) {
      return {
        code: 'treatment-retry-instability',
        property: `pairs[${pairIndex}].treatment.retries`,
        expected: 'no more retries than paired baseline',
        observed: treatment.retries,
        detail: 'Treatment retry or failure stability worsened against baseline',
        action: 'recollect-evidence',
      };
    }
  }
  for (const [context, count] of treatmentFrequency) {
    if (count > (baselineFrequency.get(context) ?? 0)) {
      return {
        code: 'treatment-retry-instability',
        property: `pairs[${pairIndex}].treatment.retries`,
        expected: 'no more retries than paired baseline',
        observed: treatment.retries,
        detail: 'Treatment emitted more retry observations than baseline',
        action: 'recollect-evidence',
      };
    }
  }
  const baselineFailure = baseline.firstFailure?.occurredAt ?? null;
  const treatmentFailure = treatment.firstFailure?.occurredAt ?? null;
  if (!baselineFailure && treatmentFailure) {
    return {
      code: 'treatment-first-failure',
      property: `pairs[${pairIndex}].treatment.firstFailure`,
      expected: null,
      observed: treatment.firstFailure,
      detail: 'Treatment introduced a first required failure',
      action: 'recollect-evidence',
    };
  }
  if (baselineFailure && treatmentFailure && treatmentFailure < baselineFailure) {
    return {
      code: 'treatment-first-failure',
      property: `pairs[${pairIndex}].treatment.firstFailure.occurredAt`,
      expected: `at or after ${baselineFailure}`,
      observed: treatmentFailure,
      detail: 'Treatment moved the first required failure earlier than baseline',
      action: 'recollect-evidence',
    };
  }
  return null;
}

function comparePair(pair, pairIndex, contract, roster) {
  if (!isRecord(pair) || !isRecord(pair.baseline) || !isRecord(pair.treatment)) {
    return {
      kind: 'invalid',
      details: pairRecovery(pairIndex, 'pair', null, 'recollect-evidence'),
    };
  }
  const baseline = projectEvidence(pair.baseline, { contract, roster });
  const treatment = projectEvidence(pair.treatment, { contract, roster });
  for (const [side, projected] of [
    ['baseline', baseline],
    ['treatment', treatment],
  ]) {
    if (
      projected.verdict === 'invalid-evidence' ||
      projected.classification === 'invalid-evidence'
    ) {
      const rollbackCodes = new Set([
        'classification-unknown',
        'intentional-skip-incomplete',
        'capacity-declaration-contradictory',
        'capacity-below-declaration',
        'retry-class-unauthorized',
      ]);
      if (side === 'treatment' && rollbackCodes.has(projected.recoveryAction?.code)) {
        return {
          kind: 'rollback',
          details: {
            ...projected.recoveryAction,
            code: projected.recoveryAction.code.startsWith('capacity-')
              ? 'treatment-capacity-contradiction'
              : projected.recoveryAction.code === 'retry-class-unauthorized'
                ? 'treatment-unauthorized-retry-class'
                : 'treatment-unauthorized-classification',
            detail: 'Treatment changed or contradicted a protected evidence invariant',
          },
        };
      }
      return {
        kind: 'invalid',
        details: pairRecovery(
          pairIndex,
          side,
          projected.recoveryAction,
          'discard-foreign-evidence',
        ),
      };
    }
    if (
      projected.verdict === 'unknown-evidence' ||
      projected.classification === 'unknown-evidence'
    ) {
      const lostContext = ['roster-missing-context', 'context-missing'].includes(
        projected.recoveryAction?.code,
      );
      if (!lostContext) {
        return {
          kind: 'unknown',
          details: pairRecovery(
            pairIndex,
            side,
            projected.recoveryAction,
            projected.recoveryAction?.action ?? 'recollect-evidence',
          ),
        };
      }
      if (side === 'treatment') {
        return {
          kind: 'rollback',
          details: {
            code: 'treatment-required-context-lost',
            property: pairRecovery(
              pairIndex,
              side,
              projected.recoveryAction,
              'restore-roster-classification',
            ).property,
            expected: projected.recoveryAction.expected,
            observed: projected.recoveryAction.observed,
            detail: 'Treatment lost an authoritative required context',
            action: 'restore-roster-classification',
          },
        };
      }
    }
  }
  if (baseline.correctnessFailure) {
    return {
      kind: 'correctness',
      details: {
        code: 'baseline-correctness-failure',
        property: `pairs[${pairIndex}].baseline.correctnessFailure`,
        expected: 'all terminal required contexts succeed',
        observed: baseline.correctnessFailure,
        detail:
          'Baseline contains terminal non-success evidence and cannot establish an SLO comparison',
        action: 'recollect-evidence',
      },
    };
  }
  const identityError = compareIdentity(baseline, treatment, pairIndex);
  if (identityError) return { kind: 'invalid', details: identityError };
  const correctnessError = compareCorrectness(baseline, treatment, roster, pairIndex);
  if (correctnessError) return { kind: 'rollback', details: correctnessError };
  if (treatment.correctnessFailure) {
    return {
      kind: 'rollback',
      details: {
        code: 'treatment-correctness-failure',
        property: `pairs[${pairIndex}].treatment.correctnessFailure`,
        expected: 'no terminal or context correctness failures',
        observed: treatment.correctnessFailure,
        detail:
          'Treatment contains terminal non-success evidence and cannot establish an SLO comparison',
        action: 'recollect-evidence',
      },
    };
  }
  const retryError = compareRetryStability(baseline, treatment, pairIndex);
  if (retryError) return { kind: 'rollback', details: retryError };
  const capacityError = compareCapacity(baseline, treatment, pairIndex);
  if (capacityError) return { kind: 'rollback', details: capacityError };
  const baselineWall = baseline.timing?.terminalWallSeconds;
  const treatmentWall = treatment.timing?.terminalWallSeconds;
  if (treatmentWall > contract.terminalWall.maxSeconds) {
    return {
      kind: 'rollback',
      details: {
        code: 'treatment-terminal-wall-breach',
        property: `pairs[${pairIndex}].treatment.timing.terminalWallSeconds`,
        expected: contract.terminalWall.maxSeconds,
        observed: treatmentWall,
        detail: 'A repeated treatment exceeds the terminal wall SLO',
        action: 'recollect-evidence',
      },
    };
  }
  if (treatmentWall >= baselineWall) {
    return {
      kind: 'rollback',
      details: {
        code: 'treatment-no-improvement',
        property: `pairs[${pairIndex}].treatment.timing.terminalWallSeconds`,
        expected: `less than ${baselineWall}`,
        observed: treatmentWall,
        detail: 'Treatment does not improve its matched baseline terminal wall',
        action: 'recollect-evidence',
      },
    };
  }
  return {
    kind: 'valid',
    projection: {
      baseline: {
        identity: baseline.identity,
        timing: baseline.timing,
        capacity: baseline.capacity,
        firstFailure: baseline.firstFailure,
        retries: baseline.retries,
      },
      treatment: {
        identity: treatment.identity,
        timing: treatment.timing,
        capacity: treatment.capacity,
        firstFailure: treatment.firstFailure,
        retries: treatment.retries,
      },
      improvementSeconds: baselineWall - treatmentWall,
    },
  };
}

/**
 * Compare exact-head baseline/treatment packets without network or policy side effects.
 * The result exposes verdict, classification, matchedPairs, pairs, and recoveryAction.
 */
function compareMatchedPairs(pairs, options = {}) {
  const contract = options.contract ?? loadContract(options.contractPath);
  const roster = options.roster ?? loadRoster(options.rosterPath);
  if (!Array.isArray(pairs)) {
    return matchedResult(
      'invalid-evidence',
      [],
      recoveryAction(
        {
          code: 'matched-pairs-invalid',
          property: 'pairs',
          expected: 'array of baseline/treatment pairs',
          observed: pairs ?? null,
          detail: 'Matched comparison input must be an array',
          action: 'recollect-evidence',
        },
        'comparison',
      ),
    );
  }
  const projections = [];
  const identities = new Set();
  for (const [index, pair] of pairs.entries()) {
    const key =
      isRecord(pair?.baseline) && isRecord(pair?.treatment)
        ? [
            pair.baseline.identity?.runId,
            pair.baseline.identity?.runAttempt,
            pair.treatment.identity?.runId,
            pair.treatment.identity?.runAttempt,
          ].join('|')
        : null;
    if (key !== null && identities.has(key)) {
      return matchedResult(
        'invalid-evidence',
        projections,
        recoveryAction(
          {
            code: 'matched-pair-duplicate',
            property: `pairs[${index}]`,
            expected: 'distinct baseline and treatment run identities',
            observed: key,
            detail: 'Matched comparison pairs must be distinct observations',
            action: 'discard-foreign-evidence',
          },
          'comparison',
        ),
      );
    }
    const compared = comparePair(pair, index, contract, roster);
    if (compared.kind !== 'valid') {
      if (compared.kind === 'correctness') {
        return matchedResult(
          'correctness-failure',
          projections,
          recoveryAction(compared.details, 'comparison'),
        );
      }
      if (compared.kind === 'rollback' && pairs.length < 2) {
        return matchedResult(
          'unknown-evidence',
          projections,
          recoveryAction(
            {
              code: 'matched-pairs-insufficient',
              property: 'pairs',
              expected: 'at least two distinct matched baseline/treatment pairs',
              observed: pairs.length,
              detail: 'One fast observation cannot establish repeated treatment stability',
              action: 'recollect-evidence',
            },
            'comparison',
          ),
        );
      }
      const verdict =
        compared.kind === 'rollback' ? 'rollback-required' : `${compared.kind}-evidence`;
      return matchedResult(verdict, projections, recoveryAction(compared.details, 'comparison'));
    }
    if (key !== null) identities.add(key);
    projections.push(compared.projection);
  }
  if (projections.length < 2) {
    return matchedResult(
      'unknown-evidence',
      projections,
      recoveryAction(
        {
          code: 'matched-pairs-insufficient',
          property: 'pairs',
          expected: 'at least two distinct matched baseline/treatment pairs',
          observed: projections.length,
          detail: 'One fast observation cannot establish repeated treatment stability',
          action: 'recollect-evidence',
        },
        'comparison',
      ),
    );
  }
  return matchedResult('slo-pass', projections);
}

export {
  admitPacket,
  compareMatchedPairs,
  loadContract,
  loadRoster,
  projectEvidence,
  projectTerminalTiming,
};
export const verifyPacket = admitPacket;

if (isMainThread && process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2];
  const packet = inputPath ? readJson(resolve(inputPath)) : JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(`${JSON.stringify(admitPacket(packet), null, 2)}\n`);
}
