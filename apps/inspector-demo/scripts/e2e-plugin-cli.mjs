#!/usr/bin/env node
// apps/inspector-demo/scripts/e2e-plugin-cli.mjs
//
// feat-20260517-console-ecs-plugin-extraction · M3 · w25.
//
// 5 reinforcement assertions exercising the kubectl 4th-path plugin
// surface end-to-end:
//
//   (a) AC-09 / AC-12: `forgeax-engine-console --help` Discovered group
//       contains asset / gltf / ecs lines; Built-in group is exactly
//       script + eval (the inspect subcommand was removed in M2 w17).
//   (b) AC-17: `forgeax-engine-console-ecs --help` lists 5 subcommands
//       (entities / components / systems / resources / world; no packs).
//   (c) AC-17: `forgeax-engine-console-ecs entities --help` lists the
//       --with / --without / --port / --host / --help flags.
//   (d) AC-10: `world.spawn(null)` over WS surfaces inspector-write-denied
//       when registerEcsInspector contributed ECS_MUTATING_METHODS at
//       host assembly time.
//   (e) AC-10 reverse: when the host did NOT call registerEcsInspector,
//       the same `world.spawn(null)` is NOT denied (the blacklist is
//       Registry-driven, not hard-coded fallback).

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const WORKSPACE_ROOT = resolve(APP_DIR, '..', '..');

const BASE_BIN = resolve(APP_DIR, 'node_modules/.bin/forgeax-engine-console');
const ECS_BIN = resolve(APP_DIR, 'node_modules/.bin/forgeax-engine-console-ecs');
const APP_BIN_DIR = resolve(APP_DIR, 'node_modules/.bin');

const evidence = [];
let failures = 0;

function logCase(name, ok, detail) {
  evidence.push({ case: name, ok, ...detail });
  if (!ok) failures += 1;
}

function runCli(bin, args, opts = {}) {
  return new Promise((res) => {
    const env = { ...process.env, ...(opts.env ?? {}) };
    // Ensure the plugin bins (asset / gltf / ecs) ship in this app's
    // node_modules/.bin land on PATH so kubectl 4th-path discovery picks
    // them up regardless of the harness's parent shell PATH.
    const sep = process.platform === 'win32' ? ';' : ':';
    env.PATH = `${APP_BIN_DIR}${sep}${env.PATH ?? ''}`;
    const child = spawn(bin, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
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

function makeWorld() {
  return {
    inspect() {
      return {
        entityCount: 1,
        archetypeCount: 1,
        activeComponents: ['Transform'],
        systemCount: 0,
        resourceKeys: [],
        archetypes: [
          { key: 'Transform', componentNames: ['Transform'], entityCount: 1 },
        ],
        systems: [],
      };
    },
    spawn() {
      return { ok: true, value: { id: 1 } };
    },
    despawn() {},
    addComponent() {},
    removeComponent() {},
    insertResource() {},
    removeResource() {},
    addSystem() {},
    removeSystem() {},
    replaceSystem() {},
    setErrorHandler() {},
    update() {},
    set() {},
    push() {},
    pop() {},
  };
}

async function main() {
  const serverMod = await import(
    /* @vite-ignore */ resolve(WORKSPACE_ROOT, 'packages/console/dist/server.mjs')
  );
  const consoleMod = await import(
    /* @vite-ignore */ resolve(WORKSPACE_ROOT, 'packages/console/dist/index.mjs')
  );
  const ecsMod = await import(
    /* @vite-ignore */ resolve(WORKSPACE_ROOT, 'packages/ecs/dist/index.mjs')
  );

  const startConsoleServer = serverMod.startConsoleServer;
  const Registry = consoleMod.Registry;
  const registerEcsInspector = ecsMod.registerEcsInspector;

  // ── case (a): base bin --help groups ───────────────────────────────────
  {
    const r = await runCli(BASE_BIN, ['--help']);
    const stdout = r.stdout;
    const hasAsset = /^\s*asset\s+/m.test(stdout);
    const hasGltf = /^\s*gltf\s+/m.test(stdout);
    const hasEcs = /^\s*ecs\s+/m.test(stdout);
    const hasScript = /^\s*script\s+/m.test(stdout);
    const hasEval = /^\s*eval\s+/m.test(stdout);
    const noInspect = !/^\s*inspect\s+/m.test(stdout);
    const ok =
      r.code === 0 && hasAsset && hasGltf && hasEcs && hasScript && hasEval && noInspect;
    logCase('a-base-help-discovers-3-plugins', ok, {
      hasAsset,
      hasGltf,
      hasEcs,
      hasScript,
      hasEval,
      noInspect,
      stdoutPreview: stdout.slice(0, 300),
    });
  }

  // ── case (b): ecs bin --help lists 5 subcommands ───────────────────────
  {
    const r = await runCli(ECS_BIN, ['--help']);
    const stdout = r.stdout;
    const subs = ['entities', 'components', 'systems', 'resources', 'world'].every((n) =>
      stdout.includes(n),
    );
    const noPacks = !stdout.includes('packs');
    const ok = r.code === 0 && subs && noPacks;
    logCase('b-ecs-help-5-subcommands', ok, {
      subs,
      noPacks,
      stdoutPreview: stdout.slice(0, 300),
    });
  }

  // ── case (c): ecs entities --help shows the 5 flags ─────────────────────
  {
    const r = await runCli(ECS_BIN, ['entities', '--help']);
    const stdout = r.stdout;
    const flags = ['--with', '--without', '--port', '--host', '--help'].every((f) =>
      stdout.includes(f),
    );
    const ok = r.code === 0 && flags;
    logCase('c-ecs-entities-help-flags', ok, {
      flags,
      stdoutPreview: stdout.slice(0, 300),
    });
  }

  // ── case (d): write-denied with proper plugin assembly ─────────────────
  {
    const reg = new Registry();
    const world = makeWorld();
    const rRoot = reg.registerRoot('world', world);
    if (!rRoot.ok) {
      logCase('d-write-denied-with-plugin', false, {
        reason: 'registerRoot(world) failed',
      });
    } else {
      const r0 = registerEcsInspector(reg, world);
      if (!r0.ok) {
        logCase('d-write-denied-with-plugin', false, {
          reason: 'registerEcsInspector failed',
        });
      } else {
      const startResult = await startConsoleServer({
        port: 0,
        host: '127.0.0.1',
        scriptTimeoutMs: 1500,
        registry: reg,
        world,
      });
      if (!startResult.ok) {
        logCase('d-write-denied-with-plugin', false, {
          reason: 'startConsoleServer failed',
          error: startResult.error,
        });
      } else {
        const handle = startResult.value;
        try {
          const r = await runCli(BASE_BIN, [
            'eval',
            'world.spawn(null)',
            '--port',
            String(handle.port),
            '--host',
            '127.0.0.1',
          ]);
          const denied =
            r.code !== 0 && r.stderr.includes('inspector-write-denied');
          logCase('d-write-denied-with-plugin', denied, {
            code: r.code,
            stderrPreview: r.stderr.slice(0, 200),
          });
        } finally {
          await handle.close();
        }
      }
      }
    }
  }

  // ── case (e): reverse — without plugin, no denial ──────────────────────
  {
    const reg = new Registry();
    const world = makeWorld();
    reg.registerRoot('world', world);
    const startResult = await startConsoleServer({
      port: 0,
      host: '127.0.0.1',
      scriptTimeoutMs: 1500,
      registry: reg,
      world,
    });
    if (!startResult.ok) {
      logCase('e-reverse-no-plugin-no-denial', false, {
        reason: 'startConsoleServer failed',
        error: startResult.error,
      });
    } else {
      const handle = startResult.value;
      try {
        const r = await runCli(BASE_BIN, [
          'eval',
          'world.spawn(null)',
          '--port',
          String(handle.port),
          '--host',
          '127.0.0.1',
        ]);
        const notDenied = !r.stderr.includes('inspector-write-denied');
        logCase('e-reverse-no-plugin-no-denial', notDenied, {
          code: r.code,
          stderrPreview: r.stderr.slice(0, 200),
        });
      } finally {
        await handle.close();
      }
    }
  }

  const summary = {
    feature: 'feat-20260517-console-ecs-plugin-extraction',
    task: 'w25',
    casesTotal: evidence.length,
    casesPassed: evidence.length - failures,
    casesFailed: failures,
    cases: evidence,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failures > 0) {
    process.stderr.write(
      `e2e-plugin-cli: ${failures}/${evidence.length} case(s) failed; see stdout for diagnostics\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('e2e-plugin-cli: harness error:', err);
  process.exit(2);
});
