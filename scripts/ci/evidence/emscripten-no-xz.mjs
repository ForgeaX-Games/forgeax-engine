#!/usr/bin/env node

/*
 * Linux-only Emscripten 6.0.2 evidence runner.
 * It records real emcc calls around the existing fbx and codec entrypoints.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '../../..');
const LOCK_PATH = join(REPO_ROOT, 'scripts/ci/emscripten-no-xz.lock.json');
const SCHEMA_VERSION = 1;
const REQUIRED_CONSUMERS = ['fbx', 'codec'];
const FINGERPRINT_FIELDS = [
  'emscriptenVersion',
  'releaseIdentity',
  'runnerOs',
  'runnerArch',
  'bootstrapInputDigest',
];
const XZ_COMMANDS = ['xz', 'unxz', 'xz-utils', 'xzcat', 'xzdec', 'pixz'];
const HEX_SHA256 = /^sha256:[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const OUTPUTS = {
  fbx: ['pkg/fbx-wasm.mjs', 'pkg/fbx-wasm.wasm'],
  codec: [
    'pkg/basis_transcoder.mjs',
    'pkg/basis_transcoder.wasm',
    'pkg/encode/basis_encoder.mjs',
    'pkg/encode/basis_encoder.wasm',
  ],
};
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

const HELP = `Linux-only Emscripten 6.0.2 consumer evidence runner.
System Node from .nvmrc is authoritative. No external xz or xz-utils fallback.
Cold creates the toolchain cache; warm accepts only the exact cold cache and envelope.
Each ready envelope records node.executableSha256 from its validated nodePath; warm comparison uses this executable identity instead of runner-local absolute paths.
Local envelopes validate the Node path on the current runner; warm linkage validates historical cold paths portably.

Usage:
  node scripts/ci/evidence/emscripten-no-xz.mjs --mode cold --evidence-dir <dir>
  node scripts/ci/evidence/emscripten-no-xz.mjs --mode warm --cold-evidence <path> --evidence-dir <dir>
  node scripts/ci/evidence/emscripten-no-xz.mjs --validate <envelope.json>
`;

function failure(stage, reason, expected, observed, hint, mode) {
  return { status: 'blocked', ...(mode ? { mode } : {}), stage, reason, expected, observed, hint };
}

function rejected(stage, reason, expected, observed, hint) {
  return { status: 'rejected', stage, reason, expected, observed, hint };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireKeys(value, keys, path) {
  if (!isRecord(value)) {
    return rejected(
      'schema-validation',
      'wrong-field-type',
      'object',
      typeof value,
      `make ${path} an object`,
    );
  }
  for (const key of keys) {
    if (!(key in value)) {
      return rejected(
        'schema-validation',
        'missing-field',
        `${path}.${key}`,
        'missing',
        `add ${path}.${key} to the envelope`,
      );
    }
  }
  return null;
}

function requireString(value, path) {
  return typeof value === 'string' && value.length > 0
    ? null
    : rejected(
        'schema-validation',
        'wrong-field-type',
        'non-empty string',
        value,
        `set ${path} to a non-empty string`,
      );
}

function requireBoolean(value, path) {
  return typeof value === 'boolean'
    ? null
    : rejected(
        'schema-validation',
        'wrong-field-type',
        'boolean',
        value,
        `set ${path} to true or false`,
      );
}

function requireArray(value, path) {
  return Array.isArray(value)
    ? null
    : rejected('schema-validation', 'wrong-field-type', 'array', value, `set ${path} to an array`);
}

function validateFingerprint(fingerprint, path) {
  let issue = requireKeys(fingerprint, FINGERPRINT_FIELDS, path);
  if (issue) return issue;
  for (const field of FINGERPRINT_FIELDS) {
    issue = requireString(fingerprint[field], `${path}.${field}`);
    if (issue) return issue;
  }
  if (fingerprint.emscriptenVersion !== '6.0.2') {
    return rejected(
      'compiler-identity',
      'fingerprint-mismatch',
      { emscriptenVersion: '6.0.2' },
      fingerprint.emscriptenVersion,
      'use the locked Emscripten 6.0.2 release',
    );
  }
  if (fingerprint.runnerOs !== 'Linux' || fingerprint.runnerArch !== 'x86_64') {
    return rejected(
      'compiler-identity',
      'unsupported-runner',
      { runnerOs: 'Linux', runnerArch: 'x86_64' },
      { runnerOs: fingerprint.runnerOs, runnerArch: fingerprint.runnerArch },
      'run the evidence lane on a Linux x86_64 runner',
    );
  }
  if (
    !fingerprint.releaseIdentity.startsWith('releases-') ||
    !fingerprint.releaseIdentity.endsWith('-64bit')
  ) {
    return rejected(
      'compiler-identity',
      'wrong-release-identity',
      'direct 64-bit releases-* identity',
      fingerprint.releaseIdentity,
      'use the locked direct Emscripten release tool',
    );
  }
  if (!HEX_SHA256.test(fingerprint.bootstrapInputDigest)) {
    return rejected(
      'compiler-identity',
      'wrong-fingerprint',
      'sha256:<64 lowercase hex digits>',
      fingerprint.bootstrapInputDigest,
      'recompute bootstrapInputDigest from the locked bootstrap inputs',
    );
  }
  return null;
}

function validateEnvelope(envelope, { nodePathMode = 'local' } = {}) {
  if (!['local', 'portable'].includes(nodePathMode))
    return rejected(
      'node-authority',
      'invalid-node-path-mode',
      ['local', 'portable'],
      nodePathMode,
      'use local for a current runner or portable for a historical cold envelope',
    );
  const requireLocalNode = nodePathMode === 'local';
  let issue = requireKeys(
    envelope,
    [
      'schemaVersion',
      'status',
      'mode',
      'source',
      'run',
      'runner',
      'xz',
      'cache',
      'compiler',
      'node',
      'emcc',
      'consumer',
      'output',
      'gate',
    ],
    'envelope',
  );
  if (issue) return issue;
  if (envelope.schemaVersion !== SCHEMA_VERSION)
    return rejected(
      'schema-validation',
      'schema-version-mismatch',
      SCHEMA_VERSION,
      envelope.schemaVersion,
      'use schemaVersion 1 for this evidence contract',
    );
  if (envelope.status !== 'ready' || !['cold', 'warm'].includes(envelope.mode))
    return rejected(
      'schema-validation',
      'invalid-status',
      { status: 'ready', mode: ['cold', 'warm'] },
      { status: envelope.status, mode: envelope.mode },
      'write a ready cold or warm envelope after all gates pass',
    );

  issue = requireKeys(envelope.source, ['sha', 'repository'], 'source');
  if (issue) return issue;
  if (typeof envelope.source.sha !== 'string' || !SOURCE_SHA.test(envelope.source.sha))
    return rejected(
      'source',
      'wrong-source-sha',
      '40 lowercase hexadecimal characters',
      envelope.source.sha,
      'record the fixed checkout source SHA',
    );
  issue = requireString(envelope.source.repository, 'source.repository');
  if (issue) return issue;

  issue = requireKeys(envelope.run, ['id', 'attempt', 'workflow'], 'run');
  if (issue) return issue;
  issue = requireString(envelope.run.id, 'run.id');
  if (issue) return issue;
  if (!Number.isInteger(envelope.run.attempt) || envelope.run.attempt < 1)
    return rejected(
      'run',
      'wrong-field-type',
      'positive integer',
      envelope.run.attempt,
      'record the GitHub Actions run attempt',
    );
  issue = requireString(envelope.run.workflow, 'run.workflow');
  if (issue) return issue;

  issue = requireKeys(envelope.runner, ['os', 'arch', 'name'], 'runner');
  if (issue) return issue;
  if (envelope.runner.os !== 'Linux' || envelope.runner.arch !== 'x86_64')
    return rejected(
      'runner',
      'unsupported-runner',
      { os: 'Linux', arch: 'x86_64' },
      { os: envelope.runner.os, arch: envelope.runner.arch },
      'run this evidence lane on Linux x86_64; Darwin is not Linux evidence',
    );
  issue = requireString(envelope.runner.name, 'runner.name');
  if (issue) return issue;

  issue = requireKeys(
    envelope.xz,
    [
      'checkedCommands',
      'available',
      'installAttempted',
      'invocationDetected',
      'lanePathControlled',
      'laneCommandPaths',
      'hostCommandPaths',
      'hostPackageStatus',
      'pythonLzmaUsed',
    ],
    'xz',
  );
  if (issue) return issue;
  issue = requireArray(envelope.xz.checkedCommands, 'xz.checkedCommands');
  if (issue) return issue;
  for (const command of XZ_COMMANDS) {
    if (!envelope.xz.checkedCommands.includes(command))
      return rejected(
        'xz-preflight',
        'missing-command-probe',
        command,
        envelope.xz.checkedCommands,
        'probe every external xz family command before bootstrap',
      );
  }
  for (const field of ['available', 'installAttempted', 'invocationDetected']) {
    issue = requireBoolean(envelope.xz[field], `xz.${field}`);
    if (issue) return issue;
    if (envelope.xz[field])
      return rejected(
        'xz-preflight',
        'external-xz-detected',
        false,
        envelope.xz[field],
        'remove external xz use; retry with Python lzma and no fallback',
      );
  }
  if (envelope.xz.lanePathControlled !== true || envelope.xz.pythonLzmaUsed !== true)
    return rejected(
      'xz-preflight',
      'lane-isolation-unproven',
      { lanePathControlled: true, pythonLzmaUsed: true },
      {
        lanePathControlled: envelope.xz.lanePathControlled,
        pythonLzmaUsed: envelope.xz.pythonLzmaUsed,
      },
      'use a controlled lane PATH and prove Python stdlib lzma extraction',
    );
  for (const pathsField of ['laneCommandPaths', 'hostCommandPaths']) {
    issue = requireKeys(envelope.xz[pathsField], XZ_COMMANDS, `xz.${pathsField}`);
    if (issue) return issue;
    for (const command of XZ_COMMANDS) {
      issue = requireBoolean(envelope.xz[pathsField][command], `xz.${pathsField}.${command}`);
      if (issue) return issue;
    }
  }
  if (Object.values(envelope.xz.laneCommandPaths).some(Boolean))
    return rejected(
      'xz-preflight',
      'lane-xz-command-reachable',
      false,
      envelope.xz.laneCommandPaths,
      'remove every xz-family executable name from the controlled lane PATH',
    );
  if (!['installed', 'not-installed', 'unknown'].includes(envelope.xz.hostPackageStatus))
    return rejected(
      'schema-validation',
      'wrong-field-type',
      ['installed', 'not-installed', 'unknown'],
      envelope.xz.hostPackageStatus,
      'record host package status as informational evidence',
    );

  issue = requireKeys(envelope.cache, ['status', 'key', 'matchedKey', 'fingerprint'], 'cache');
  if (issue) return issue;
  const expectedCacheStatus = envelope.mode === 'cold' ? 'cold-created' : 'exact-valid';
  if (envelope.cache.status !== expectedCacheStatus)
    return rejected(
      'cache',
      'wrong-cache-status',
      expectedCacheStatus,
      envelope.cache.status,
      'record cold-created or exact-valid only after fingerprint validation',
    );
  issue = requireString(envelope.cache.key, 'cache.key');
  if (issue) return issue;
  if (envelope.mode === 'warm' && typeof envelope.cache.matchedKey !== 'string')
    return rejected(
      'cache',
      'missing-exact-match',
      'non-empty matchedKey',
      envelope.cache.matchedKey,
      'restore the exact cache produced by the cold lane',
    );
  issue = validateFingerprint(envelope.cache.fingerprint, 'cache.fingerprint');
  if (issue) return issue;

  issue = requireKeys(
    envelope.compiler,
    ['emscriptenVersion', 'releaseIdentity', 'emccPath', 'fingerprint'],
    'compiler',
  );
  if (issue) return issue;
  issue = requireString(envelope.compiler.emccPath, 'compiler.emccPath');
  if (issue) return issue;
  issue = validateFingerprint(envelope.compiler.fingerprint, 'compiler.fingerprint');
  if (issue) return issue;
  for (const field of FINGERPRINT_FIELDS) {
    if (envelope.compiler.fingerprint[field] !== envelope.cache.fingerprint[field])
      return rejected(
        'compiler-identity',
        'fingerprint-mismatch',
        envelope.cache.fingerprint,
        envelope.compiler.fingerprint,
        'make compiler and cache fingerprints identical before validation',
      );
  }
  if (
    envelope.compiler.emscriptenVersion !== envelope.compiler.fingerprint.emscriptenVersion ||
    envelope.compiler.releaseIdentity !== envelope.compiler.fingerprint.releaseIdentity
  )
    return rejected(
      'compiler-identity',
      'compiler-field-mismatch',
      envelope.compiler.fingerprint,
      {
        emscriptenVersion: envelope.compiler.emscriptenVersion,
        releaseIdentity: envelope.compiler.releaseIdentity,
      },
      'derive compiler identity from the five-field fingerprint',
    );

  issue = requireKeys(
    envelope.node,
    [
      'expectedVersion',
      'nodeVersion',
      'nodePath',
      'emsdkNode',
      'executableSha256',
      'bundledNodePaths',
    ],
    'node',
  );
  if (issue) return issue;
  for (const field of ['expectedVersion', 'nodeVersion', 'nodePath', 'emsdkNode']) {
    issue = requireString(envelope.node[field], `node.${field}`);
    if (issue) return issue;
  }
  if (envelope.node.expectedVersion !== '22.22.3' || envelope.node.nodeVersion !== 'v22.22.3')
    return rejected(
      'node-authority',
      'node-version-mismatch',
      { expectedVersion: '22.22.3', nodeVersion: 'v22.22.3' },
      { expectedVersion: envelope.node.expectedVersion, nodeVersion: envelope.node.nodeVersion },
      'run setup-node from .nvmrc and record the resulting version',
    );
  if (envelope.node.nodePath !== envelope.node.emsdkNode)
    return rejected(
      'node-authority',
      'emsdk-node-mismatch',
      envelope.node.nodePath,
      envelope.node.emsdkNode,
      'point EMSDK_NODE at the normalized system Node path',
    );
  if (!isAbsolute(envelope.node.nodePath))
    return rejected(
      'node-authority',
      'node-path-not-absolute',
      'absolute normalized Node executable path',
      envelope.node.nodePath,
      'record the absolute system Node path used by EMSDK_NODE',
    );
  if (
    requireLocalNode &&
    (!existsSync(envelope.node.nodePath) || !statSync(envelope.node.nodePath).isFile())
  )
    return rejected(
      'node-authority',
      'node-path-missing',
      'existing absolute normalized Node executable path',
      envelope.node.nodePath,
      'record the validated system Node path used by EMSDK_NODE',
    );
  if (!HEX_SHA256.test(envelope.node.executableSha256))
    return rejected(
      'node-authority',
      'wrong-node-executable-sha256',
      'sha256:<64 lowercase hex digits>',
      envelope.node.executableSha256,
      'hash the validated nodePath executable for cross-runner comparison',
    );
  if (requireLocalNode) {
    const observedNodeSha256 = sha256(envelope.node.nodePath);
    if (observedNodeSha256 !== envelope.node.executableSha256)
      return rejected(
        'node-authority',
        'node-executable-sha256-mismatch',
        observedNodeSha256,
        envelope.node.executableSha256,
        'recompute executableSha256 from the validated nodePath',
      );
  }
  issue = requireArray(envelope.node.bundledNodePaths, 'node.bundledNodePaths');
  if (issue) return issue;
  if (envelope.node.bundledNodePaths.length !== 0)
    return rejected(
      'node-authority',
      'bundled-node-detected',
      [],
      envelope.node.bundledNodePaths,
      'keep Emscripten bundled Node out of the evidence lane',
    );

  issue = requireKeys(envelope.emcc, ['invocations'], 'emcc');
  if (issue) return issue;
  issue = requireArray(envelope.emcc.invocations, 'emcc.invocations');
  if (issue) return issue;
  const invocationIds = new Set();
  const invocationConsumers = new Set();
  for (const invocation of envelope.emcc.invocations) {
    issue = requireKeys(invocation, ['id', 'consumer', 'command', 'exitCode'], 'emcc.invocation');
    if (issue) return issue;
    issue = requireString(invocation.id, 'emcc.invocation.id');
    if (issue) return issue;
    if (invocationIds.has(invocation.id))
      return rejected(
        'consumer-emcc',
        'duplicate-invocation-id',
        'unique invocation id',
        invocation.id,
        'record each real emcc process once',
      );
    invocationIds.add(invocation.id);
    if (!REQUIRED_CONSUMERS.includes(invocation.consumer))
      return rejected(
        'consumer-emcc',
        'unknown-consumer',
        REQUIRED_CONSUMERS,
        invocation.consumer,
        'attribute emcc calls to fbx or codec',
      );
    invocationConsumers.add(invocation.consumer);
    issue = requireArray(invocation.command, 'emcc.invocation.command');
    if (issue) return issue;
    if (!invocation.command.includes('emcc') || invocation.exitCode !== 0)
      return rejected(
        'consumer-emcc',
        'invalid-emcc-invocation',
        { commandIncludes: 'emcc', exitCode: 0 },
        invocation,
        'record a successful real emcc invocation for each consumer',
      );
  }
  for (const name of REQUIRED_CONSUMERS) {
    if (!invocationConsumers.has(name))
      return rejected(
        'consumer-emcc',
        'missing-consumer-invocation',
        name,
        [...invocationConsumers],
        `run the ${name} build through the real emcc wrapper`,
      );
  }

  issue = requireArray(envelope.consumer, 'consumer');
  if (issue) return issue;
  const consumers = new Map(envelope.consumer.map((value) => [value.name, value]));
  for (const name of REQUIRED_CONSUMERS) {
    const consumer = consumers.get(name);
    if (!consumer)
      return rejected(
        'consumer',
        'missing-consumer',
        name,
        [...consumers.keys()],
        'record both fbx and codec consumers',
      );
    issue = requireKeys(
      consumer,
      ['name', 'invocationIds', 'outputNames', 'gateIds'],
      `consumer.${name}`,
    );
    if (issue) return issue;
    if (
      consumer.invocationIds.length === 0 ||
      consumer.outputNames.length === 0 ||
      consumer.gateIds.length === 0
    )
      return rejected(
        'consumer',
        'incomplete-consumer-record',
        name,
        consumer,
        'record invocation, non-empty outputs, and gate ids for each consumer',
      );
    for (const invocationId of consumer.invocationIds) {
      if (!invocationIds.has(invocationId))
        return rejected(
          'consumer-emcc',
          'consumer-invocation-missing',
          invocationId,
          [...invocationIds],
          `run emcc for ${name} before writing the envelope`,
        );
    }
    const expectedOutputs = OUTPUTS[name];
    if (
      consumer.outputNames.length !== expectedOutputs.length ||
      [...consumer.outputNames].sort().join('\n') !== [...expectedOutputs].sort().join('\n')
    )
      return rejected(
        'consumer',
        'incomplete-output-set',
        expectedOutputs,
        consumer.outputNames,
        `record every ${name} glue and wasm output; do not use a wasm-only shortcut`,
      );
  }

  if (envelope.mode === 'warm' && envelope.comparison !== undefined) {
    issue = requireKeys(
      envelope.comparison,
      ['equivalent', 'fingerprintEqual', 'outputEqual', 'nodeEqual'],
      'comparison',
    );
    if (issue) return issue;
    for (const field of ['equivalent', 'fingerprintEqual', 'outputEqual', 'nodeEqual']) {
      issue = requireBoolean(envelope.comparison[field], `comparison.${field}`);
      if (issue) return issue;
    }
    if (envelope.comparison.equivalent !== true)
      return rejected(
        'warm-comparison',
        'comparison-not-equivalent',
        true,
        envelope.comparison,
        'do not publish a warm envelope until compiler, Node, and output evidence match cold',
      );
  }

  issue = requireKeys(envelope.output, ['files'], 'output');
  if (issue) return issue;
  issue = requireArray(envelope.output.files, 'output.files');
  if (issue) return issue;
  const outputMap = new Map();
  for (const output of envelope.output.files) {
    issue = requireKeys(output, ['consumer', 'name', 'outputSha256'], 'output.file');
    if (issue) return issue;
    if (!REQUIRED_CONSUMERS.includes(output.consumer))
      return rejected(
        'output-digest',
        'unknown-output-consumer',
        REQUIRED_CONSUMERS,
        output.consumer,
        'record outputs under fbx or codec',
      );
    for (const field of ['consumer', 'name', 'outputSha256']) {
      issue = requireString(output[field], `output.file.${field}`);
      if (issue) return issue;
    }
    if (!HEX_SHA256.test(output.outputSha256))
      return rejected(
        'output-digest',
        'wrong-output-fingerprint',
        'sha256:<64 lowercase hex digits>',
        output.outputSha256,
        'hash every declared consumer output with SHA-256',
      );
    outputMap.set(`${output.consumer}:${output.name}`, output.outputSha256);
  }
  const expectedOutputKeys = REQUIRED_CONSUMERS.flatMap((name) =>
    OUTPUTS[name].map((path) => `${name}:${path}`),
  );
  if (outputMap.size !== expectedOutputKeys.length)
    return rejected(
      'output-digest',
      'incomplete-output-set',
      expectedOutputKeys,
      [...outputMap.keys()],
      'record every non-empty consumer output, including glue and wasm files',
    );
  for (const key of expectedOutputKeys) {
    if (!outputMap.has(key))
      return rejected(
        'output-digest',
        'missing-consumer-output',
        key,
        [...outputMap.keys()],
        'record every declared non-empty consumer output',
      );
  }

  issue = requireKeys(envelope.gate, ['results'], 'gate');
  if (issue) return issue;
  issue = requireArray(envelope.gate.results, 'gate.results');
  if (issue) return issue;
  const gates = new Map(envelope.gate.results.map((value) => [value.id, value]));
  for (const consumer of consumers.values()) {
    for (const gateId of consumer.gateIds) {
      const gate = gates.get(gateId);
      if (!gate || gate.consumer !== consumer.name || gate.status !== 'pass')
        return rejected(
          'gate',
          'consumer-gate-failed',
          { id: gateId, consumer: consumer.name, status: 'pass' },
          gate ?? 'missing',
          'run and record the applicable consumer gate before validation',
        );
    }
  }
  return null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return rejected(
      'envelope-read',
      'invalid-json',
      'valid JSON envelope',
      String(error),
      'write a complete JSON envelope and retry validation',
    );
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  writeFileSync(path, readFileSync(temporary));
  rmSync(temporary, { force: true });
}

function commandPath(command, path = process.env.PATH || '') {
  const result = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'forgeax-xz-probe', command], {
    encoding: 'utf8',
    env: { ...process.env, PATH: path },
  });
  return result.status === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null;
}

function probeCommand(command, path = process.env.PATH || '') {
  return commandPath(command, path) !== null;
}

function probePackage(path = process.env.PATH || '') {
  const env = { ...process.env, PATH: path };
  const dpkg = spawnSync('dpkg-query', ['-W', `-f=\${Status}`, 'xz-utils'], {
    encoding: 'utf8',
    env,
  });
  if (dpkg.status === 0)
    return dpkg.stdout.includes('install ok installed') ? 'installed' : 'not-installed';
  const rpm = spawnSync('rpm', ['-q', 'xz'], { encoding: 'utf8', env });
  if (rpm.status === 0) return 'installed';
  if (rpm.status !== null || dpkg.error?.code === 'ENOENT') return 'not-installed';
  return 'unknown';
}

function probeXz({
  lanePath = process.env.PATH || '',
  hostPath = lanePath,
  pythonLzmaUsed = false,
} = {}) {
  const laneCommandPaths = Object.fromEntries(
    XZ_COMMANDS.map((command) => [command, probeCommand(command, lanePath)]),
  );
  const hostCommandPaths = Object.fromEntries(
    XZ_COMMANDS.map((command) => [command, probeCommand(command, hostPath)]),
  );
  const hostPackageStatus = probePackage(hostPath);
  const logPath = process.env.FORGEAX_XZ_INVOCATION_LOG;
  const invocationDetected = Boolean(logPath && existsSync(logPath) && statSync(logPath).size > 0);
  return {
    checkedCommands: XZ_COMMANDS,
    available: Object.entries(laneCommandPaths).some(
      ([command, available]) => command !== 'xz-utils' && available,
    ),
    installAttempted: process.env.FORGEAX_XZ_INSTALL_ATTEMPTED === '1',
    invocationDetected,
    lanePathControlled: lanePath !== hostPath,
    laneCommandPaths,
    hostCommandPaths,
    hostPackageStatus,
    pythonLzmaUsed,
  };
}

function createControlledLanePath(hostPath = process.env.PATH || '', additionalDirectories = []) {
  const root = mkdtempSync(join(os.tmpdir(), `forgeax-no-xz-path-${process.pid}-`));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const blocked = new Set(XZ_COMMANDS);
  const linkedNames = new Set();
  for (const directory of [...additionalDirectories, ...hostPath.split(delimiter)].filter(
    Boolean,
  )) {
    if (!existsSync(directory)) continue;
    let names;
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (blocked.has(name) || linkedNames.has(name)) continue;
      try {
        const source = join(directory, name);
        const destination = join(bin, name);
        if (lstatSync(source).isSymbolicLink()) {
          const stableSource = realpathSync(source);
          writeFileSync(destination, `#!/bin/sh\nexec ${shellQuote(stableSource)} "$@"\n`, 'utf8');
          chmodSync(destination, 0o755);
        } else {
          symlinkSync(source, destination);
        }
        linkedNames.add(name);
      } catch {
        /* Preserve the first usable PATH entry without changing the host. */
      }
    }
  }
  return { path: bin, root, blockedCommands: XZ_COMMANDS };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runtimeRunner() {
  return {
    os: process.platform === 'linux' ? 'Linux' : process.platform,
    arch: process.arch === 'x64' ? 'x86_64' : process.arch,
    name: process.env.RUNNER_NAME || os.hostname() || 'unknown',
  };
}

function fixedSourceSha() {
  const observed = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const expected = process.env.GITHUB_SHA || observed;
  if (!SOURCE_SHA.test(expected) || expected !== observed)
    throw failure(
      'source',
      'source-sha-unverifiable',
      SOURCE_SHA.source,
      { expected, observed },
      'checkout one fixed commit and expose the matching GITHUB_SHA',
    );
  return expected;
}

function clearConsumerSources(mode) {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp)
    throw failure(
      'cleanup',
      'runner-temp-unavailable',
      'RUNNER_TEMP absolute path',
      'missing',
      'run on the GitHub Linux runner with RUNNER_TEMP available',
    );
  const paths = [
    join(REPO_ROOT, 'packages/fbx/pkg'),
    join(REPO_ROOT, 'packages/codec/pkg'),
    process.env.FORGEAX_CONSUMER_CACHE_DIR ||
      join(runnerTemp, `emscripten-no-xz-${mode}-consumer-cache`),
    process.env.FORGEAX_HYDRATION_DIR || join(runnerTemp, `emscripten-no-xz-${mode}-hydration`),
  ];
  for (const path of paths) rmSync(path, { recursive: true, force: true });
  const cleanup = {
    toolchainCacheEmpty: false,
    fbxOutputCleared: !existsSync(paths[0]),
    codecOutputCleared: !existsSync(paths[1]),
    consumerCacheCleared: !existsSync(paths[2]),
    hydrationCleared: !existsSync(paths[3]),
  };
  return { ...cleanup, paths };
}

function checkPreflight(facts, mode, coldEnvelope = null) {
  if (!isRecord(facts) || !SOURCE_SHA.test(facts.sourceSha || ''))
    return failure(
      'source',
      'source-sha-unverifiable',
      '40 lowercase hexadecimal characters',
      facts?.sourceSha,
      'checkout one fixed commit before collecting evidence',
      mode,
    );
  if (facts.runner?.os !== 'Linux' || facts.runner?.arch !== 'x86_64')
    return failure(
      'runner',
      'unsupported-runner',
      { os: 'Linux', arch: 'x86_64' },
      facts.runner,
      'use the real Linux x86_64 runner; Darwin is not Linux evidence',
      mode,
    );
  if (
    !isRecord(facts.xz) ||
    facts.xz.available ||
    facts.xz.installAttempted ||
    facts.xz.invocationDetected ||
    facts.xz.lanePathControlled !== true ||
    facts.xz.pythonLzmaUsed !== true ||
    !isRecord(facts.xz.laneCommandPaths) ||
    XZ_COMMANDS.some((command) => facts.xz.laneCommandPaths[command] !== false)
  )
    return failure(
      'xz-preflight',
      'external-xz-unverifiable',
      {
        available: false,
        installAttempted: false,
        invocationDetected: false,
        lanePathControlled: true,
        laneCommandPaths: Object.fromEntries(XZ_COMMANDS.map((command) => [command, false])),
        pythonLzmaUsed: true,
      },
      facts.xz,
      'run the lane with a controlled PATH that hides xz-family names and uses Python stdlib lzma',
      mode,
    );
  for (const command of XZ_COMMANDS)
    if (!facts.xz.checkedCommands?.includes(command))
      return failure(
        'xz-preflight',
        'missing-command-probe',
        command,
        facts.xz.checkedCommands,
        'probe xz, unxz, and xz-utils before bootstrap',
        mode,
      );
  const cleanup = facts.cleanup;
  if (
    !cleanup?.fbxOutputCleared ||
    !cleanup.codecOutputCleared ||
    !cleanup.consumerCacheCleared ||
    !cleanup.hydrationCleared
  )
    return failure(
      'cleanup',
      'bypass-source-not-cleared',
      {
        fbxOutputCleared: true,
        codecOutputCleared: true,
        consumerCacheCleared: true,
        hydrationCleared: true,
      },
      cleanup,
      'remove consumer outputs, consumer cache, and hydration sources before emcc',
      mode,
    );
  if (mode === 'cold') {
    if (!cleanup.toolchainCacheEmpty)
      return failure(
        'cache',
        'cold-cache-not-empty',
        { toolchainCacheEmpty: true },
        cleanup.toolchainCacheEmpty,
        'clear emsdk-cache before the cold bootstrap',
        mode,
      );
    return null;
  }
  if (!facts.cache || facts.cache.status !== 'exact-valid' || !facts.cache.matchedKey)
    return failure(
      'cache',
      'exact-cache-unavailable',
      { status: 'exact-valid', matchedKey: 'non-empty' },
      facts.cache,
      'restore only the exact cache created by the cold lane',
      mode,
    );
  if (!coldEnvelope || coldEnvelope.status !== 'ready' || coldEnvelope.mode !== 'cold')
    return failure(
      'warm-linkage',
      'cold-envelope-unavailable',
      { status: 'ready', mode: 'cold' },
      coldEnvelope,
      'download the cold evidence envelope before warm validation',
      mode,
    );
  if (coldEnvelope.source.sha !== facts.sourceSha)
    return failure(
      'warm-linkage',
      'source-sha-mismatch',
      facts.sourceSha,
      coldEnvelope.source.sha,
      'use cold and warm evidence from the same fixed checkout',
      mode,
    );
  return null;
}

function bootstrapFacts(path, mode) {
  const bootstrap = readJson(path);
  if (bootstrap.status !== 'ready')
    throw failure(
      'bootstrap',
      'bootstrap-unproven',
      'ready bootstrap evidence',
      bootstrap,
      'fix the Linux no-xz bootstrap before running consumers',
      mode,
    );
  const fingerprint = bootstrap.compilerFingerprint;
  const issue = validateFingerprint(fingerprint, 'bootstrap.compilerFingerprint');
  if (issue)
    throw failure(issue.stage, issue.reason, issue.expected, issue.observed, issue.hint, mode);
  const toolchainLayout = validateBootstrapToolchainLayout(bootstrap.toolchainLayout, mode);
  if (mode === 'cold' && bootstrap.cacheStatus !== 'cold-created')
    throw failure(
      'cache',
      'wrong-cold-cache-status',
      'cold-created',
      bootstrap.cacheStatus,
      'run the cold lane with an empty Emscripten cache',
      mode,
    );
  if (mode === 'warm' && bootstrap.cacheStatus !== 'exact-valid')
    throw failure(
      'cache',
      'wrong-warm-cache-status',
      'exact-valid',
      bootstrap.cacheStatus,
      'restore and validate the exact cold toolchain cache',
      mode,
    );
  if (bootstrap.nodeAuthorityStatus !== 'ready')
    throw failure(
      'node-authority',
      'system-node-unproven',
      'ready .nvmrc/system Node authority',
      bootstrap.nodeAuthorityStatus,
      'validate the .nvmrc system Node on Linux before publishing the cache payload',
      mode,
    );
  const node = normalizeBootstrapNodeAuthority(bootstrap.nodeAuthority, mode);
  if (bootstrap.noXz?.pythonLzma !== 'stdlib')
    throw failure(
      'xz-preflight',
      'python-lzma-unproven',
      { pythonLzma: 'stdlib' },
      bootstrap.noXz,
      'use Python stdlib lzma for tar.xz extraction and record that path',
      mode,
    );
  return { bootstrap, fingerprint, node, toolchainLayout };
}

function validateBootstrapToolchainLayout(layout, mode) {
  const lock = readJson(LOCK_PATH);
  const lockedLayout = lock.toolchainLayout;
  const fields = [
    'installRoot',
    'toolBinRelativePath',
    'binaryenRootRelativePath',
    'emscriptenCacheRelativePath',
    'compilerRelativePath',
    'releaseMarkerRelativePath',
  ];
  if (
    !isRecord(layout) ||
    !isRecord(lockedLayout) ||
    fields.some(
      (field) => typeof layout[field] !== 'string' || layout[field] !== lockedLayout[field],
    )
  )
    throw failure(
      'compiler',
      'toolchain-layout-mismatch',
      lockedLayout,
      layout,
      'use the locked install root and compiler path from the pinned archive',
      mode,
    );
  return layout;
}

function normalizeBootstrapNodeAuthority(node, mode) {
  if (
    isRecord(node) &&
    node.nodeExpectedVersion === '22.22.3' &&
    node.nodeVersion === '22.22.3' &&
    node.nodePath === node.emsdkNode &&
    isAbsolute(node.nodePath) &&
    existsSync(node.nodePath) &&
    statSync(node.nodePath).isFile()
  )
    return { ...node, nodeVersion: 'v22.22.3' };
  throw failure(
    'node-authority',
    'system-node-unproven',
    { version: '22.22.3', samePath: true },
    node,
    'use the .nvmrc system Node for EMSDK_NODE',
    mode,
  );
}

function cacheFacts(bootstrap, cacheDir, mode) {
  const markerPath = join(cacheDir, 'complete.json');
  const marker = readJson(markerPath);
  if (marker.status === 'rejected')
    throw failure(
      'cache',
      'cache-marker-unreadable',
      { complete: true },
      marker,
      'discard the cache and rerun the Linux cold lane',
      mode,
    );
  if (marker.complete !== true || !isRecord(marker.compilerFingerprint))
    throw failure(
      'cache',
      'cache-marker-incomplete',
      { complete: true },
      marker,
      'discard partial cache contents before consumers',
      mode,
    );
  for (const field of FINGERPRINT_FIELDS)
    if (marker.compilerFingerprint[field] !== bootstrap.compilerFingerprint[field])
      throw failure(
        'cache',
        'cache-fingerprint-mismatch',
        bootstrap.compilerFingerprint,
        marker.compilerFingerprint,
        'discard the stale cache and rerun cold',
        mode,
      );
  return {
    status: mode === 'cold' ? 'cold-created' : 'exact-valid',
    key: bootstrap.cacheKey || bootstrap.expectedCacheKey || 'emscripten-no-xz-exact',
    matchedKey:
      mode === 'warm'
        ? bootstrap.cacheKey || bootstrap.expectedCacheKey || 'emscripten-no-xz-exact'
        : null,
    fingerprint: bootstrap.compilerFingerprint,
  };
}

function findEmcc(cacheDir, toolchainLayout) {
  const candidate = join(
    cacheDir,
    toolchainLayout.installRoot,
    toolchainLayout.compilerRelativePath,
  );
  if (existsSync(candidate) && statSync(candidate).isFile()) return resolve(candidate);
  throw failure(
    'compiler',
    'emcc-unavailable',
    'usable emcc path',
    candidate,
    'restore the exact Emscripten cache with its locked install/emscripten/emcc compiler',
  );
}

function makeEmccWrapper(realEmcc, mode) {
  const dir = os.tmpdir();
  const root = join(dir, `forgeax-emcc-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const logPath = join(root, 'invocations.jsonl');
  const wrapperPath = join(root, 'emcc');
  const wrapper = join(root, 'wrapper.mjs');
  writeFileSync(
    wrapper,
    `import { appendFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst args = process.argv.slice(2);\nconst result = spawnSync(${JSON.stringify(realEmcc)}, args, { stdio: 'inherit' });\nappendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ consumer: process.env.FORGEAX_EVIDENCE_CONSUMER, mode: ${JSON.stringify(mode)}, command: ['emcc', ...args], exitCode: result.status ?? 1 }) + '\\n');\nprocess.exit(result.status ?? 1);\n`,
    'utf8',
  );
  writeFileSync(
    wrapperPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)} "$@"\n`,
    'utf8',
  );
  execFileSync('chmod', ['+x', wrapperPath]);
  return { root, wrapperPath, logPath };
}

function buildToolchainEnvironment(
  wrapper,
  cacheDir,
  toolchainLayout,
  node,
  evidenceDir,
  lanePath = process.env.PATH || '',
  lanePathControlled = false,
) {
  const toolchainRoot = resolve(cacheDir, toolchainLayout.installRoot);
  const emsdkRoot = dirname(toolchainRoot);
  const nodeBin = dirname(node.emsdkNode);
  const toolBin = join(toolchainRoot, 'node_modules/.bin');
  const installBin = resolve(cacheDir, toolchainLayout.toolBinRelativePath);
  const binaryenRoot = resolve(cacheDir, toolchainLayout.binaryenRootRelativePath);
  const emscriptenCache = resolve(cacheDir, toolchainLayout.emscriptenCacheRelativePath);
  const configPath = join(evidenceDir, 'diagnostics/emscripten-config.py');
  return {
    ...process.env,
    EMSDK: emsdkRoot,
    EMSCRIPTEN: toolchainRoot,
    EMSCRIPTEN_ROOT: toolchainRoot,
    EMSDK_NODE: node.emsdkNode,
    EM_CONFIG: configPath,
    EM_CACHE: emscriptenCache,
    EM_LLVM_ROOT: installBin,
    EM_BINARYEN_ROOT: binaryenRoot,
    PATH: lanePathControlled
      ? lanePath
      : `${dirname(wrapper.wrapperPath)}:${nodeBin}:${installBin}:${toolBin}:${toolchainRoot}:${lanePath}`,
    configPath,
    emscriptenCache,
    llvmRoot: installBin,
    binaryenRoot,
  };
}

function writeEmscriptenConfig(environment, node) {
  mkdirSync(dirname(environment.configPath), { recursive: true });
  writeFileSync(
    environment.configPath,
    `LLVM_ROOT = ${JSON.stringify(environment.llvmRoot)}\nBINARYEN_ROOT = ${JSON.stringify(environment.binaryenRoot)}\nNODE_JS = ${JSON.stringify(node.emsdkNode)}\nCACHE = ${JSON.stringify(environment.emscriptenCache)}\n`,
    'utf8',
  );
}

function buildConsumerEnvironment(
  consumer,
  wrapper,
  mode,
  cacheDir,
  toolchainLayout,
  node,
  evidenceDir,
  lanePath = process.env.PATH || '',
  lanePathControlled = false,
) {
  const packageName = consumer === 'fbx' ? '@forgeax/engine-fbx' : '@forgeax/engine-codec';
  const environment = buildToolchainEnvironment(
    wrapper,
    cacheDir,
    toolchainLayout,
    node,
    evidenceDir,
    lanePath,
    lanePathControlled,
  );
  writeEmscriptenConfig(environment, node);
  return {
    ...environment,
    FORGEAX_EVIDENCE_CONSUMER: consumer,
    FORGEAX_EVIDENCE_MODE: mode,
    FORGEAX_EVIDENCE_PACKAGE: packageName,
  };
}

function boundedDiagnostic(value) {
  const text = typeof value === 'string' ? value : '';
  return {
    text: text.slice(0, MAX_DIAGNOSTIC_BYTES),
    truncated: text.length > MAX_DIAGNOSTIC_BYTES,
  };
}

function diagnosticEnvironment(environment) {
  return {
    EMSDK: environment.EMSDK,
    EMSCRIPTEN: environment.EMSCRIPTEN,
    EMSCRIPTEN_ROOT: environment.EMSCRIPTEN_ROOT,
    EMSDK_NODE: environment.EMSDK_NODE,
    EM_CONFIG: environment.EM_CONFIG,
    EM_CACHE: environment.EM_CACHE,
    EM_LLVM_ROOT: environment.EM_LLVM_ROOT,
    EM_BINARYEN_ROOT: environment.EM_BINARYEN_ROOT,
    PATH: environment.PATH,
  };
}

function runCompilerPreflight(realEmcc, environment, evidenceDir) {
  const result = spawnSync(realEmcc, ['--version'], {
    cwd: REPO_ROOT,
    env: environment,
    encoding: 'utf8',
    maxBuffer: MAX_DIAGNOSTIC_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = boundedDiagnostic(result.stdout);
  const stderr = boundedDiagnostic(result.stderr);
  const diagnosticPath = 'diagnostics/compiler-preflight.json';
  const diagnostic = {
    schemaVersion: 1,
    command: [realEmcc, '--version'],
    exitCode: result.status ?? 1,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    spawnError: result.error?.message || null,
    environment: diagnosticEnvironment(environment),
  };
  let diagnosticWriteError = null;
  try {
    writeJson(join(evidenceDir, diagnosticPath), diagnostic);
  } catch (error) {
    diagnosticWriteError = String(error);
  }
  return {
    command: [realEmcc, '--version'],
    exitCode: result.status ?? 1,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    spawnError: result.error?.message || null,
    diagnosticPath,
    diagnosticWriteError,
  };
}

function runConsumer(
  consumer,
  wrapper,
  mode,
  cacheDir,
  toolchainLayout,
  node,
  evidenceDir,
  lanePath = process.env.PATH || '',
  lanePathControlled = false,
  pnpmCommand = 'pnpm',
) {
  const packageName = consumer === 'fbx' ? '@forgeax/engine-fbx' : '@forgeax/engine-codec';
  const environment = buildConsumerEnvironment(
    consumer,
    wrapper,
    mode,
    cacheDir,
    toolchainLayout,
    node,
    evidenceDir,
    lanePath,
    lanePathControlled,
  );
  const result = spawnSync(pnpmCommand, ['-F', packageName, 'build:wasm'], {
    cwd: REPO_ROOT,
    env: environment,
    encoding: 'utf8',
    maxBuffer: MAX_DIAGNOSTIC_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = boundedDiagnostic(result.stdout);
  const stderr = boundedDiagnostic(result.stderr);
  const diagnosticPath = `diagnostics/${consumer}.json`;
  const diagnostic = {
    schemaVersion: 1,
    consumer,
    command: ['pnpm', '-F', packageName, 'build:wasm'],
    exitCode: result.status ?? 1,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    spawnError: result.error?.message || null,
    environment: diagnosticEnvironment(environment),
  };
  let diagnosticWriteError = null;
  try {
    writeJson(join(evidenceDir, diagnosticPath), diagnostic);
  } catch (error) {
    diagnosticWriteError = String(error);
  }
  return {
    consumer,
    command: ['pnpm', '-F', packageName, 'build:wasm'],
    exitCode: result.status ?? 1,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    spawnError: result.error?.message || null,
    diagnosticPath,
    diagnosticWriteError,
  };
}

function readInvocations(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((entry, index) => ({ id: `${entry.consumer}-${index + 1}`, ...entry }));
}

function sha256(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return `sha256:${hash.digest('hex')}`;
}

function collectOutputs() {
  const files = [];
  for (const consumer of REQUIRED_CONSUMERS) {
    for (const path of OUTPUTS[consumer]) {
      const packagePath = consumer === 'fbx' ? 'packages/fbx' : 'packages/codec';
      const absolute = join(REPO_ROOT, packagePath, path);
      if (!existsSync(absolute) || statSync(absolute).size === 0)
        throw failure(
          'output-digest',
          'missing-or-empty-output',
          path,
          existsSync(absolute) ? 'empty' : 'missing',
          'run the existing consumer build and record every glue and wasm output',
        );
      files.push({ consumer, name: path, outputSha256: sha256(absolute) });
    }
  }
  return files;
}

function compareEvidence(cold, warm) {
  const fingerprintEqual = FINGERPRINT_FIELDS.every(
    (field) => cold.compiler.fingerprint[field] === warm.compiler.fingerprint[field],
  );
  const coldFiles = new Map(cold.output.files.map((file) => [file.name, file.outputSha256]));
  const warmFiles = new Map(warm.output.files.map((file) => [file.name, file.outputSha256]));
  const outputEqual =
    coldFiles.size === warmFiles.size &&
    [...coldFiles].every(([name, hash]) => warmFiles.get(name) === hash);
  const nodeEqual = ['expectedVersion', 'nodeVersion', 'executableSha256'].every(
    (field) => cold.node[field] === warm.node[field],
  );
  return {
    equivalent: fingerprintEqual && outputEqual && nodeEqual,
    fingerprintEqual,
    outputEqual,
    nodeEqual,
    coldOutputCount: coldFiles.size,
    warmOutputCount: warmFiles.size,
  };
}

function buildEnvelope(
  mode,
  sourceSha,
  runner,
  xz,
  cache,
  compiler,
  node,
  invocations,
  gates,
  outputFiles,
  runId,
) {
  const consumers = REQUIRED_CONSUMERS.map((name) => ({
    name,
    invocationIds: invocations
      .filter((invocation) => invocation.consumer === name)
      .map((invocation) => invocation.id),
    outputNames: OUTPUTS[name],
    gateIds: [`${name}-build`],
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'ready',
    mode,
    source: { sha: sourceSha, repository: 'forgeax-engine' },
    run: {
      id: runId,
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1),
      workflow: 'emscripten-no-xz-evidence',
    },
    runner,
    xz: {
      checkedCommands: xz.checkedCommands,
      available: xz.available,
      installAttempted: xz.installAttempted,
      invocationDetected: xz.invocationDetected,
      lanePathControlled: xz.lanePathControlled,
      laneCommandPaths: xz.laneCommandPaths,
      hostCommandPaths: xz.hostCommandPaths,
      hostPackageStatus: xz.hostPackageStatus,
      pythonLzmaUsed: xz.pythonLzmaUsed,
    },
    cache,
    compiler,
    node: {
      expectedVersion: node.nodeExpectedVersion,
      nodeVersion: node.nodeVersion,
      nodePath: node.nodePath,
      emsdkNode: node.emsdkNode,
      executableSha256: sha256(node.nodePath),
      bundledNodePaths: [],
    },
    emcc: { invocations },
    consumer: consumers,
    output: { files: outputFiles },
    gate: { results: gates },
  };
}

function deriveSummary(envelope, comparison = null) {
  return {
    schemaVersion: envelope.schemaVersion,
    status: envelope.status,
    mode: envelope.mode,
    sourceSha: envelope.source.sha,
    runId: envelope.run.id,
    runnerOs: envelope.runner.os,
    runnerArch: envelope.runner.arch,
    cacheStatus: envelope.cache.status,
    consumerCount: envelope.consumer.length,
    outputCount: envelope.output.files.length,
    gateCount: envelope.gate.results.length,
    emccInvocationCount: envelope.emcc.invocations.length,
    compilerFingerprint: envelope.compiler.fingerprint,
    nodeIdentity: {
      expectedVersion: envelope.node.expectedVersion,
      nodeVersion: envelope.node.nodeVersion,
      executableSha256: envelope.node.executableSha256,
    },
    ...(comparison ? { comparison } : {}),
  };
}

function preflightOnly(args) {
  if (process.env.FORGEAX_EVIDENCE_TEST_PREFLIGHT !== '1')
    return rejected(
      'cli',
      'preflight-only-disabled',
      'runtime preflight',
      'test-only mode',
      'run the cold or warm lane on the real Linux runner',
    );
  const facts = readJson(args.preflightOnly);
  const cold = args.coldEvidence ? readJson(args.coldEvidence) : null;
  const issue = checkPreflight(facts, args.mode, cold);
  if (issue) return issue;
  return {
    status: 'ready',
    mode: args.mode,
    source: { sha: facts.sourceSha, repository: 'forgeax-engine' },
    runner: facts.runner,
    xz: facts.xz,
    cleanup: facts.cleanup,
    cache: facts.cache || { status: 'cold-created' },
    ...(cold ? { coldEvidence: cold } : {}),
  };
}

function parseArgs(argv) {
  const args = {
    mode: null,
    evidenceDir: null,
    coldEvidence: null,
    validate: null,
    preflightOnly: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') args.help = true;
    else if (value === '--mode') args.mode = argv[++index] || null;
    else if (value === '--evidence-dir') args.evidenceDir = argv[++index] || null;
    else if (value === '--cold-evidence') args.coldEvidence = argv[++index] || null;
    else if (value === '--validate') args.validate = argv[++index] || null;
    else if (value === '--preflight-only') args.preflightOnly = argv[++index] || null;
    else
      return rejected(
        'cli',
        'unknown-argument',
        'supported evidence arguments',
        value,
        'run with --help for the evidence runner entry point',
      );
  }
  return args;
}

function runLane(args) {
  const mode = args.mode;
  if (!['cold', 'warm'].includes(mode) || !args.evidenceDir)
    throw failure(
      'cli',
      'missing-lane-input',
      '--mode cold|warm and --evidence-dir <dir>',
      args,
      'pass the exact evidence lane arguments from the workflow',
      mode,
    );
  const evidenceDir = resolve(args.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });
  const runner = runtimeRunner();
  if (runner.os !== 'Linux' || runner.arch !== 'x86_64')
    throw failure(
      'runner',
      'unsupported-runner',
      { os: 'Linux', arch: 'x86_64' },
      runner,
      'do not use a Darwin result as Linux evidence; run on Linux x86_64',
      mode,
    );
  const sourceSha = fixedSourceSha();
  const hostPath = process.env.PATH || '';
  const pnpmCommand = commandPath('pnpm', hostPath);
  if (!pnpmCommand)
    throw failure(
      'consumer',
      'pnpm-unavailable',
      'stable pnpm command path',
      null,
      'run pnpm/action-setup before entering the controlled evidence lane',
      mode,
    );
  let controlledPath = null;
  let wrapper = null;
  try {
    const bootstrapPath = join(evidenceDir, 'bootstrap.json');
    const { bootstrap, fingerprint, node, toolchainLayout } = bootstrapFacts(bootstrapPath, mode);
    const cleanup = clearConsumerSources(mode);
    const cacheDir = resolve(process.env.FORGEAX_EMSDK_CACHE_DIR || join(REPO_ROOT, 'emsdk-cache'));
    const cold = mode === 'warm' ? readJson(resolve(args.coldEvidence || '')) : null;
    const cache = cacheFacts(bootstrap, cacheDir, mode);
    if (mode === 'warm') {
      if (
        cold.cache.status !== 'cold-created' ||
        cold.cache.key !== cache.key ||
        cache.matchedKey !== cold.cache.key
      ) {
        throw failure(
          'warm-linkage',
          'cache-key-not-linked-to-cold',
          {
            coldCacheStatus: 'cold-created',
            coldCacheKey: cold.cache.key,
            warmMatchedKey: cold.cache.key,
          },
          {
            coldCacheStatus: cold.cache.status,
            coldCacheKey: cold.cache.key,
            warmCacheKey: cache.key,
            warmMatchedKey: cache.matchedKey,
          },
          'restore the exact toolchain cache produced by the cold lane before running warm',
          mode,
        );
      }
    }
    const realEmcc = findEmcc(cacheDir, toolchainLayout);
    wrapper = makeEmccWrapper(realEmcc, mode);
    controlledPath = createControlledLanePath(hostPath, [
      dirname(wrapper.wrapperPath),
      dirname(node.emsdkNode),
      resolve(cacheDir, toolchainLayout.toolBinRelativePath),
      resolve(cacheDir, toolchainLayout.binaryenRootRelativePath),
      resolve(cacheDir, toolchainLayout.installRoot),
      join(resolve(cacheDir, toolchainLayout.installRoot), 'node_modules/.bin'),
    ]);
    const xz = probeXz({
      lanePath: controlledPath.path,
      hostPath,
      pythonLzmaUsed: bootstrap.noXz?.pythonLzma === 'stdlib',
    });
    const facts = {
      sourceSha,
      runner,
      xz,
      cleanup: { ...cleanup, toolchainCacheEmpty: mode === 'cold' },
      cache: {
        status: bootstrap.cacheStatus,
        matchedKey: bootstrap.cacheKey || bootstrap.expectedCacheKey || null,
      },
    };
    const issue = checkPreflight(facts, mode, cold);
    if (issue) throw issue;
    const compilerEnvironment = buildConsumerEnvironment(
      'preflight',
      wrapper,
      mode,
      cacheDir,
      toolchainLayout,
      node,
      evidenceDir,
      controlledPath.path,
      true,
    );
    const compilerPreflight = runCompilerPreflight(realEmcc, compilerEnvironment, evidenceDir);
    if (compilerPreflight.exitCode !== 0)
      throw failure(
        'compiler',
        'emcc-preflight-failed',
        { exitCode: 0 },
        compilerPreflight,
        'inspect diagnostics/compiler-preflight.json for the locked compiler environment failure',
        mode,
      );
    const gates = [
      runConsumer(
        'fbx',
        wrapper,
        mode,
        cacheDir,
        toolchainLayout,
        node,
        evidenceDir,
        controlledPath.path,
        true,
        pnpmCommand,
      ),
      runConsumer(
        'codec',
        wrapper,
        mode,
        cacheDir,
        toolchainLayout,
        node,
        evidenceDir,
        controlledPath.path,
        true,
        pnpmCommand,
      ),
    ];
    if (gates.some((gate) => gate.exitCode !== 0))
      throw failure(
        'gate',
        'consumer-build-failed',
        { exitCode: 0 },
        gates,
        'inspect the failing existing fbx or codec build gate and rerun the lane',
        mode,
      );
    const invocations = readInvocations(wrapper.logPath);
    const outputFiles = collectOutputs();
    const compiler = {
      emscriptenVersion: fingerprint.emscriptenVersion,
      releaseIdentity: fingerprint.releaseIdentity,
      emccPath: realEmcc,
      fingerprint,
    };
    const gateResults = gates.map((gate) => ({
      id: `${gate.consumer}-build`,
      consumer: gate.consumer,
      name: gate.command.join(' '),
      status: 'pass',
    }));
    let envelope = buildEnvelope(
      mode,
      sourceSha,
      runner,
      xz,
      cache,
      compiler,
      node,
      invocations,
      gateResults,
      outputFiles,
      process.env.GITHUB_RUN_ID || `${mode}-${Date.now()}`,
    );
    const validationIssue = validateEnvelope(envelope);
    if (validationIssue)
      throw failure(
        validationIssue.stage,
        validationIssue.reason,
        validationIssue.expected,
        validationIssue.observed,
        validationIssue.hint,
        mode,
      );
    let comparison = null;
    if (mode === 'warm') {
      const coldIssue = validateEnvelope(cold, { nodePathMode: 'portable' });
      if (coldIssue)
        throw failure(
          'warm-linkage',
          'cold-envelope-invalid',
          coldIssue,
          cold,
          'use the schema-valid cold envelope produced by this feature',
          mode,
        );
      comparison = compareEvidence(cold, envelope);
      if (!comparison.equivalent)
        throw failure(
          'warm-comparison',
          'cold-warm-not-equivalent',
          { equivalent: true },
          comparison,
          'inspect compiler, Node, or output SHA drift before claiming warm equivalence',
          mode,
        );
      envelope = { ...envelope, comparison };
    }
    writeJson(join(evidenceDir, 'evidence.json'), envelope);
    writeJson(join(evidenceDir, 'summary.json'), deriveSummary(envelope, comparison));
    writeJson(join(evidenceDir, 'manifest.json'), {
      schemaVersion: 1,
      mode,
      evidence: 'evidence.json',
      summary: 'summary.json',
      sourceSha,
      outputFiles: outputFiles.map((file) => file.name),
      outputSha256: outputFiles,
      emccInvocationCount: invocations.length,
      consumers: REQUIRED_CONSUMERS,
      diagnostics: [
        'diagnostics/compiler-preflight.json',
        ...gates.map((gate) => gate.diagnosticPath),
      ],
      ...(comparison ? { comparison } : {}),
    });
    return envelope;
  } finally {
    if (wrapper) rmSync(wrapper.root, { recursive: true, force: true });
    if (controlledPath) rmSync(controlledPath.root, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.validate) {
    const envelope = readJson(resolve(args.validate));
    const issue = envelope.status === 'rejected' ? envelope : validateEnvelope(envelope);
    if (issue) {
      process.stdout.write(`${JSON.stringify(issue)}\n`);
      return 1;
    }
    process.stdout.write(
      `${JSON.stringify({ status: 'ready', envelope, summary: deriveSummary(envelope, envelope.comparison || null) })}\n`,
    );
    return 0;
  }
  if (args.preflightOnly) {
    const result = preflightOnly(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'ready' ? 0 : 2;
  }
  try {
    const envelope = runLane(args);
    process.stdout.write(
      `${JSON.stringify({ status: 'ready', mode: envelope.mode, evidence: join(resolve(args.evidenceDir), 'evidence.json'), outputCount: envelope.output.files.length, emccInvocationCount: envelope.emcc.invocations.length })}\n`,
    );
    return 0;
  } catch (error) {
    const result =
      error?.status === 'blocked'
        ? error
        : failure(
            'runner',
            'evidence-run-failed',
            'ready evidence envelope',
            String(error),
            'inspect the structured failure and rerun after restoring Linux prerequisites',
            args.mode,
          );
    if (args.evidenceDir) {
      try {
        writeJson(join(resolve(args.evidenceDir), 'blocked.json'), result);
      } catch {
        /* preserve the primary structured failure */
      }
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 2;
  }
}

if (resolve(process.argv[1] || '') === resolve(SCRIPT_PATH)) process.exitCode = main();

export {
  checkPreflight,
  compareEvidence,
  createControlledLanePath,
  deriveSummary,
  normalizeBootstrapNodeAuthority,
  probeXz,
  runCompilerPreflight,
  runConsumer,
  validateBootstrapToolchainLayout,
  validateEnvelope,
};
