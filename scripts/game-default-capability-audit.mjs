#!/usr/bin/env node
// Derive the game-default capability frontier from repository authorities.
// The output is an audit, not a second handwritten feature ledger.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(args.root ?? scriptRoot);
const CLASSIFICATIONS = new Set(['core', 'guided', 'tooling', 'not-template-fit', 'unassessed']);
const outputPath = resolve(
  repoRoot,
  args.output ?? '.forgeax-harness/solo/game-default/audit/capability-audit.json',
);
const baselinePath = args.baseline === undefined ? null : resolve(repoRoot, args.baseline);
const baselineWritePath =
  args.writeBaseline === undefined ? null : resolve(repoRoot, args.writeBaseline);
const adoptionPath = resolve(
  repoRoot,
  args.adoptions ?? 'templates/game-default/capability-adoption.json',
);
const templateRoot = join(repoRoot, 'templates', 'game-default');
const harnessRoot = join(repoRoot, '.forgeax-harness');
const ignoredMissingEvidence = [];

const sources = [];
const candidates = [];

const packageRoot = join(repoRoot, 'packages');
if (existsSync(packageRoot)) {
  for (const entry of sortedDirs(packageRoot)) {
    const manifestPath = join(packageRoot, entry, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    const packageName =
      typeof manifest.name === 'string' ? manifest.name : `@forgeax/engine-${entry}`;
    const readmePath = join(packageRoot, entry, 'README.md');
    const source = addSource(readmePath, 'package-contract');
    const templateProfile = templateImportProfile(packageName, manifest);
    candidates.push({
      id: `package:${packageName}`,
      kind: 'package',
      name: packageName,
      classification: templateProfile.templateImport ? 'core' : 'unassessed',
      sourceProfile: templateProfile,
      evidence: source ? [source] : [],
      reason: templateProfile.templateImport
        ? 'template source imports this public package'
        : 'package contract is authoritative; template reachability still needs a real slice or explicit exclusion',
    });
  }
}

for (const appRoot of ['hello', 'learn-render', 'bevy', 'collectathon', 'multiplayer-snake']) {
  const root = join(repoRoot, 'apps', appRoot);
  if (!existsSync(root)) continue;
  for (const entry of sortedDirs(root)) {
    const manifestPath = join(root, entry, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    const name = typeof manifest.name === 'string' ? manifest.name : entry;
    const source = addSource(manifestPath, 'canonical-app');
    candidates.push({
      id: `app:${appRoot}/${entry}`,
      kind: 'canonical-app',
      name,
      classification: 'unassessed',
      sourceProfile: canonicalAppProfile(manifest),
      evidence: source ? [source] : [],
      reason:
        'executed app is a candidate authority; template composition must be proven separately',
    });
  }
}

const releaseRoot = join(harnessRoot, 'forgeax-loop');
if (existsSync(releaseRoot)) {
  for (const file of walkFiles(releaseRoot, (p) => p.endsWith('judgment-release-notes.md'))) {
    const source = addSource(file, 'feature-loop-release');
    const slug = relative(releaseRoot, dirname(file)).replaceAll('\\', '/');
    candidates.push({
      id: `loop:${slug}`,
      kind: 'feature-loop-release',
      name: slug,
      classification: 'unassessed',
      sourceProfile: { loopType: slug.split('/')[0], releasePath: source },
      evidence: source ? [source] : [],
      reason:
        'shipped loop outcome is a freshness signal; inclusion requires a coherent template user story',
    });
  }
}

const assetReadme = join(repoRoot, 'forgeax-engine-assets', 'README.md');
if (!existsSync(assetReadme)) {
  throw new Error(
    'asset authority is not materialized: forgeax-engine-assets/README.md is missing; ' +
      'run `git submodule update --init --recursive forgeax-engine-assets` from the engine root',
  );
} else {
  const source = addSource(assetReadme, 'asset-authority');
  const assetRoot = dirname(assetReadme);
  const formats = new Set(extractAssetFormats(readFileSync(assetReadme, 'utf8')));
  for (const file of walkFiles(assetRoot, () => true)) {
    const format = assetFormatFromPath(file);
    if (format !== null) formats.add(format);
  }
  for (const format of [...formats].sort()) {
    const fixture = walkFiles(assetRoot, (file) => assetFormatFromPath(file) === format)[0];
    const fixtureSource = fixture === undefined ? null : addSource(fixture, 'asset-fixture');
    candidates.push({
      id: `asset:${format}`,
      kind: 'asset-format',
      name: format,
      classification: 'unassessed',
      sourceProfile: {
        extension: format,
        fixture: fixture === undefined ? null : relative(repoRoot, fixture).replaceAll('\\', '/'),
        sidecar:
          fixture === undefined || !existsSync(`${fixture}.meta.json`)
            ? null
            : relative(repoRoot, `${fixture}.meta.json`).replaceAll('\\', '/'),
      },
      evidence: [source, fixtureSource].filter((value) => value !== null),
      reason:
        'licensed asset authority; source/import/GUID/catalog/runtime/lifecycle proof is required',
    });
  }
}

for (const solo of ['bevy-examples', 'engine-gauntlet', 'fast-robust-ci', 'webgl2-gauntlet']) {
  const roadmap = join(harnessRoot, 'solo', solo, 'ROADMAP.md');
  if (!existsSync(roadmap)) continue;
  const source = addSource(roadmap, 'cross-solo-method');
  candidates.push({
    id: `method:${solo}`,
    kind: 'cross-solo-method',
    name: solo,
    classification: 'tooling',
    sourceProfile: { roadmap: source },
    evidence: source ? [source] : [],
    reason:
      'method source is inherited only as a boundary-matched procedure; its status is not template evidence',
  });
}

const unique = new Map();
for (const candidate of candidates) {
  if (unique.has(candidate.id)) throw new Error(`duplicate derived candidate: ${candidate.id}`);
  unique.set(candidate.id, candidate);
}

const adoption = readAdoption(adoptionPath, unique);
applyAdoption(unique, adoption);
const syntheticId = args.synthetic;
const baselineIds = [...unique.keys()].sort();
const baseline = baselinePath === null ? null : readBaseline(baselinePath);
const baselineCandidateIds = baseline === null ? [] : baseline.candidateIds;
const addedCandidateIds =
  baseline === null ? [] : baselineIds.filter((id) => !baselineCandidateIds.includes(id));
const staleCandidateIds =
  baseline === null
    ? []
    : baselineCandidateIds.filter(
        (id) => !unique.has(id) && !baseline.retiredCandidateIds.includes(id),
      );
const retiredCandidateIds =
  baseline === null ? [] : baseline.retiredCandidateIds.filter((id) => !unique.has(id));
if (args.retire.length > 0) {
  if (baseline === null || baselineWritePath === null) {
    throw new Error('--retire requires --baseline and a writable baseline path');
  }
  for (const id of args.retire) {
    if (!staleCandidateIds.includes(id)) {
      throw new Error(`cannot retire non-stale candidate: ${id}`);
    }
    if (!retiredCandidateIds.includes(id)) retiredCandidateIds.push(id);
  }
  retiredCandidateIds.sort();
}
const syntheticDetected = syntheticId === undefined ? null : !unique.has(syntheticId);
if (syntheticId !== undefined && syntheticDetected) {
  unique.set(syntheticId, {
    id: syntheticId,
    kind: 'synthetic-drift-probe',
    name: syntheticId,
    classification: 'unassessed',
    evidence: [],
    reason: 'synthetic candidate remains visible until a later run classifies it',
  });
}

const audit = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repoCommit: gitHead(repoRoot),
  template: 'templates/game-default',
  authorities: sources,
  candidates: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)),
  summary: summarize([...unique.values()]),
  adoption: adoptionSummary(adoption, [...unique.values()]),
  baseline:
    baseline === null
      ? { requested: false }
      : {
          requested: true,
          path: relative(repoRoot, baselinePath),
          candidateCount: baselineCandidateIds.length,
          addedCandidateIds,
          staleCandidateIds,
          retiredCandidateIds,
          detected: addedCandidateIds.length > 0 || staleCandidateIds.length > 0,
        },
  driftProbe:
    syntheticId === undefined
      ? { requested: false }
      : {
          requested: true,
          candidate: syntheticId,
          baselineCandidateCount: baselineIds.length,
          detected: syntheticDetected,
        },
};

if (syntheticId !== undefined && !syntheticDetected) {
  throw new Error(`synthetic candidate already exists in derived input: ${syntheticId}`);
}

if (baselineWritePath !== null) {
  const nextBaseline = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceCommit: audit.repoCommit,
    candidateIds: baselineIds,
    retiredCandidateIds,
  };
  mkdirSync(dirname(baselineWritePath), { recursive: true });
  writeFileSync(baselineWritePath, `${JSON.stringify(nextBaseline, null, 2)}\n`);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ output: relative(repoRoot, outputPath), ...audit.summary, driftProbe: audit.driftProbe, baseline: audit.baseline, adoption: audit.adoption })}\n`,
);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--root') out.root = argv[++i];
    else if (arg === '--output') out.output = argv[++i];
    else if (arg === '--adoptions') out.adoptions = argv[++i];
    else if (arg === '--synthetic') out.synthetic = argv[++i];
    else if (arg === '--baseline') out.baseline = argv[++i];
    else if (arg === '--write-baseline') out.writeBaseline = argv[++i];
    else if (arg === '--retire') out.retire = [...(out.retire ?? []), argv[++i]];
    else if (arg === '--help') {
      console.log(
        'usage: node scripts/game-default-capability-audit.mjs [--root <repo>] [--output <file>] [--adoptions <file>] [--baseline <file>] [--write-baseline <file>] [--retire <id>] [--synthetic <id>]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  out.retire ??= [];
  return out;
}

function readBaseline(file) {
  if (!existsSync(file)) throw new Error(`baseline file does not exist: ${file}`);
  const value = readJson(file);
  const candidateIds = Array.isArray(value.candidateIds)
    ? value.candidateIds
    : Array.isArray(value.candidates)
      ? value.candidates.map((candidate) => candidate.id)
      : null;
  if (candidateIds === null || candidateIds.some((id) => typeof id !== 'string')) {
    throw new Error(`baseline has no valid candidateIds: ${file}`);
  }
  const retiredCandidateIds = Array.isArray(value.retiredCandidateIds)
    ? value.retiredCandidateIds.filter((id) => typeof id === 'string')
    : [];
  return {
    candidateIds: [...new Set(candidateIds)].sort(),
    retiredCandidateIds: [...new Set(retiredCandidateIds)].sort(),
  };
}

function addSource(file, kind) {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  const path = relative(repoRoot, file).replaceAll('\\', '/');
  sources.push({ path, kind });
  return path;
}

function templateImportProfile(packageName, manifest) {
  const templateFiles = walkFiles(
    templateRoot,
    (file) =>
      file.endsWith('.ts') && !file.includes('/src/__tests__/') && !file.endsWith('.test.ts'),
  );
  const importPaths = [];
  for (const file of templateFiles) {
    const text = readFileSync(file, 'utf8');
    if (
      text.includes(`from '${packageName}'`) ||
      text.includes(`from "${packageName}"`) ||
      text.includes(`import('${packageName}')`)
    ) {
      importPaths.push(relative(repoRoot, file).replaceAll('\\', '/'));
    }
  }
  return {
    templateImport: importPaths.length > 0,
    importPaths,
    declaredDependency: Object.hasOwn(
      { ...manifest.dependencies, ...manifest.devDependencies },
      packageName,
    ),
  };
}

function canonicalAppProfile(manifest) {
  const forgeax = manifest.forgeax ?? {};
  const scenario = forgeax.gauntletScenario;
  return {
    bevyExample: forgeax.bevyExample ?? null,
    gauntletScenario:
      scenario === undefined
        ? null
        : {
            id: scenario.id ?? null,
            domains: scenario.domains ?? [],
            packages: scenario.packages ?? [],
            risks: scenario.risks ?? [],
            frontDoors: scenario.evidence?.frontDoors ?? [],
            evidenceLegs: scenario.evidence?.legs ?? [],
          },
    smokeInvocation: forgeax.smokeInvocation ?? null,
  };
}

function readAdoption(file, candidatesById) {
  if (!existsSync(file)) throw new Error(`adoption declaration not found: ${file}`);
  const value = readJson(file);
  if (value.schemaVersion !== 1 || value.template !== 'templates/game-default') {
    throw new Error(`invalid game-default adoption declaration: ${file}`);
  }
  const rules = value.rules ?? [];
  const declarations = value.declarations ?? [];
  if (!Array.isArray(rules) || !Array.isArray(declarations)) {
    throw new Error('adoption rules and declarations must be arrays');
  }
  const declarationMap = new Map();
  for (const declaration of declarations) {
    validateAdoptionShape(declaration, `declaration ${declaration.id ?? '<missing>'}`);
    validateEvidencePaths(declaration, `declaration ${declaration.id}`);
    if (!candidatesById.has(declaration.id)) {
      throw new Error(`adoption declaration references unknown candidate: ${declaration.id}`);
    }
    if (declarationMap.has(declaration.id)) {
      throw new Error(`duplicate adoption declaration: ${declaration.id}`);
    }
    declarationMap.set(declaration.id, { ...declaration, source: 'declaration' });
  }
  for (const rule of rules) {
    validateAdoptionShape(rule, `rule ${rule.id ?? '<missing>'}`);
    validateEvidencePaths(rule, `rule ${rule.id}`);
  }
  return { path: file, rules, declarationMap };
}

function validateAdoptionShape(value, label) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') {
    throw new Error(`${label} must declare a stable id`);
  }
  if (!CLASSIFICATIONS.has(value.classification) || value.classification === 'unassessed') {
    throw new Error(`${label} has an invalid adoption classification`);
  }
  if (value.classification === 'not-template-fit') {
    if (typeof value.reason !== 'string' || typeof value.betterConsumer !== 'string') {
      throw new Error(`${label} not-template-fit requires reason and betterConsumer`);
    }
  } else if (!isNonEmptyStrings(value.frontDoors) || !isNonEmptyStrings(value.evidence)) {
    throw new Error(`${label} requires non-empty frontDoors and evidence`);
  }
  if (value.match !== undefined && (!value.match || typeof value.match !== 'object')) {
    throw new Error(`${label} match must be an object`);
  }
}

function validateEvidencePaths(value, label) {
  for (const evidence of value.evidence ?? []) {
    if (!evidence.includes('/') || existsSync(join(repoRoot, evidence))) continue;
    if (isIgnoredPath(evidence)) {
      ignoredMissingEvidence.push({ label, path: evidence });
      continue;
    }
    if (evidence.includes('/')) {
      throw new Error(`${label} evidence path does not exist: ${evidence}`);
    }
  }
}

function isIgnoredPath(path) {
  try {
    execFileSync('git', ['-C', repoRoot, 'check-ignore', '--no-index', '--quiet', '--', path], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function applyAdoption(candidatesById, adoption) {
  for (const candidate of candidatesById.values()) {
    const declaration = adoption.declarationMap.get(candidate.id);
    const matches = adoption.rules.filter((rule) => matchesRule(candidate, rule.match ?? {}));
    if (declaration && matches.length > 0) {
      throw new Error(`adoption declaration conflicts with rule for ${candidate.id}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `multiple adoption rules match ${candidate.id}: ${matches.map((rule) => rule.id).join(', ')}`,
      );
    }
    const selected = declaration ?? matches[0];
    if (selected === undefined) {
      candidate.adoption = { status: 'missing' };
      continue;
    }
    candidate.classification = selected.classification;
    candidate.adoption = {
      status: 'declared',
      source: selected.source ?? 'rule',
      id: selected.id,
      frontDoors: selected.frontDoors,
      evidence: selected.evidence,
      reason: selected.reason,
      betterConsumer: selected.betterConsumer,
    };
  }
}

function matchesRule(candidate, match) {
  return Object.entries(match).every(([key, expected]) => {
    const actual = key in candidate ? candidate[key] : candidate.sourceProfile?.[key];
    return actual === expected;
  });
}

function adoptionSummary(adoption, candidates) {
  const declared = candidates.filter((candidate) => candidate.adoption?.status === 'declared');
  const missing = candidates.filter((candidate) => candidate.adoption?.status === 'missing');
  return {
    requested: true,
    path: relative(repoRoot, adoption.path).replaceAll('\\', '/'),
    declarationCount: adoption.declarationMap.size,
    ruleCount: adoption.rules.length,
    declaredCount: declared.length,
    missingCandidateIds: missing.map((candidate) => candidate.id).sort(),
    detected: missing.length > 0,
    ignoredMissingEvidence,
  };
}

function isNonEmptyStrings(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length > 0)
  );
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sortedDirs(root) {
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort();
}

function walkFiles(root, predicate) {
  const files = [];
  for (const name of readdirSync(root).sort()) {
    if (name === 'node_modules') continue;
    const file = join(root, name);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (stat.isDirectory()) files.push(...walkFiles(file, predicate));
    else if (predicate(file)) files.push(file);
  }
  return files;
}

function extractAssetFormats(text) {
  const formats = new Set();
  for (const match of text.matchAll(
    /\.(glb|gltf|fbx|hdr|ktx2|png|jpg|jpeg|webp|wav|ogg|mp3|mp4|webm|ttf|otf)\b/gi,
  )) {
    formats.add(match[1].toLowerCase());
  }
  return [...formats].sort();
}

function assetFormatFromPath(file) {
  const match = file.match(
    /\.(glb|gltf|fbx|hdr|ktx2|png|jpg|jpeg|webp|wav|ogg|mp3|mp4|webm|ttf|otf)$/i,
  );
  return match?.[1].toLowerCase() ?? null;
}

function summarize(items) {
  return items.reduce(
    (counts, item) => {
      counts[item.classification] = (counts[item.classification] ?? 0) + 1;
      return counts;
    },
    { core: 0, guided: 0, tooling: 0, 'not-template-fit': 0, unassessed: 0 },
  );
}

function gitHead(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
