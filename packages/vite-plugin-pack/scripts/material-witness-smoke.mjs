#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
  createBuiltinMaterialAsset,
} from '@forgeax/engine-shader';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(new URL('..', import.meta.url).pathname);
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const SHADER_ROOT = resolve(REPO_ROOT, 'packages/shader/src');
const FIXTURE_ROOT = resolve(REPO_ROOT, 'scripts/forgeax/material-witness-fixtures');
const WASM_PROVENANCE_PATH = resolve(REPO_ROOT, 'packages/wgpu-wasm/pkg/provenance.json');
const FRAME_TARGET = 300;

function materialParametersFromSchema(schema) {
  return schema.map((parameter) => ({
    ...parameter,
    type: parameter.type === 'texture2d' ? 'texture' : parameter.type,
  }));
}

const GUIDS = {
  runtime: '019f0000-0000-7000-8000-000000000101',
  builtin: '019f0000-0000-7000-8000-000000000102',
  gltf: '019f0000-0000-7000-8000-000000000103',
  fbx: '019f0000-0000-7000-8000-000000000104',
  consumer: '019f0000-0000-7000-8000-000000000105',
};

const CONFIG = {
  runtime: { material: 'standard', smoke: ['@forgeax/hello-cube', 'smoke'], source: 'builtin' },
  builtin: { material: 'unlit', smoke: ['@forgeax/hello-triangle', 'smoke'], source: 'builtin' },
  gltf: { smoke: ['@forgeax/hello-gltf', 'smoke'], source: 'gltf' },
  fbx: { smoke: ['@forgeax/hello-fbx-cube', 'smoke'], source: 'fbx' },
  consumer: { smoke: ['@forgeax/hello-fbx-cube', 'smoke'], source: 'fbx' },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function engineSources() {
  const entries = await readdir(SHADER_ROOT, { withFileTypes: true });
  const result = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.wgsl')) continue;
    const path = resolve(SHADER_ROOT, entry.name);
    const source = await readFile(path, 'utf8');
    const header = /^\s*#define_import_path\s+([^\s]+)/m.exec(source)?.[1];
    if (header === undefined) continue;
    result.set(header, { path, source });
  }
  return result;
}

async function materialFromSource(kind, sources) {
  if (kind === 'builtin') {
    return {
      ...createBuiltinMaterialAsset('unlit'),
      parameters: materialParametersFromSchema(DEFAULT_UNLIT_PARAM_SCHEMA),
    };
  }
  if (kind === 'gltf') {
    const path = resolve(REPO_ROOT, 'apps/hello/gltf/assets/box.gltf');
    const { parseGltf, toMaterialAsset } = await import('@forgeax/engine-gltf');
    const parsed = await parseGltf(JSON.parse(await readFile(path, 'utf8')), async () => {
      throw new Error('gltf witness unexpectedly requested an external URI');
    }, path);
    assert(parsed.ok, `gltf source import failed: ${JSON.stringify(parsed.error)}`);
    const material = parsed.value.materials[0];
    assert(material !== undefined, 'gltf source has no material');
    return toMaterialAsset(material);
  }
  const root = resolve(REPO_ROOT, 'forgeax-engine-assets/vendor/fbx-test');
  const metaPath = resolve(root, 'cube.fbx.meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  const sourcePath = resolve(root, meta.source);
  const bytes = new Uint8Array(await readFile(sourcePath));
  const { fbxImporter } = await import('@forgeax/engine-fbx');
  const imported = await fbxImporter.import({
    source: sourcePath,
    readSource: async () => ({ ok: true, value: bytes }),
    subAssets: meta.subAssets,
    importSettings: meta.importSettings ?? {},
  });
  assert(imported.ok, `fbx source import failed: ${JSON.stringify(imported.error)}`);
  const materialAsset = imported.value.assets.find((asset) => asset.kind === 'material');
  assert(materialAsset !== undefined, 'fbx source import produced no material');
  return materialAsset.payload;
}

async function cook(kind) {
  const config = CONFIG[kind];
  const guid = GUIDS[kind];
  const allSources = await engineSources();
  const material = config.material === 'standard'
    ? {
        ...createBuiltinMaterialAsset('standard'),
        parameters: materialParametersFromSchema(DEFAULT_STANDARD_PBR_PARAM_SCHEMA),
      }
    : await materialFromSource(config.source, allSources);
  const selected = material.passes?.[0]?.program.module;
  assert(selected !== undefined, `${kind} material has no shader module`);
  const selectedFile = selected === 'forgeax::default-unlit'
    ? 'unlit.wgsl'
    : selected === 'forgeax_material::unlit'
      ? 'unlit.wgsl'
      : selected === 'forgeax::default-standard-pbr'
        ? 'default-standard-pbr.wgsl'
        : selected === 'forgeax_material::standard'
          ? 'default-standard-pbr.wgsl'
          : selected === 'forgeax::pbr-skin'
            ? 'default-standard-pbr-skin.wgsl'
            : selected === 'forgeax_material::pbr-skin'
              ? 'default-standard-pbr-skin.wgsl'
        : undefined;
  assert(selectedFile !== undefined, `${kind} material uses unsupported module ${selected}`);
  const selectedPath = resolve(SHADER_ROOT, selectedFile);
  const producer = createMaterialPackCooker([SHADER_ROOT]);
  const wasm = JSON.parse(await readFile(WASM_PROVENANCE_PATH, 'utf8'));
  const draft = await producer.cook({
    guid,
    source: material,
    sourcePath: selectedPath,
    sourceKey: basename(selectedPath),
    refs: [],
    compilerFingerprint: wasm.compilerFingerprint,
    wasm,
  });
  const record = draft.payload.cooked;
  assert(record !== undefined, `${kind} production cook did not publish a cooked record`);
  const artifactPath = Object.keys(draft.artifacts)[0];
  assert(artifactPath !== undefined, `${kind} production cook did not publish an artifact`);
  const artifact = draft.artifacts[artifactPath];
  return {
    guid,
    material,
    publication: {
      record,
      artifactBytes: artifact.bytes,
      artifact: { digest: record.artifact.digest },
    },
    sourceClosure: record.receipt.sourceClosure,
  };
}

function jsonWithBytes(value) {
  return JSON.stringify(value, (_key, entry) => entry instanceof Uint8Array ? [...entry] : entry, 2);
}

async function writeFixture(kind, cooked) {
  const path = resolve(FIXTURE_ROOT, `${kind}.pack.json`);
  const payload = {
    ...cooked.material,
    cooked: cooked.publication.record,
  };
  const pack = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [{ guid: cooked.guid, kind: 'material', payload, refs: [], artifacts: {} }],
  };
  await writeFile(path, `${jsonWithBytes(pack)}\n`);
  return relative(REPO_ROOT, path);
}

function parseReadback(output) {
  const line = output.split('\n').find((entry) => entry.includes('pixelSamples='));
  if (line === undefined) return undefined;
  try {
    const samples = JSON.parse(line.slice(line.indexOf('pixelSamples=') + 'pixelSamples='.length));
    return samples.ndcCenter ?? samples.center ?? Object.values(samples)[0];
  } catch {
    return undefined;
  }
}

async function runSmoke(kind, cooked) {
  const [filter, script] = CONFIG[kind].smoke;
  let result;
  try {
    const completed = await execFileAsync('pnpm', ['--filter', filter, script], {
      cwd: REPO_ROOT,
      env: { ...process.env, SMOKE_MIN_FRAMES: String(FRAME_TARGET) },
      maxBuffer: 16 * 1024 * 1024,
    });
    result = { stdout: completed.stdout, stderr: completed.stderr, exitCode: 0 };
  } catch (error) {
    result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code ?? 1 };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const frames = Number(/frames(?: observed)?[=:](\d+)/i.exec(output)?.[1] ?? 0);
  const pixel = parseReadback(output);
  assert(result.exitCode === 0, `${kind} smoke exited with ${result.exitCode}: ${output.slice(-800)}`);
  assert(frames >= FRAME_TARGET, `${kind} smoke observed ${frames} frames`);
  assert(Array.isArray(pixel) && pixel.length >= 3 && pixel.some((value) => Number(value) > 0), `${kind} smoke had no non-zero Dawn readback`);
  return {
    status: 'pass',
    renderer: 'forgeax-runtime',
    backend: 'dawn-webgpu',
    frames,
    pixel: [...pixel, 1],
    materialIdentity: cooked.publication.record.receipt.identity,
    rootGuid: cooked.guid,
    observed: { draw: true, readback: 'Dawn copyTextureToBuffer', sourceClosure: cooked.sourceClosure.map((path) => relative(REPO_ROOT, path)) },
    verdict: 'pass',
    confidence: 'high',
  };
}

const kind = process.argv[2];
const write = process.argv.includes('--write-fixture');
assert(typeof kind === 'string' && CONFIG[kind] !== undefined, `usage: ${basename(process.argv[1])} <runtime|builtin|gltf|fbx|consumer> [--write-fixture]`);
const cooked = await cook(kind);
const fixture = write ? await writeFixture(kind, cooked) : undefined;
const evidence = await runSmoke(kind, cooked);
console.log(JSON.stringify({
  ...evidence,
  fixture: fixture ?? `scripts/forgeax/material-witness-fixtures/${kind}.pack.json`,
  source: cooked.sourceClosure.map((path) => relative(REPO_ROOT, path)),
}));
