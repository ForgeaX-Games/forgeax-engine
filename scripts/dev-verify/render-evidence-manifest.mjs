#!/usr/bin/env node

import { readFileSync as readFileSyncFromFs } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const DEFAULT_MANIFEST = resolve(SCRIPT_DIR, 'render-evidence-manifest.json');
const SCHEMA_PATH = resolve(SCRIPT_DIR, 'render-evidence-manifest.schema.json');
const schema = JSON.parse(readFileSyncFromFs(SCHEMA_PATH, 'utf8'));
const validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

export const REQUIRED_CELL_IDS = ['scene-structure', 'dawn-shader', 'chromium-pack'];
export const REQUIRED_EVIDENCE_LAYERS = [
  'budget',
  'apiSnapshot',
  'consumerInventory',
  'legacySurface',
  'distBuild',
  'requiredCells',
  'documentation',
];

function schemaErrors() {
  return (validator.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`);
}

export function validateManifest(manifest) {
  const ok = validator(manifest);
  return { ok, errors: ok ? [] : schemaErrors() };
}

function backendKey(kind, identity) {
  return `${kind}\u0000${identity}`;
}

function identityErrors(manifest) {
  const errors = [];
  const backendKeys = new Set();
  for (const backend of manifest.backends) {
    const key = backendKey(backend.kind, backend.identity);
    if (backendKeys.has(key))
      errors.push(`duplicate backend identity ${backend.kind}/${backend.identity}`);
    backendKeys.add(key);
  }
  const requiredIds = new Set();
  for (const cell of manifest.requiredCells) {
    if (requiredIds.has(cell.id)) errors.push(`duplicate required cell ${cell.id}`);
    requiredIds.add(cell.id);
    if (cell.sourceSha !== manifest.sourceSha)
      errors.push(`source identity mismatch for required cell ${cell.id}`);
    if (cell.buildId !== manifest.build.id)
      errors.push(`build identity mismatch for required cell ${cell.id}`);
    if (!backendKeys.has(backendKey(cell.backendKind, cell.backendIdentity))) {
      errors.push(`backend identity mismatch for required cell ${cell.id}`);
    }
    if (cell.status !== 'pass') errors.push(`required cell ${cell.id} is ${cell.status}`);
    if (cell.status === 'pass' && cell.verdict === 'blocked')
      errors.push(`required cell ${cell.id} has a blocked verdict`);
    if (cell.backendKind === 'rhi-null' && cell.verdict !== 'structural') {
      errors.push(
        `RhiNull required cell ${cell.id} must have a structural verdict, not ${cell.verdict}`,
      );
    }
    if (cell.backendKind !== 'rhi-null' && cell.verdict === 'pixel' && cell.status !== 'pass') {
      errors.push(`pixel cell ${cell.id} is not complete`);
    }
  }
  for (const id of REQUIRED_CELL_IDS)
    if (!requiredIds.has(id)) errors.push(`missing required cell ${id}`);
  for (const record of manifest.visualRecords) {
    if (record.sourceSha !== manifest.sourceSha)
      errors.push(`source identity mismatch for visual target ${record.target}`);
    if (record.buildId !== manifest.build.id)
      errors.push(`build identity mismatch for visual target ${record.target}`);
    if (!backendKeys.has(backendKey(record.backend.kind, record.backend.identity))) {
      errors.push(`backend identity mismatch for visual target ${record.target}`);
    }
    if (record.backend.kind === 'rhi-null' && record.verdict === 'pixel') {
      errors.push(`RhiNull visual target ${record.target} cannot have a pixel verdict`);
    }
  }
  return errors;
}

export function verifyRequiredCells(manifest) {
  const structural = validateManifest(manifest);
  if (!structural.ok) return structural;
  const errors = identityErrors(manifest);
  return { ok: errors.length === 0, errors };
}

export function verifyEvidenceLayers(manifest) {
  const structural = validateManifest(manifest);
  if (!structural.ok) return structural;
  const errors = [];
  const evidence = manifest.evidence;
  if (evidence.sourceSha !== manifest.sourceSha) errors.push('evidence source identity mismatch');
  if (evidence.buildId !== manifest.build.id) errors.push('evidence build identity mismatch');
  for (const layer of REQUIRED_EVIDENCE_LAYERS) {
    if (evidence.layers[layer] !== 'pass') errors.push(`evidence layer ${layer} is not pass`);
  }
  const chain = new Set(evidence.frameChain);
  for (const stage of ['createRenderer', 'attach', 'draw'])
    if (!chain.has(stage)) errors.push(`frame chain is missing ${stage}`);
  if (!chain.has('observe') && !chain.has('recover'))
    errors.push('frame chain requires observe or recover');
  return { ok: errors.length === 0, errors };
}

function parseArgs(args) {
  const options = { manifest: DEFAULT_MANIFEST };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--verify-required') options.verifyRequired = true;
    else if (argument === '--json') options.json = true;
    else if (argument.startsWith('--manifest='))
      options.manifest = resolve(argument.slice('--manifest='.length));
    else if (argument === '--manifest') options.manifest = resolve(args[++index]);
    else if (argument.startsWith('--source-sha='))
      options.sourceSha = argument.slice('--source-sha='.length);
    else if (argument === '--source-sha') options.sourceSha = args[++index];
    else if (argument.startsWith('--output='))
      options.output = resolve(argument.slice('--output='.length));
    else if (argument === '--output') options.output = resolve(args[++index]);
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/dev-verify/render-evidence-manifest.mjs --verify-required [--manifest=<path>] [--source-sha=<sha>]\n',
    );
    return;
  }
  if (!options.verifyRequired)
    throw new Error('--verify-required is required for the evidence gate');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(options.manifest, 'utf8'));
  } catch (error) {
    throw new Error(`manifest could not be read: ${options.manifest}: ${error.message}`);
  }
  const requiredResult = verifyRequiredCells(manifest);
  const evidenceResult = verifyEvidenceLayers(manifest);
  const result = {
    ok: requiredResult.ok && evidenceResult.ok,
    errors: [...requiredResult.errors, ...evidenceResult.errors],
  };
  if (options.sourceSha !== undefined && manifest.sourceSha !== options.sourceSha) {
    result.ok = false;
    result.errors.push('manifest source SHA does not match requested identity');
  }
  const output = {
    manifest: options.manifest,
    sourceSha: manifest.sourceSha,
    requiredCells: manifest.requiredCells.length,
    visualRecords: manifest.visualRecords.length,
    verdict: result.ok ? 'complete' : 'blocked',
    errors: result.errors,
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (options.output !== undefined) await writeFile(options.output, serialized);
  if (options.json || options.output === undefined) process.stdout.write(serialized);
  if (!result.ok) {
    process.stderr.write(`FAIL render-evidence-manifest: ${result.errors.join('; ')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('PASS render-evidence-manifest\n');
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    process.stderr.write(`render-evidence-manifest: ${error.message}\n`);
    process.exitCode = 2;
  });
}
