#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
const APP_ROOT = resolve(new URL('..', import.meta.url).pathname);
const FIXTURE_PATH = resolve(APP_ROOT, 'assets/pulse-material.pack.json');
const WASM_PROVENANCE_PATH = resolve(APP_ROOT, '../../../packages/wgpu-wasm/pkg/provenance.json');
const writeFixture = process.argv.includes('--write');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonWithBytes(value) {
  return JSON.stringify(value, (_key, entry) =>
    entry instanceof Uint8Array ? [...entry] : entry,
  );
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const wasm = JSON.parse(readFileSync(WASM_PROVENANCE_PATH, 'utf8'));
const cooker = createMaterialPackCooker([resolve(APP_ROOT, 'src')]);
const publications = [];
for (const asset of fixture.assets ?? []) {
  const cooked = asset.payload?.cooked;
  if (asset.kind !== 'material' || cooked === undefined) continue;
  const authored = {
    kind: 'material',
    passes: cooked.resolved.passes.map((pass) => ({
      ...pass,
      program: { ...pass.program, moduleSlots: undefined },
    })),
    parameters: cooked.resolved.parameters,
    values: cooked.resolved.values,
  };
  const draft = await cooker.cook({
    guid: cooked.guid,
    source: authored,
    sourcePath: FIXTURE_PATH,
    sourceKey: '../src/pulse-material.wgsl',
    refs: [],
    compilerFingerprint: wasm.compilerFingerprint,
    wasm,
  });
  const record = draft.payload.cooked;
  assert(record !== undefined, `pack producer did not publish ${cooked.guid}`);
  asset.payload.passes = authored.passes;
  asset.payload.cooked = record;
  publications.push({
    guid: record.guid,
    artifactDigest: record.artifact.digest,
    cookIdentity: record.receipt.identity.cookIdentity,
  });
}

const output = `${jsonWithBytes(fixture)}\n`;
if (writeFixture) writeFileSync(FIXTURE_PATH, output);
const summary = {
  status: 'pass',
  producer: 'shader-compiler Pack material cooker',
  publications,
  fixtureWritten: writeFixture,
  ...(writeFixture ? { fixturePath: FIXTURE_PATH } : {}),
};
console.log(JSON.stringify(summary));
