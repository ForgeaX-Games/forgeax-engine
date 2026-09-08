#!/usr/bin/env node
// Immutable generated-bundle provenance for the wgpu-wasm package.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAsset } from './content-key.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = join(ROOT, 'pkg');
const MANIFEST = join(PKG, 'provenance.json');

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function toolVersion(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

async function fileFact(path) {
  const bytes = await readFile(path);
  const info = await stat(path);
  return { bytes: info.size, sha256: digest(bytes) };
}

function fingerprintInput(manifest) {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    sourceContentKey: manifest.sourceContentKey,
    artifactSha256: manifest.artifactSha256,
    glueSha256: manifest.glueSha256,
    toolchain: manifest.toolchain,
    dependencies: manifest.dependencies,
  });
}

export async function writeProvenance() {
  const source = await resolveAsset();
  const artifact = await fileFact(join(PKG, 'wgpu_wasm_bg.wasm'));
  const glue = await fileFact(join(PKG, 'wgpu_wasm.js'));
  const manifest = {
    schemaVersion: 'wgpu-wasm-provenance/1',
    sourceContentKey: `sha256-${source.sha256}`,
    artifactSha256: artifact.sha256,
    artifactBytes: artifact.bytes,
    glueSha256: glue.sha256,
    glueBytes: glue.bytes,
    toolchain: {
      rustc: toolVersion('rustc', ['--version']),
      wasmPack: toolVersion('wasm-pack', ['--version']),
      wasmBindgen: toolVersion('wasm-bindgen', ['--version']),
    },
    dependencies: {
      wgpu: '29.0.3',
      naga: '29.0.3',
      nagaOil: '0.22.0',
      wasmBindgen: '0.2.121',
    },
  };
  manifest.compilerFingerprint = `sha256-${digest(fingerprintInput(manifest))}`;
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyProvenance() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch (error) {
    throw new Error(`provenance manifest unavailable: ${error instanceof Error ? error.message : error}`);
  }
  if (manifest.schemaVersion !== 'wgpu-wasm-provenance/1') {
    throw new Error('provenance manifest schemaVersion is not wgpu-wasm-provenance/1');
  }
  const artifact = await fileFact(join(PKG, 'wgpu_wasm_bg.wasm'));
  const glue = await fileFact(join(PKG, 'wgpu_wasm.js'));
  if (artifact.sha256 !== manifest.artifactSha256 || artifact.bytes !== manifest.artifactBytes) {
    throw new Error('provenance artifact bytes do not match manifest');
  }
  if (glue.sha256 !== manifest.glueSha256 || glue.bytes !== manifest.glueBytes) {
    throw new Error('provenance glue bytes do not match manifest');
  }
  const expectedFingerprint = `sha256-${digest(fingerprintInput(manifest))}`;
  if (expectedFingerprint !== manifest.compilerFingerprint) {
    throw new Error('provenance compilerFingerprint does not match manifest facts');
  }
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeProvenance()
    .then((manifest) => verifyProvenance().then(() => console.log(JSON.stringify(manifest))))
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}
