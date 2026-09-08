#!/usr/bin/env node
// Record the explicit quick-release boundary. This file is deliberately not
// shaped as a successful sdk-verify result: consumers and release tooling can
// distinguish a published, built artifact from one that passed the exhaustive
// offline archive verifier.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const archive = value('--archive');
const version = value('--version');
const output = value('--output');
if (archive === undefined || version === undefined || output === undefined) {
  throw new Error(
    'Usage: node scripts/forgeax/record-sdk-unverified.mjs --archive <path> --version <version> --output <path>',
  );
}

const archivePath = resolve(root, archive);
const outputPath = resolve(root, output);
const archiveBytes = await readFile(archivePath);
const buildResult = JSON.parse(
  await readFile(resolve(dirname(archivePath), 'sdk-build-result.json'), 'utf8'),
);
if (buildResult.ok !== true || buildResult.sdkVersion !== version) {
  throw new Error('sdk-unverified-build-result-mismatch');
}
const result = {
  schemaVersion: 1,
  ok: false,
  verified: false,
  status: 'unverified',
  reason: 'sdk:verify was explicitly skipped through the quick release route',
  archive: archivePath,
  archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
  sdkVersion: version,
  engineCommit: buildResult.engineCommit,
  skippedCommands: ['sdk:verify'],
  releaseWarning:
    'This artifact passed one sdk:build and npm package checks only; reproducibility and sdk:verify were skipped. Run sdk:verify before acceptance.',
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
