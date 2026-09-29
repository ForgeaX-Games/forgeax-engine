#!/usr/bin/env node

// Wave1's roster runner owns the 80 canonical frameReceipt gates.  This runner
// executes only the remaining direct Dawn owners that have a useful 60-frame
// (or explicitly smaller Dawn) path, plus its four independent
// assertion/composite gates.  CPU/browser-only and already-canonical paths stay
// in the plan as explicit not-applicable or deduplicated rows.  It never
// manufactures a receipt: each command's stdout/stderr is kept verbatim in a
// per-case log and frame observations are recorded only when the owner emits a
// numeric marker.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const rosterPath = resolve(root, 'scripts/ci/dawn-smoke-roster.json');
const defaultOutputDirectory = resolve(root, 'artifacts/wave1-rendering/additional-smokes');
const minFrames = 60;
const defaultTimeoutMs = 600_000;

function pnpm(packageName, script) {
  return {
    file: 'pnpm',
    args: ['--filter', packageName, script],
    display: `pnpm --filter ${packageName} ${script}`,
  };
}

function nodeScript(scriptPath) {
  return {
    file: process.execPath,
    args: [scriptPath],
    display: `node ${scriptPath}`,
  };
}

const excludedCases = [
  {
    id: 'excluded/hello-dsh-federation/visual',
    package: '@forgeax/hello-dsh-federation',
    path: 'apps/hello/dsh-federation/package.json',
    command: pnpm('@forgeax/hello-dsh-federation', 'smoke'),
    action: 'not-applicable',
    mode: 'specified-smoke',
    framesExpected: null,
    frameObservationPolicy: 'record-only',
    owner: 'package smoke -> @forgeax/engine-dsh test:visual',
    note: 'Browser/DSH external path; it is retained as a recorded omission and is not required by the additional Dawn roster.',
  },
  {
    id: 'excluded/hello-format-tier1/dawn-300',
    package: '@forgeax/hello-format-tier1',
    path: 'apps/hello/format-tier1/package.json',
    command: nodeScript('apps/hello/format-tier1/scripts/smoke-dawn.mjs'),
    mode: 'dawn-300',
    framesExpected: minFrames,
    frameObservationPolicy: 'stdout-required',
    owner: 'apps/hello/format-tier1/scripts/smoke-dawn.mjs',
    note: 'Direct 60-frame imported morph Dawn owner; the historical final-gates wrapper is intentionally outside this focused runner.',
  },
  {
    id: 'excluded/hello-intelligence-worker/gauntlet',
    package: '@forgeax/hello-intelligence-worker',
    path: 'apps/hello/intelligence-worker/package.json',
    command: pnpm('@forgeax/hello-intelligence-worker', 'gauntlet'),
    action: 'not-applicable',
    mode: 'specified-smoke',
    framesExpected: null,
    frameObservationPolicy: 'record-only',
    owner: 'package gauntlet -> M27-M38 browser owner scripts',
    note: 'Browser-only worker gauntlet; no direct Dawn owner is required by this focused roster.',
  },
  {
    id: 'excluded/hello-m1-composition/smoke',
    package: '@forgeax/hello-m1-composition',
    path: 'apps/hello/m1-composition/package.json',
    command: pnpm('@forgeax/hello-m1-composition', 'smoke'),
    action: 'not-applicable',
    mode: 'specified-smoke',
    framesExpected: null,
    frameObservationPolicy: 'record-only',
    owner: 'package smoke -> scripts/smoke.mjs',
    note: 'CPU/ECS composition, schedule, state, input, hierarchy, math, and recovery assertions; no Dawn frame target.',
  },
  {
    id: 'excluded/hello-m2-content-pipeline/smoke',
    package: '@forgeax/hello-m2-content-pipeline',
    path: 'apps/hello/m2-content-pipeline/package.json',
    command: pnpm('@forgeax/hello-m2-content-pipeline', 'smoke'),
    action: 'not-applicable',
    mode: 'specified-smoke',
    framesExpected: null,
    frameObservationPolicy: 'record-only',
    owner: 'package smoke -> content/import/browser recovery composition',
    note: 'Content/import/browser composition with no direct Dawn frame owner; omitted from the focused Dawn runner.',
  },
  {
    id: 'excluded/hello-m3-programmable-rendering/m10-dawn',
    package: '@forgeax/hello-m3-programmable-rendering',
    path: 'apps/hello/m3-programmable-rendering/package.json',
    command: nodeScript('apps/hello/m3-programmable-rendering/scripts/smoke-m10-dawn.mjs'),
    mode: 'dawn-specified',
    framesExpected: null,
    frameObservationPolicy: 'record-only',
    owner: 'apps/hello/m3-programmable-rendering/scripts/smoke-m10-dawn.mjs',
    note: 'Focused direct Dawn plan/recovery/readback owner; it exercises a bounded set of draws rather than a 60-frame loop.',
  },
  {
    id: 'excluded/hello-m4-interactive-simulation/smoke',
    package: '@forgeax/hello-m4-interactive-simulation',
    path: 'apps/hello/m4-interactive-simulation/package.json',
    command: pnpm('@forgeax/hello-m4-interactive-simulation', 'smoke'),
    action: 'not-applicable',
    mode: 'specified-smoke',
    framesExpected: null,
    frameObservationPolicy: 'record-only',
    owner: 'package smoke -> physics/character/audio and bounded lifecycle children',
    note: 'Existing semantic/browser simulation composition with no direct Dawn frame owner.',
  },
  {
    id: 'excluded/hello-m5-interaction-media/smoke',
    package: '@forgeax/hello-m5-interaction-media',
    path: 'apps/hello/m5-interaction-media/package.json',
    action: 'deduplicated',
    command: null,
    mode: 'deduplicated-canonical-children',
    framesExpected: null,
    frameObservationPolicy: 'record-only',
    owner: 'package smoke -> picking/debug-draw/text/tilemap/video child owners',
    note: 'Its direct Dawn children are already represented by canonical roster entries; the broad composite is outside this focused runner.',
  },
  {
    id: 'excluded/hello-m6-inspection-forensics/smoke',
    package: '@forgeax/hello-m6-inspection-forensics',
    path: 'apps/hello/m6-inspection-forensics/package.json',
    command: pnpm('@forgeax/hello-m6-inspection-forensics', 'smoke'),
    action: 'not-applicable',
    mode: 'specified-smoke',
    framesExpected: null,
    frameObservationPolicy: 'record-only',
    owner: 'package smoke -> remote/live/RHI-debug composition',
    note: 'Existing remote/RHI-debug browser composition; tape evidence has its own oracle and no direct Dawn 300 owner is selected here.',
  },
  {
    id: 'excluded/hello-m7-backend-recovery/smoke',
    package: '@forgeax/hello-m7-backend-recovery',
    path: 'apps/hello/m7-backend-recovery/package.json',
    action: 'deduplicated',
    command: null,
    mode: 'deduplicated-canonical-children',
    framesExpected: null,
    frameObservationPolicy: 'record-only',
    owner: 'package smoke -> null/wgpu/browser/Dawn/replay/tree-shake child owners',
    note: 'Its hello-bloom/hello-cube Dawn children overlap canonical receipts; the broad recovery composite is outside this focused runner.',
  },
  {
    id: 'excluded/hello-m8-integrated-capstone/smoke',
    package: '@forgeax/hello-m8-integrated-capstone',
    path: 'apps/hello/m8-integrated-capstone/package.json',
    command: nodeScript('apps/hello/m8-integrated-capstone/scripts/smoke-dawn.mjs'),
    mode: 'dawn-300-source-declared',
    framesExpected: null,
    declaredNestedFrames: minFrames,
    frameObservationPolicy: 'record-only',
    owner: 'apps/hello/m8-integrated-capstone/scripts/smoke-dawn.mjs',
    note: 'Direct Dawn shared-scene owner loops for 60 frames, but emits only a PASS line without a numeric frame count or canonical receipt; the observation gap is preserved.',
  },
  {
    id: 'excluded/hello-multithreaded-execution/gauntlet',
    package: '@forgeax/hello-multithreaded-execution',
    path: 'apps/hello/multithreaded-execution/package.json',
    command: pnpm('@forgeax/hello-multithreaded-execution', 'gauntlet'),
    action: 'not-applicable',
    mode: 'specified-smoke',
    framesExpected: null,
    frameObservationPolicy: 'record-only',
    owner: 'package gauntlet -> smoke-browser --gauntlet',
    note: 'Browser-only execution-tier owner; no direct Dawn frame path is selected here.',
  },
  {
    id: 'excluded/hello-physical-material/smoke',
    package: '@forgeax/hello-physical-material',
    path: 'apps/hello/physical-material/package.json',
    command: nodeScript('apps/hello/physical-material/scripts/smoke-dawn.mjs'),
    mode: 'dawn-300',
    framesExpected: minFrames,
    frameObservationPolicy: 'stdout-required',
    owner: 'package smoke -> scripts/smoke-dawn.mjs',
    note: 'Attempt because the private asset closure is present on this macOS host; the roster exclusion is retained as a portability rule, not an automatic local skip.',
  },
  {
    id: 'excluded/learn-render-1-1/hello-window',
    package: '@forgeax/app-learn-render-1-getting-started-1-hello-window',
    path: 'apps/learn-render/1.getting-started/1.hello-window/package.json',
    command: pnpm('@forgeax/app-learn-render-1-getting-started-1-hello-window', 'smoke'),
    mode: 'dawn-300',
    framesExpected: minFrames,
    frameObservationPolicy: 'stdout-required',
    owner: 'package smoke -> scripts/smoke-dawn.mjs',
    note: 'The package invocation is excluded by the LearnRender subset policy, but its existing Dawn owner is runnable and assets are part of this checkout.',
  },
  {
    id: 'excluded/learn-render-1-2/hello-triangle',
    package: '@forgeax/app-learn-render-1-getting-started-2-hello-triangle',
    path: 'apps/learn-render/1.getting-started/2.hello-triangle/package.json',
    action: 'deduplicated',
    command: null,
    mode: 'deduplicated-canonical-owner',
    framesExpected: minFrames,
    frameObservationPolicy: 'not-run',
    owner: 'apps/learn-render/1.getting-started/2.hello-triangle/scripts/smoke-dawn.mjs',
    note: 'The roster explicitly assigns this visual to apps/hello/triangle, whose canonical frameReceipt is already in the 80-gate runner; do not launch a duplicate Dawn process.',
  },
  {
    id: 'excluded/learn-render-1-3/shaders',
    package: '@forgeax/app-learn-render-1-getting-started-3-shaders',
    path: 'apps/learn-render/1.getting-started/3.shaders/package.json',
    command: pnpm('@forgeax/app-learn-render-1-getting-started-3-shaders', 'smoke'),
    mode: 'dawn-300',
    framesExpected: minFrames,
    frameObservationPolicy: 'stdout-required',
    owner: 'package smoke -> scripts/smoke-dawn.mjs',
    note: 'Existing real-scene unlit shader Dawn owner; browser e2e remains a separate package-owned path.',
  },
  {
    id: 'excluded/learn-render-1-5/transformations',
    package: '@forgeax/app-learn-render-1-getting-started-5-transformations',
    path: 'apps/learn-render/1.getting-started/5.transformations/package.json',
    command: pnpm('@forgeax/app-learn-render-1-getting-started-5-transformations', 'smoke'),
    mode: 'dawn-300',
    framesExpected: minFrames,
    frameObservationPolicy: 'stdout-required',
    owner: 'package smoke -> scripts/smoke-dawn.mjs',
    note: 'Existing wood-texture cube/transform Dawn owner; the package-level browser e2e is not silently substituted.',
  },
  {
    id: 'excluded/learn-render-1-6/coordinate-systems',
    package: '@forgeax/app-learn-render-1-getting-started-6-coordinate-systems',
    path: 'apps/learn-render/1.getting-started/6.coordinate-systems/package.json',
    command: pnpm('@forgeax/app-learn-render-1-getting-started-6-coordinate-systems', 'smoke'),
    mode: 'dawn-300',
    framesExpected: minFrames,
    frameObservationPolicy: 'stdout-required',
    owner: 'package smoke -> scripts/smoke-dawn.mjs',
    note: 'Existing ten-cube coordinate-system Dawn owner; the package-level browser e2e remains distinct.',
  },
  {
    id: 'excluded/learn-render-6-2/ibl-irradiance',
    package: '@forgeax/app-learn-render-6-pbr-2-ibl-irradiance',
    path: 'apps/learn-render/6.pbr/2.ibl-irradiance/package.json',
    command: pnpm('@forgeax/app-learn-render-6-pbr-2-ibl-irradiance', 'smoke'),
    mode: 'dawn-300',
    framesExpected: minFrames,
    frameObservationPolicy: 'stdout-required',
    owner: 'package smoke -> _shared/ibl-smoke-shared.mjs',
    note: 'Run the local macOS 60-frame/reference-PNG owner because assets are present; do not reinterpret its known Linux cross-GPU instability as a skip or as CI proof.',
  },
  {
    id: 'excluded/learn-render-6-3/ibl-specular',
    package: '@forgeax/app-learn-render-6-pbr-3-ibl-specular',
    path: 'apps/learn-render/6.pbr/3.ibl-specular/package.json',
    command: pnpm('@forgeax/app-learn-render-6-pbr-3-ibl-specular', 'smoke'),
    mode: 'dawn-300',
    framesExpected: minFrames,
    frameObservationPolicy: 'stdout-required',
    owner: 'package smoke -> _shared/ibl-smoke-shared.mjs',
    note: 'Run the local macOS 60-frame/reference-PNG owner because assets are present; do not reinterpret its known Linux cross-GPU instability as a skip or as CI proof.',
  },
];

const nonFrameCases = [
  {
    id: 'independent/hello-animation-graph/numerical',
    package: '@forgeax/hello-animation-graph',
    path: 'apps/hello/animation-graph/package.json',
    gateId: 'hello-animation-graph/numerical',
    command: pnpm('@forgeax/hello-animation-graph', 'smoke'),
    mode: 'assertion',
    oracleKind: 'assertion',
    framesExpected: null,
    frameObservationPolicy: 'not-applicable',
    owner: 'package smoke -> scripts/smoke-dawn.mjs',
    note: 'The owner explicitly documents pure numerical AnimationGraph assertions with no WebGPU/GPU/Dawn; do not fabricate a 60-frame result.',
  },
  {
    id: 'independent/hello-custom-shader/composite',
    package: '@forgeax/hello-custom-shader',
    path: 'apps/hello/custom-shader/package.json',
    gateId: 'hello-custom-shader/composite',
    command: pnpm('@forgeax/hello-custom-shader', 'smoke:all'),
    mode: 'composite',
    oracleKind: 'composite',
    framesExpected: null,
    declaredNestedFrames: minFrames,
    frameObservationPolicy: 'record-only',
    owner: 'package smoke:all -> smoke + smoke:browser',
    note: 'The nested Dawn child clears/readbacks for 300 iterations and checks material identity; the top-level gate also has browser coverage and has no canonical receipt.',
  },
  {
    id: 'independent/hello-skin/writeback',
    package: '@forgeax/hello-skin',
    path: 'apps/hello/skin/package.json',
    gateId: 'hello-skin/writeback',
    command: pnpm('@forgeax/hello-skin', 'smoke:writeback'),
    mode: 'assertion',
    oracleKind: 'assertion',
    framesExpected: null,
    frameObservationPolicy: 'not-applicable',
    owner: 'package smoke:writeback -> scripts/smoke-writeback-dawn.mjs',
    note: 'The owner explicitly documents pure scene writeback assertions with no pixel readback or render loop; do not fabricate a 60-frame result.',
  },
  {
    id: 'independent/learn-render-framebuffers/gauntlet',
    package: '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers',
    path: 'apps/learn-render/4.advanced-opengl/5.framebuffers/package.json',
    gateId: 'learn-render-framebuffers/gauntlet',
    command: pnpm('@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers', 'smoke:browser'),
    mode: 'composite-browser',
    oracleKind: 'composite',
    framesExpected: null,
    frameObservationPolicy: 'record-only',
    owner: 'package smoke:browser -> smoke-browser + smoke-browser-cycle',
    note: 'Run the browser-specific portion of the existing gauntlet; the direct Dawn child is separately covered by the canonical frameReceipt gate, and smoke:browser-live is a separate live route.',
  },
];

function readHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function slug(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function commandText(command) {
  return command?.display ?? null;
}

function loadRoster() {
  const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
  const excluded = roster.entries.filter((entry) => entry.classification === 'excluded');
  const excludedByPackage = new Map(excluded.map((entry) => [entry.package, entry]));
  const plannedPackages = new Set(excludedCases.map((entry) => entry.package));
  const rosterPackages = new Set(excluded.map((entry) => entry.package));
  if (
    plannedPackages.size !== rosterPackages.size ||
    [...plannedPackages].some((packageName) => !rosterPackages.has(packageName))
  ) {
    throw new Error('additional smoke plan is stale: excluded package set changed');
  }
  for (const entry of excludedCases) {
    const declared = excludedByPackage.get(entry.package);
    if (declared === undefined || declared.path !== entry.path)
      throw new Error(`additional smoke plan entry drift: ${entry.id}`);
  }

  const independentByGate = new Map();
  for (const entry of roster.entries) {
    for (const gate of entry.gates) {
      if (gate.executionClass === 'independent')
        independentByGate.set(gate.gateId, { entry, gate });
    }
  }
  for (const extra of nonFrameCases) {
    const declared = independentByGate.get(extra.gateId);
    if (
      declared === undefined ||
      declared.entry.package !== extra.package ||
      declared.entry.path !== extra.path ||
      declared.gate.oracle?.kind !== extra.oracleKind
    ) {
      throw new Error(`additional smoke non-frame gate drift: ${extra.id}`);
    }
  }

  const canonicalFrameReceiptGateIds = [];
  const canonicalFrameReceiptPackages = new Set();
  for (const entry of roster.entries) {
    for (const gate of entry.gates) {
      if (gate.executionClass !== 'excluded' && gate.oracle?.kind === 'frameReceipt') {
        canonicalFrameReceiptGateIds.push(gate.gateId);
        canonicalFrameReceiptPackages.add(entry.package);
      }
    }
  }
  return {
    roster,
    excluded,
    canonicalFrameReceiptGateIds: canonicalFrameReceiptGateIds.sort(),
    canonicalFrameReceiptPackages,
  };
}

function buildPlan({ expectedProductSha, rosterInfo, outputDirectory }) {
  const entries = [...excludedCases, ...nonFrameCases].map((entry) => ({
    id: entry.id,
    package: entry.package,
    path: entry.path,
    gateId: entry.gateId ?? null,
    action: entry.action ?? 'run',
    mode: entry.mode,
    oracleKind: entry.oracleKind ?? 'owner-output',
    command: commandText(entry.command),
    owner: entry.owner,
    framesExpected: entry.framesExpected,
    declaredNestedFrames: entry.declaredNestedFrames ?? null,
    frameObservationPolicy: entry.frameObservationPolicy,
    note: entry.note,
  }));
  const runnable = entries.filter((entry) => entry.action === 'run');
  const plannedDawn300 = runnable.filter((entry) => entry.framesExpected === minFrames);
  const plannedSpecified = runnable.filter((entry) => entry.framesExpected === null);
  const notApplicable = entries.filter((entry) => entry.action === 'not-applicable');
  const deduplicated = entries.filter((entry) => entry.action === 'deduplicated');
  return {
    schemaVersion: 1,
    kind: 'wave1-additional-smoke-plan',
    head: readHead(),
    expectedProductSha: expectedProductSha ?? null,
    rosterPath: relative(root, rosterPath),
    rosterDigest: fileSha256(rosterPath),
    minFrames,
    canonicalFrameReceiptCoverage: {
      gateCount: rosterInfo.canonicalFrameReceiptGateIds.length,
      gateIds: rosterInfo.canonicalFrameReceiptGateIds,
      packageCount: rosterInfo.canonicalFrameReceiptPackages.size,
    },
    counts: {
      rosterExcludedEntries: rosterInfo.excluded.length,
      selectedExcludedCommands: excludedCases.filter((entry) => (entry.action ?? 'run') === 'run')
        .length,
      selectedExcludedDawn300: excludedCases.filter(
        (entry) => (entry.action ?? 'run') === 'run' && entry.framesExpected === minFrames,
      ).length,
      selectedExcludedSpecifiedSmoke: excludedCases.filter(
        (entry) => (entry.action ?? 'run') === 'run' && entry.framesExpected === null,
      ).length,
      notApplicableExcludedEntries: notApplicable.length,
      deduplicatedExcludedEntries: deduplicated.length,
      independentNonFrameCommands: nonFrameCases.length,
      totalCommands: runnable.length,
      totalDawn300Commands: plannedDawn300.length,
      totalSpecifiedSmokeCommands: plannedSpecified.length,
    },
    outputDirectory: relative(root, outputDirectory),
    entries,
  };
}

function extractFrameObservations(output) {
  const observations = [];
  const pattern =
    /\b(framesObserved|frameCount|frames?\s+observed|frames?|frame)\b(?:["']\s*)?\s*(?:[:=]|\s+)\s*(\d+)\b/gi;
  for (const line of String(output).split(/\r?\n/)) {
    let match = pattern.exec(line);
    while (match !== null) {
      const value = Number(match[2]);
      observations.push({
        field: match[1],
        value,
        lineSha256: createHash('sha256').update(line).digest('hex'),
        lineExcerpt: line.slice(0, 240),
      });
      match = pattern.exec(line);
    }
    pattern.lastIndex = 0;
  }
  return observations;
}

function canonicalReceiptSummary(output) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('[forgeax-smoke-receipt] '));
  return {
    count: lines.length,
    sha256: lines.map((line) => createHash('sha256').update(line).digest('hex')),
  };
}

function runCommand(command, env, timeoutMs) {
  return new Promise((resolveResult) => {
    const child = spawn(command.file, command.args, {
      cwd: root,
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode, signal, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({ exitCode, signal, output, timedOut, spawnError });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // The process may have exited between the timeout and the group kill.
        }
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.once('error', (error) => {
      output += `\n[wave1-additional] spawn error: ${error.message}\n`;
      finish(null, null, error.message);
    });
    child.once('close', (exitCode, signal) => finish(exitCode, signal));
  });
}

async function runCase(entry, { outputDirectory, timeoutMs }) {
  const caseSlug = slug(entry.id);
  const logPath = resolve(outputDirectory, 'logs', `${caseSlug}.log`);
  const resultPath = resolve(outputDirectory, 'results', `${caseSlug}.json`);
  const artifactDirectory = resolve(outputDirectory, 'artifacts', caseSlug);
  mkdirSync(artifactDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  process.stdout.write(`[wave1-additional] run ${entry.id}: ${entry.command.display}\n`);
  const result = await runCommand(
    entry.command,
    {
      ...process.env,
      INIT_CWD: root,
      SMOKE_MIN_FRAMES: String(minFrames),
      FORGEAX_GAUNTLET_ARTIFACT_DIR: artifactDirectory,
    },
    timeoutMs,
  );
  const durationMs = Date.now() - started;
  const frameObservations = extractFrameObservations(result.output);
  const maxObserved = frameObservations.reduce(
    (max, observation) => Math.max(max, observation.value),
    null,
  );
  const processStatus =
    result.exitCode === 0 && result.signal === null && !result.timedOut ? 'pass' : 'fail';
  const frameStatus =
    entry.framesExpected === null
      ? entry.frameObservationPolicy === 'not-applicable'
        ? 'not-applicable'
        : 'record-only'
      : maxObserved !== null && maxObserved >= entry.framesExpected
        ? 'observed'
        : 'missing-or-short';
  let status = processStatus;
  let failureReason = null;
  if (result.timedOut) failureReason = 'timeout';
  else if (result.spawnError) failureReason = 'spawn-error';
  else if (processStatus === 'fail') failureReason = `exit-${result.exitCode ?? result.signal}`;
  else if (entry.framesExpected !== null && frameStatus !== 'observed') {
    status = 'fail';
    failureReason = 'frame-observation-missing-or-short';
  }
  const receipt = canonicalReceiptSummary(result.output);
  const record = {
    schemaVersion: 1,
    id: entry.id,
    package: entry.package,
    path: entry.path,
    gateId: entry.gateId ?? null,
    mode: entry.mode,
    oracleKind: entry.oracleKind ?? 'owner-output',
    owner: entry.owner,
    command: entry.command.display,
    startedAt,
    durationMs,
    process: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
      status: processStatus,
    },
    frames: {
      expected: entry.framesExpected,
      declaredNested: entry.declaredNestedFrames ?? null,
      observedMax: maxObserved,
      observations: frameObservations,
      status: frameStatus,
    },
    canonicalReceiptLines: receipt,
    status,
    result: status,
    failureReason,
    logPath: relative(outputDirectory, logPath),
    logBytes: Buffer.byteLength(result.output),
    logSha256: createHash('sha256').update(result.output).digest('hex'),
    artifactDirectory: relative(outputDirectory, artifactDirectory),
  };
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, result.output);
  writeJson(resultPath, record);
  return { ...record, resultPath: relative(outputDirectory, resultPath) };
}

function parseCli(argv) {
  const options = {
    mode: 'plan',
    outputDirectory: defaultOutputDirectory,
    expectedProductSha: process.env.EXPECTED_PRODUCT_SHA,
    timeoutMs: Number(process.env.WAVE1_ADDITIONAL_SMOKE_TIMEOUT_MS ?? defaultTimeoutMs),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plan' || arg === '--run') options.mode = arg.slice(2);
    else if (arg === '--output-dir') options.outputDirectory = resolve(root, argv[++index]);
    else if (arg === '--expected-product-sha') options.expectedProductSha = argv[++index];
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') options.mode = 'help';
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new Error(`invalid timeout: ${options.timeoutMs}`);
  return options;
}

function printHelp() {
  process.stdout.write('Usage:\n');
  process.stdout.write(
    '  node scripts/dev-verify/wave1-rendering/run-additional-smokes.mjs --plan\n',
  );
  process.stdout.write(
    '  node scripts/dev-verify/wave1-rendering/run-additional-smokes.mjs --run --expected-product-sha <40-hex>\n',
  );
  process.stdout.write('\n');
  process.stdout.write(
    `--plan resolves excluded owner commands and four non-frame gates without launching them; --run launches each selected owner command with SMOKE_MIN_FRAMES=${minFrames}.\n`,
  );
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.mode === 'help') {
    printHelp();
    return;
  }
  const rosterInfo = loadRoster();
  const actualHead = readHead();
  if (options.expectedProductSha !== undefined && actualHead !== options.expectedProductSha) {
    throw new Error(
      `checked-out product head ${actualHead} does not match expectedProductSha ${options.expectedProductSha}`,
    );
  }
  if (options.mode === 'run' && !/^[0-9a-f]{40}$/.test(options.expectedProductSha ?? '')) {
    throw new Error(
      '--run requires --expected-product-sha or EXPECTED_PRODUCT_SHA with 40 lowercase hex chars',
    );
  }
  const plan = buildPlan({
    expectedProductSha: options.expectedProductSha,
    rosterInfo,
    outputDirectory: options.outputDirectory,
  });
  const planPath = resolve(options.outputDirectory, 'plan.json');
  writeJson(planPath, plan);
  process.stdout.write(
    `[wave1-additional] plan excluded=${plan.counts.rosterExcludedEntries} selected=${plan.counts.totalCommands} ` +
      `dawn300=${plan.counts.totalDawn300Commands} non-frame=${plan.counts.independentNonFrameCommands} ` +
      `deduplicated=${plan.counts.deduplicatedExcludedEntries}\n`,
  );
  process.stdout.write(`[wave1-additional] plan written ${relative(root, planPath)}\n`);
  if (options.mode === 'plan') return;

  const results = [];
  for (const entry of [...excludedCases, ...nonFrameCases]) {
    if ((entry.action ?? 'run') !== 'run') continue;
    results.push(await runCase(entry, options));
  }
  const failed = results.filter((result) => result.status !== 'pass');
  const summary = {
    schemaVersion: 1,
    kind: 'wave1-additional-smoke-run',
    status: failed.length === 0 ? 'pass' : 'fail',
    head: actualHead,
    expectedProductSha: options.expectedProductSha,
    rosterPath: relative(root, rosterPath),
    rosterDigest: plan.rosterDigest,
    minFrames,
    counts: {
      commands: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      dawn300Commands: results.filter((result) => result.frames.expected === minFrames).length,
      dawn300Observed: results.filter(
        (result) => result.frames.expected === minFrames && result.frames.status === 'observed',
      ).length,
      recordOnlyCommands: results.filter((result) => result.frames.status === 'record-only').length,
      nonApplicableCommands: results.filter((result) => result.frames.status === 'not-applicable')
        .length,
      deduplicatedExcludedEntries: excludedCases.filter((entry) => entry.action === 'deduplicated')
        .length,
    },
    results,
    deduplicated: plan.entries.filter((entry) => entry.action === 'deduplicated'),
  };
  const summaryPath = resolve(options.outputDirectory, 'summary.json');
  writeJson(summaryPath, summary);
  process.stdout.write(
    `[wave1-additional] ${summary.status} passed=${summary.counts.passed}/${summary.counts.commands} ` +
      `dawn300-observed=${summary.counts.dawn300Observed}/${summary.counts.dawn300Commands} ` +
      `summary=${relative(root, summaryPath)}\n`,
  );
  if (summary.status !== 'pass') throw new Error('additional smoke coverage failed');
}

try {
  await main();
} catch (error) {
  console.error(`[wave1-additional] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
