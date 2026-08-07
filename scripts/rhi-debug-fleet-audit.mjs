#!/usr/bin/env node
// rhi-debug-fleet-audit.mjs - derive the render/debug candidate fleet from app-owned facts.
//
// This is an admission instrument, not a smoke runner. It deliberately keeps
// candidates whose pressure family or oracle is missing visible as
// `unclassified`; silently dropping them would make the generated roster lie.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const args = { json: false, select: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && argv[i + 1]) args.root = argv[++i];
  else if (argv[i] === '--json') args.json = true;
  else if (argv[i] === '--out' && argv[i + 1]) args.out = argv[++i];
  else if (argv[i] === '--select' && argv[i + 1]) {
    args.select = argv[++i];
  }
}

const root = resolve(args.root ?? process.cwd());
const appsRoot = resolve(root, 'apps');
const CAPTURE_SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx']);
const GENERATED_SOURCE_DIRECTORIES = new Set(['coverage', 'dist', 'node_modules']);
const RENDER_PACKAGES = new Set([
  '@forgeax/engine-render',
  '@forgeax/engine-render-graph',
  '@forgeax/engine-rhi',
  '@forgeax/engine-rhi-debug',
  '@forgeax/engine-rhi-webgpu',
  '@forgeax/engine-rhi-wgpu',
  '@forgeax/engine-runtime',
  '@forgeax/engine-vite-plugin-rhi-debug',
]);

function fail(code, expected, hint) {
  process.stderr.write(
    `[reason] ${code}: ${expected}\n[rerun]  pnpm rhi-debug-fleet --json\n[hint]   ${hint}\n`,
  );
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail('fleet-package-malformed', `${relative(root, path)} is valid JSON`, error.message);
  }
}

function findAppPackageJsons(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  const packagePath = join(dir, 'package.json');
  if (existsSync(packagePath) && dir !== appsRoot) {
    acc.push(packagePath);
    return acc;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.'))
      continue;
    findAppPackageJsons(join(dir, entry.name), acc);
  }
  return acc;
}

function walkSource(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (GENERATED_SOURCE_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkSource(path, files);
    else if (CAPTURE_SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.'))))
      files.push(path);
  }
  return files;
}

function sourceFacts(packageDir) {
  const files = walkSource(packageDir);
  const text = files.map((path) => readFileSync(path, 'utf8')).join('\n');
  const modes = [...text.matchAll(/mode\s*:\s*['"](pixel|structural)['"]/g)].map(
    (match) => match[1],
  );
  return {
    verifyDemoCapture: text.includes('verifyDemoCapture'),
    captureFrame: text.includes('captureFrame'),
    modes: [...new Set(modes)].sort(),
    browserSmoke: /smoke-browser|test:browser|playwright|chromium/.test(text),
  };
}

function dependencies(pkg) {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

function frontDoors(pkg, source) {
  const scripts = pkg.scripts ?? {};
  const depNames = dependencies(pkg);
  return {
    dev: typeof scripts.dev === 'string',
    dawnSmoke: typeof scripts.smoke === 'string',
    browserSmoke:
      Object.keys(scripts).some((name) => name.includes('browser')) || source.browserSmoke,
    rhiDebugPlugin: depNames.has('@forgeax/engine-vite-plugin-rhi-debug'),
    rhiDebugCapture: source.verifyDemoCapture || source.captureFrame,
    gauntletScenario: pkg.forgeax?.gauntletScenario !== undefined,
  };
}

function isRenderEligible(pkg) {
  if (!pkg.scripts?.dev) return false;
  const depNames = dependencies(pkg);
  return [...depNames].some((name) => RENDER_PACKAGES.has(name));
}

function risks(pkg) {
  const declared = pkg.forgeax?.rhiDebug?.riskFamilies;
  if (
    declared !== undefined &&
    (!Array.isArray(declared) ||
      declared.length === 0 ||
      !declared.every((item) => typeof item === 'string' && item))
  ) {
    fail(
      'fleet-rhi-debug-declaration-malformed',
      `${pkg.name}.forgeax.rhiDebug.riskFamilies is a non-empty string array`,
      'declare pressure families beside the app or remove the incomplete declaration',
    );
  }
  if (Array.isArray(declared) && declared.length > 0) {
    return [...new Set(declared)].sort();
  }
  return ['unclassified'];
}

function scenarioRisks(pkg) {
  const declared = pkg.forgeax?.gauntletScenario?.risks;
  if (
    declared !== undefined &&
    (!Array.isArray(declared) || !declared.every((item) => typeof item === 'string' && item))
  ) {
    fail(
      'fleet-scenario-declaration-malformed',
      `${pkg.name}.forgeax.gauntletScenario.risks is a string array`,
      'run pnpm gauntlet audit to validate the complete scenario declaration',
    );
  }
  return Array.isArray(declared) ? [...new Set(declared)].sort() : [];
}

function oracle(pkg, source) {
  const scenario = pkg.forgeax?.gauntletScenario;
  if (scenario?.oracle?.stdoutIncludes?.length) return 'scenario-stdout';
  if (source.modes.includes('pixel')) return 'capture-localized-pixel';
  if (source.modes.includes('structural')) return 'capture-structural';
  if (source.captureFrame) return 'capture-unknown';
  return 'none';
}

function proofRung(frontDoor, oracleName) {
  if (!frontDoor.dev || (!frontDoor.dawnSmoke && !frontDoor.browserSmoke)) return 'unadmitted';
  if (oracleName === 'none' || oracleName === 'capture-unknown') return 'F0';
  if (frontDoor.rhiDebugCapture) return 'F1';
  if (frontDoor.gauntletScenario) return 'F0';
  return 'F0';
}

function candidate(packagePath) {
  const pkg = readJson(packagePath);
  const packageDir = resolve(packagePath, '..');
  const source = sourceFacts(packageDir);
  const frontDoor = frontDoors(pkg, source);
  const riskFamilies = risks(pkg);
  const declaredScenarioRisks = scenarioRisks(pkg);
  const oracleName = oracle(pkg, source);
  const eligible = isRenderEligible(pkg);
  const unclassified = eligible && riskFamilies.includes('unclassified');
  return {
    app: relative(root, packageDir),
    package: pkg.name ?? null,
    eligible,
    riskFamilies,
    scenarioRisks: declaredScenarioRisks,
    frontDoors: Object.entries(frontDoor)
      .filter(([, available]) => available)
      .map(([name]) => name),
    oracle: oracleName,
    proofRung: eligible ? proofRung(frontDoor, oracleName) : 'not-rendering',
    status: !eligible ? 'not-rendering' : unclassified ? 'unclassified' : 'admitted',
    source: {
      packageJson: relative(root, packagePath),
      declaration: pkg.forgeax?.rhiDebug
        ? 'forgeax.rhiDebug'
        : pkg.forgeax?.gauntletScenario
          ? 'forgeax.gauntletScenario'
          : null,
      captureModes: source.modes,
    },
  };
}

function countBy(items, select) {
  const counts = {};
  for (const item of items)
    for (const value of select(item)) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function deriveFleet(inputRoot = root) {
  const packagePaths = findAppPackageJsons(resolve(inputRoot, 'apps'));
  const candidates = packagePaths.map((path) => candidate(path));
  const eligible = candidates.filter((item) => item.eligible);
  return {
    schemaVersion: 1,
    source: 'tracked apps/**/package.json plus app-owned scripts and forgeax declarations',
    candidates,
    summary: {
      appPackages: candidates.length,
      eligible: eligible.length,
      admitted: eligible.filter((item) => item.status === 'admitted').length,
      unclassified: eligible.filter((item) => item.status === 'unclassified').length,
      proofRungs: countBy(eligible, (item) => [item.proofRung]),
      riskFamilies: countBy(eligible, (item) => item.riskFamilies),
      scenarioRisks: countBy(eligible, (item) => item.scenarioRisks),
      oracles: countBy(eligible, (item) => [item.oracle]),
      frontDoors: countBy(eligible, (item) => item.frontDoors),
    },
  };
}

function selectNext(report) {
  const allEligible = report.candidates.filter((item) => item.eligible);
  const captureReady = allEligible.filter((item) => item.frontDoors.includes('rhiDebugCapture'));
  const eligible = captureReady.length > 0 ? captureReady : allEligible;
  const oracleRank = {
    'capture-localized-pixel': 0,
    'capture-structural': 1,
    'scenario-stdout': 2,
    'capture-unknown': 3,
    none: 4,
  };
  eligible.sort(
    (a, b) =>
      Number(a.status !== 'unclassified') - Number(b.status !== 'unclassified') ||
      (oracleRank[a.oracle] ?? 99) - (oracleRank[b.oracle] ?? 99) ||
      a.proofRung.localeCompare(b.proofRung) ||
      a.app.localeCompare(b.app),
  );
  return eligible[0] ?? null;
}

const report = deriveFleet();
if (args.select && args.select !== 'next') {
  fail('fleet-selector-unknown', "--select is 'next'", `got '${args.select}'`);
}
const output = args.select ? { ...report, selection: selectNext(report) } : report;
if (args.json) {
  const json = `${JSON.stringify(output, null, 2)}\n`;
  if (args.out) writeFileSync(resolve(root, args.out), json);
  process.stdout.write(json);
} else {
  process.stdout.write(
    `RHI-debug fleet: ${report.summary.eligible} eligible / ${report.summary.appPackages} app packages; ` +
      `${report.summary.unclassified} unclassified\n`,
  );
  if (args.select) process.stdout.write(`Next: ${output.selection?.app ?? '(none)'}\n`);
}
