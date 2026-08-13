#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createFullMatrixManifest,
  validateFullMatrixManifest,
} from './membership-timing/full-matrix.mjs';

const output = process.argv
  .find((value) => value.startsWith('--output='))
  ?.slice('--output='.length);
if (output === undefined)
  throw new Error('usage: generate-deferred-membership-manifest.mjs --output=<manifest.json>');

const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const manifest = createFullMatrixManifest({ sourceHead });
const validation = validateFullMatrixManifest(manifest);
if (!validation.valid)
  throw new Error(
    `generated full matrix manifest is invalid: ${JSON.stringify(validation.errors)}`,
  );
const outputPath = resolve(output);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${outputPath}\n`);
