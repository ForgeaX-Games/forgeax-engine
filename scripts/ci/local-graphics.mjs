#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowserCommand } from './run-browser-gate-with-retry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const lockBytes = readFileSync(join(here, 'local-graphics.lock.json'));
const lock = JSON.parse(lockBytes);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const { libraryDirectory, icdPath, libraries } = lock;

export function bundlePath(env = process.env) {
  return resolve(
    env.FORGEAX_CI_GRAPHICS_ROOT ??
      join(
        env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
        'forgeax',
        'graphics',
        `${lock.id}-${digest(lockBytes).slice(0, 12)}`,
      ),
  );
}

export function graphicsEnvironment(bundle, environment = process.env) {
  const icd = join(bundle, icdPath);
  return {
    ...environment,
    VK_ICD_FILENAMES: icd,
    VK_DRIVER_FILES: icd,
    LD_LIBRARY_PATH:
      join(bundle, libraryDirectory) +
      (environment.LD_LIBRARY_PATH ? `:${environment.LD_LIBRARY_PATH}` : ''),
    LP_NUM_THREADS: environment.LP_NUM_THREADS ?? '4',
    CI: environment.CI ?? '1',
  };
}

export function verifyArchive(bytes, expected) {
  if (digest(bytes) !== expected)
    throw new Error('graphics-integrity: downloaded package SHA-256 mismatch; nothing extracted');
}

function checkHost() {
  const glibc = process.report.getReport().header.glibcVersionRuntime;
  const [major, minor] = (glibc ?? '0.0').split('.').map(Number);
  const [requiredMajor, requiredMinor] = lock.minimumGlibc.split('.').map(Number);
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    major < requiredMajor ||
    (major === requiredMajor && minor < requiredMinor)
  )
    throw new Error(
      `graphics-host-unsupported: this bundle requires Linux x64 and glibc >= ${lock.minimumGlibc}; use the host graphics stack instead`,
    );
}

function installedFiles(bundle) {
  return Object.fromEntries(
    [icdPath, ...libraries.map((name) => join(libraryDirectory, name))].map((path) => [
      path,
      digest(readFileSync(join(bundle, path))),
    ]),
  );
}

export function verifyBundle(bundle) {
  try {
    const receipt = JSON.parse(readFileSync(join(bundle, 'receipt.json')));
    if (
      receipt.lock !== digest(lockBytes) ||
      JSON.stringify(receipt.files) !== JSON.stringify(installedFiles(bundle))
    )
      throw new Error('receipt mismatch');
  } catch (cause) {
    throw new Error(
      `graphics-bundle-unavailable: ${bundle}; run pnpm ci:graphics setup (remove a corrupt bundle first)`,
      { cause },
    );
  }
}

export async function setupGraphics(bundle = bundlePath()) {
  checkHost();
  if (existsSync(bundle)) {
    verifyBundle(bundle);
    return bundle;
  }
  mkdirSync(dirname(bundle), { recursive: true });
  const staging = mkdtempSync(join(dirname(bundle), '.graphics-'));
  try {
    mkdirSync(join(staging, 'root'));
    for (const entry of lock.packages) {
      console.log(`[graphics-setup] ${entry.url}`);
      const archive = join(staging, `${entry.name}.deb`);
      // curl carries a bounded network lifetime; no system package manager or sudo.
      execFileSync(
        'curl',
        [
          '--fail',
          '--location',
          '--silent',
          '--show-error',
          '--max-time',
          '180',
          '--output',
          archive,
          entry.url,
        ],
        { stdio: 'inherit' },
      );
      verifyArchive(readFileSync(archive), entry.sha256);
      const compressed = execFileSync('ar', ['p', archive, 'data.tar.zst'], {
        maxBuffer: 128 * 1024 * 1024,
      });
      execFileSync('tar', ['--zstd', '-xf', '-', '-C', join(staging, 'root')], {
        input: compressed,
      });
      rmSync(archive);
    }
    writeFileSync(
      join(staging, 'receipt.json'),
      `${JSON.stringify({ lock: digest(lockBytes), files: installedFiles(staging) }, null, 2)}\n`,
    );
    renameSync(staging, bundle);
    verifyBundle(bundle);
    return bundle;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function parseGraphicsArgs(argv) {
  const args = [...argv];
  const action = ['setup', 'probe'].includes(args[0]) ? args.shift() : 'run';
  let probe = 'both';
  if (args[0] === '--probe') {
    args.shift();
    probe = args.shift();
  }
  if (!['dawn', 'browser', 'both'].includes(probe))
    throw new Error('graphics-usage: --probe dawn|browser|both');
  const command = action === 'run' && args.shift() === '--' ? args.splice(0) : [];
  if (
    args.length ||
    (action === 'run' && !command.length) ||
    (action === 'setup' && probe !== 'both')
  )
    throw new Error(
      'usage: pnpm ci:graphics setup | probe [--probe dawn|browser|both] | [--probe dawn|browser|both] -- COMMAND [ARGS...]',
    );
  return { action, probe, command };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseGraphicsArgs(argv);
  const bundle = bundlePath();
  checkHost();
  if (options.action === 'setup') {
    console.log(`[graphics-setup] ready: ${await setupGraphics(bundle)}`);
    return 0;
  }
  verifyBundle(bundle);
  const env = graphicsEnvironment(bundle);
  const backends = options.probe === 'both' ? ['dawn', 'browser'] : [options.probe];
  for (const backend of backends) {
    const result = await runBrowserCommand(
      [process.execPath, join(here, 'probe-local-graphics.mjs'), backend],
      { env, label: `graphics-preflight-${backend}`, timeoutMs: 60_000 },
    );
    if (result.status !== 0) return result.status;
  }
  if (options.action === 'probe') return 0;
  console.log('[graphics] software validation only; command coverage and assertions are unchanged');
  return (await runBrowserCommand(options.command, { env, label: 'local-software-graphics' }))
    .status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
