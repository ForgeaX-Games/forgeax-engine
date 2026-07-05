#!/usr/bin/env node
// fetch-ufbx.mjs — Download ufbx.h + ufbx.c from the official GitHub repo.
// Usage: node scripts/fetch-ufbx.mjs [version]
// Default version: v0.23.0 (latest stable as of 2026-07)

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = join(__dirname, '..', 'src', 'native');

const VERSION = process.argv[2] || 'v0.23.0';
const BASE_URL = `https://raw.githubusercontent.com/ufbx/ufbx/${VERSION}`;

const FILES = ['ufbx.h', 'ufbx.c'];

async function fetchFile(name) {
  const url = `${BASE_URL}/${name}`;
  console.log(`Fetching ${url} ...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.text();
}

async function main() {
  if (!existsSync(NATIVE_DIR)) mkdirSync(NATIVE_DIR, { recursive: true });

  for (const file of FILES) {
    const dest = join(NATIVE_DIR, file);
    if (existsSync(dest)) {
      console.log(`  ${file} already exists, skipping (delete to re-fetch)`);
      continue;
    }
    const content = await fetchFile(file);
    writeFileSync(dest, content);
    console.log(`  → ${dest} (${(content.length / 1024).toFixed(0)} KB)`);
  }
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
