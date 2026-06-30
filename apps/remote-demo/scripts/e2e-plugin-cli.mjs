#!/usr/bin/env node
// apps/remote-demo/scripts/e2e-plugin-cli.mjs
//
// feat-20260629-inspector-two-layer-model-command-cleanup-createap (M5 w22).
//
// End-to-end remote CLI surface check. The remote plugin bins
// (forgeax-engine-remote-ecs / -asset / -font / -gltf / -state) are the
// post-M3 rename surface. This script verifies the CLI bins resolve
// and the eval channel works end-to-end (no Registry / 17 inspect
// commands / inspector-write-denied — those are all deleted in M2).

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const WORKSPACE_ROOT = resolve(APP_DIR, '..', '..');

const BASE_BIN = resolve(APP_DIR, 'node_modules/.bin/forgeax-engine-remote');
const ECS_BIN = resolve(APP_DIR, 'node_modules/.bin/forgeax-engine-remote-ecs');

const evidence = [];
let failures = 0;

function logCase(name, ok, detail) {
  evidence.push({ case: name, ok, ...detail });
  if (!ok) failures += 1;
}

function runCli(bin, args, opts = {}) {
  return new Promise((res) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const t = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 8000);
    child.on('close', (code, signal) => {
      clearTimeout(t);
      res({ code, signal, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(t);
      res({ code: 1, signal: null, stdout: '', stderr: String(err) });
    });
  });
}

async function main() {
  // Case (a): base bin --help references eval and remote plugin groups.
  {
    const r = await runCli(BASE_BIN, ['--help']);
    const hasEval = r.stdout.includes('eval');
    const hasEcs = r.stdout.includes('ecs');
    const hasScript = r.stdout.includes('script');
    const noInspect = !r.stdout.includes('inspect');
    const ok = r.code === 0 && hasEval && hasScript && noInspect;
    logCase('a-remote-help-eval', ok, {
      hasEval,
      hasScript,
      hasEcs,
      noInspect,
      stdoutPreview: r.stdout.slice(0, 300),
    });
  }

  // Case (b): ecs bin --help lists subcommands.
  {
    const r = await runCli(ECS_BIN, ['--help']);
    const subs = ['entities', 'components', 'systems', 'resources', 'world'].every((n) =>
      r.stdout.includes(n),
    );
    const ok = r.code === 0 && subs;
    logCase('b-remote-ecs-help-subs', ok, {
      subs,
      stdoutPreview: r.stdout.slice(0, 300),
    });
  }

  // Case (c): eval channel full-access — write is NOT denied (sandbox deleted).
  const tmpRoot = await mkdtemp(join(tmpdir(), 'remote-plugin-e2e-'));
  try {
    const serverMod = await import(
      /* @vite-ignore */ resolve(WORKSPACE_ROOT, 'packages/remote/dist/server.mjs')
    );
    const startServer = serverMod.startServer;
    const worldStub = {
      spawn() { return { ok: true, value: 1 }; },
    };
    const serverResult = await startServer({ port: 0, host: '127.0.0.1', world: worldStub });
    if (!serverResult.ok) {
      logCase('c-eval-write-no-deny', false, { error: serverResult.error });
    } else {
      const port = serverResult.value.port;
      try {
        const r = await runCli(BASE_BIN, [
          'eval', 'world.spawn(null).ok',
          '--port', String(port), '--host', '127.0.0.1',
        ]);
        const ok = r.code === 0;
        logCase('c-eval-write-no-deny', ok, {
          code: r.code,
          stdoutPreview: r.stdout.slice(0, 100),
          stderrPreview: r.stderr.slice(0, 100),
        });
      } finally {
        try { await serverResult.value.close(); } catch (_) { /* best-effort */ }
      }
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const summary = {
    feature: 'feat-20260629-inspector-two-layer-model-command-cleanup-createap',
    task: 'w22',
    casesTotal: evidence.length,
    casesPassed: evidence.length - failures,
    casesFailed: failures,
    cases: evidence,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failures > 0) {
    process.stderr.write(
      `e2e-plugin-cli: ${failures}/${evidence.length} case(s) failed; see stdout summary\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('e2e-plugin-cli: harness error:', err);
  process.exit(2);
});