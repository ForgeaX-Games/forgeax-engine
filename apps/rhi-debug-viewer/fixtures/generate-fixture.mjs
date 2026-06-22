#!/usr/bin/env node

// generate-fixture.mjs — write the hello-cube tape fixture to disk for LOCAL
// DEBUGGING ONLY (e.g. to drag the files into the viewer by hand).
//
// The fixture is NOT committed — the engine repo tracks no binaries
// (grep:no-binary-assets). Tests and smokes build it in memory via
// buildHelloCubeFixture() from build-hello-cube-tape.mjs. This script is a thin
// CLI wrapper that materialises those bytes into a directory you choose.
//
// Usage:
//   node apps/rhi-debug-viewer/fixtures/generate-fixture.mjs [outDir]
//
// outDir defaults to a fresh os.tmpdir() directory. Do NOT pass this fixtures/
// directory — a committed .bin would fail grep:no-binary-assets.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildHelloCubeFixture } from './build-hello-cube-tape.mjs';

const outDir = process.argv[2]
  ? resolve(process.argv[2])
  : mkdtempSync(resolve(tmpdir(), 'rhi-debug-viewer-fixture-'));
mkdirSync(outDir, { recursive: true });

const { blob, report } = buildHelloCubeFixture();

const tapePath = resolve(outDir, 'frame-0.tape.bin');
const reportPath = resolve(outDir, 'frame-0.report.json');
writeFileSync(tapePath, blob);
writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(`Wrote ${tapePath} (${blob.byteLength} bytes)`);
console.log(`Wrote ${reportPath}`);
console.log('Fixture written for local debugging (not committed).');
