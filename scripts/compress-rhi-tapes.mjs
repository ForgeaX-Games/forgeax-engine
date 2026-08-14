#!/usr/bin/env node

// Compress retained RHI tape blobs in a harness checkout without touching
// unrelated binary assets. The operation is sequential by design: a single
// tape is held in memory, verified, and atomically replaced before the next
// tape is read.

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const DEFAULT_ROOT = '.forgeax-harness';
const GZIP_MAGIC = [0x1f, 0x8b];
const COMPRESSION_LEVEL = 6;

function usage() {
  console.error(`Usage: node scripts/compress-rhi-tapes.mjs [options]

Options:
  --root PATH    harness checkout to scan (default: ${DEFAULT_ROOT})
  --dry-run      report candidates without changing files
  --check        require every RHI tape blob to be gzip-compressed and valid
`);
  process.exit(2);
}

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  let dryRun = false;
  let check = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      root = argv[++index] ?? usage();
    } else if (arg?.startsWith('--root=')) {
      root = arg.slice('--root='.length);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--check') {
      check = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }

  if (dryRun && check) {
    console.error('--dry-run and --check cannot be combined');
    process.exit(2);
  }
  return { root: resolve(root), dryRun, check };
}

function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

function reportPathFor(tapePath) {
  if (tapePath.endsWith('.tape.bin'))
    return `${tapePath.slice(0, -'.tape.bin'.length)}.report.json`;
  if (tapePath.endsWith('-tape.bin'))
    return `${tapePath.slice(0, -'-tape.bin'.length)}-report.json`;
  return undefined;
}

function isRhiTape(tapePath) {
  if (tapePath.endsWith('.tape.bin')) return true;
  const reportPath = reportPathFor(tapePath);
  return reportPath !== undefined && existsSync(reportPath);
}

function collectFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && extname(entry.name) === '.bin' && isRhiTape(full)) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files.sort();
}

function formatGiB(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function replaceTape(tapePath, raw, compressed, ordinal) {
  if (!gunzipSync(compressed).equals(raw)) {
    throw new Error(`in-memory gzip verification failed for ${tapePath}`);
  }
  const temporary = `${tapePath}.gzip-tmp-${process.pid}-${ordinal}`;
  try {
    writeFileSync(temporary, compressed, { flag: 'wx' });
    renameSync(temporary, tapePath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original error; a missing temp file is harmless.
    }
    throw new Error(
      `failed to replace ${tapePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    statSync(tapePath).size !== compressed.byteLength ||
    !gunzipSync(readFileSync(tapePath)).equals(raw)
  ) {
    throw new Error(`post-write verification failed for ${tapePath}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.root) || !lstatSync(options.root).isDirectory()) {
    console.error(`root is not a directory: ${options.root}`);
    process.exit(1);
  }

  const files = collectFiles(options.root);
  let rawBytes = 0;
  let compressedBytes = 0;
  let changed = 0;
  let alreadyCompressed = 0;
  let uncompressed = 0;
  let reportedUncompressed = 0;

  for (let index = 0; index < files.length; index += 1) {
    const tapePath = files[index];
    const current = readFileSync(tapePath);
    if (isGzip(current)) {
      try {
        gunzipSync(current);
      } catch (error) {
        throw new Error(
          `invalid gzip tape ${tapePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      alreadyCompressed += 1;
      compressedBytes += current.byteLength;
      continue;
    }

    rawBytes += current.byteLength;
    if (options.check) {
      if (reportedUncompressed < 20) console.error(`uncompressed RHI tape: ${tapePath}`);
      reportedUncompressed += 1;
      uncompressed += 1;
      continue;
    }
    if (options.dryRun) {
      changed += 1;
      continue;
    }
    const compressed = gzipSync(current, { level: COMPRESSION_LEVEL });
    replaceTape(tapePath, current, compressed, index);
    compressedBytes += compressed.byteLength;
    changed += 1;
    if ((changed + alreadyCompressed) % 100 === 0) {
      console.log(`[tapes] processed ${changed + alreadyCompressed}/${files.length}`);
    }
  }

  const status = options.check && uncompressed > 0 ? 'FAIL' : 'OK';
  console.log(`[tapes] ${status}`);
  console.log(`  root                 ${options.root}`);
  console.log(`  RHI tape files       ${files.length}`);
  console.log(`  changed              ${changed}`);
  console.log(`  already compressed   ${alreadyCompressed}`);
  console.log(`  raw input bytes      ${formatGiB(rawBytes)}`);
  console.log(`  compressed bytes     ${formatGiB(compressedBytes)}`);
  if (reportedUncompressed > 20) {
    console.log(`  more raw tapes       ${reportedUncompressed - 20}`);
  }
  if (rawBytes > 0 && compressedBytes > 0) {
    console.log(`  new/raw ratio        ${(compressedBytes / rawBytes).toFixed(4)}`);
  }
  if (options.check && uncompressed > 0) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(`[tapes] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
