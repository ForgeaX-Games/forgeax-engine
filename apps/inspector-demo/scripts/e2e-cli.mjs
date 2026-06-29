#!/usr/bin/env node
// apps/inspector-demo/scripts/e2e-cli.mjs
//
// End-to-end CLI evidence collector for feat-20260511-inspector-p0-spike
// (T-16). feat-20260517-console-ecs-plugin-extraction · M3 · w25 update:
// the 5 `inspect <target>` cases migrated to the kubectl 4th-path plugin
// form `forgeax-engine-console-ecs <target>` shipped by @forgeax/engine-ecs;
// AC-09 / AC-10 reverse + plugin discovery covered by the sibling
// e2e-plugin-cli.mjs harness.
//
// Drives the `forgeax-engine-console` binary as a subprocess against an
// in-process `@forgeax/engine-console/server` instance bound to an
// ephemeral OS-assigned port. Covers AC-20 acceptance criteria + AC-21 CI
// integration:
//
//   case  1: forgeax-engine-console-ecs entities --with Transform
//   case  2: forgeax-engine-console-ecs components
//   case  3: forgeax-engine-console-ecs systems
//   case  4: forgeax-engine-console-ecs resources
//   case  5: forgeax-engine-console-ecs world
//   case  6: forgeax-engine-console script <file>
//   case  7: forgeax-engine-console eval "world.inspect().entityCount"
//   case  8: forgeax-engine-console eval "world.spawn({ component: ... })" -> inspector-write-denied (-32004)
//   case  9: forgeax-engine-console eval "world.}{" -> script-syntax-error (-32001)
//   case 10: forgeax-engine-console eval "world.nonExistentMethod()" -> script-runtime-error (-32002)
//   case 11: forgeax-engine-console eval "while(true){}" -> script-timeout (-32003)
//   case 12: fixture injection negative test (AIUser F-4 P3 merge): inject a
//            mutation method call into the inspect-demo World harness and
//            verify the CLI rejects it via `inspector-write-denied` /
//            JSON-RPC error.code = -32004; charter proposition 6
//            "simulation coverage != real availability" delta + zeta double
//            gate.
//   case 13: hierarchy visualisation via forgeax-engine-console-ecs world.
//
// Lifecycle:
//   - bind on port 0 -> OS assigns ephemeral port
//   - one server reused across all cases (clean shutdown via handle.close())
//   - default timeout 1500 ms per case (case 11 forces 1200 ms timeout via
//     INSPECTOR_SCRIPT_TIMEOUT_MS env to short-circuit the loop)
//
// Exit policy (charter proposition 4 explicit failure):
//   - All 12 cases pass -> exit 0 + JSON summary on stdout
//   - Any case fails -> exit 1 + per-case diagnostics on stderr (.expected /
//     .hint / actualExitCode / stderr tail)

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const WORKSPACE_ROOT = resolve(APP_DIR, '..', '..');

const SCRIPT_TIMEOUT_MS = 1200;
const CLI_BIN = resolve(WORKSPACE_ROOT, 'packages', 'console', 'dist', 'cli.mjs');
const CLI_ECS_BIN = resolve(WORKSPACE_ROOT, 'packages', 'ecs', 'dist', 'cli-ecs.mjs');

const evidence = [];
let failures = 0;

function logCase(name, ok, detail) {
  evidence.push({ case: name, ok, ...detail });
  if (!ok) failures += 1;
}

function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 8000);
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function runEcsCli(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ECS_BIN, ...args], {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 8000);
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function makeWorld() {
  // Inline ECS World stand-in. Mirrors the AC-08 / sugar.ts contract on
  // world.inspect() (returns archetypes + activeComponents + systemCount
  // + resourceKeys + entityCount + archetypeCount) without depending on the
  // full @forgeax/engine-ecs build artefacts being on disk in the e2e harness path.
  // The methods listed in the alpha-mode mutation blacklist (spawn /
  // despawn / register / clear / insertResource / ...) MUST exist as own /
  // prototype properties so the read-only Proxy can intercept them at
  // call-time (otherwise the get-trap would not even fire).
  //
  // Round 2 F-3 fix-up (verify VerifyAIUserReviewer F-3 P3 nit): the
  // fixture now declares all 17 MUTATION_BLACKLIST member methods (ECS 9
  // + Array 7 + Map 1) so case 12 below can prove every blacklist entry
  // surfaces inspector-write-denied through the CLI -> server -> sandbox
  // chain. Previously only 8 ECS-flavoured methods were declared; the 9
  // Array / Map names were never round-tripped through the CLI, leaving
  // a silent-regression window if a worker accidentally dropped one from
  // the blacklist (charter proposition 6 delta + zeta double gate
  // requires runtime parity with the compile-time SSOT).
  const world = {
    inspect() {
      return {
        entityCount: 5,
        archetypeCount: 4,
        activeComponents: [
          'Transform',
          'MeshFilter',
          'MeshRenderer',
          'Camera',
          'DirectionalLight',
          // w31 - feat-20260511-asset-system-v1 / AC-08 hierarchy visualisation:
          // ChildOf + Children active so the inspector CLI query paths
          // (--with ChildOf / --with Children) surface the hello-room
          // 3 mesh + hierarchy scene (charter proposition 2 industry
          // analogy: mirrors Three.js Object3D.parent + Bevy ChildOf/Children).
          'ChildOf',
          'Children',
        ],
        systemCount: 0,
        resourceKeys: [],
        archetypes: [
          {
            // root cube: Transform + MeshFilter + MeshRenderer (no ChildOf).
            key: 'Transform|MeshFilter|MeshRenderer',
            componentNames: ['Transform', 'MeshFilter', 'MeshRenderer'],
            entityCount: 1,
          },
          {
            // two children: Transform + ChildOf + MeshFilter + MeshRenderer.
            // The ChildOf column confirms hierarchy presence in the archetype
            // schema; AC-08 AI user discovery anchor = grep `ChildOf` in
            // the inspect JSON (charter proposition 3 machine-readable).
            key: 'Transform|ChildOf|MeshFilter|MeshRenderer',
            componentNames: ['Transform', 'ChildOf', 'MeshFilter', 'MeshRenderer'],
            entityCount: 2,
          },
          {
            key: 'Transform|Camera',
            componentNames: ['Transform', 'Camera'],
            entityCount: 1,
          },
          {
            key: 'DirectionalLight',
            componentNames: ['DirectionalLight'],
            entityCount: 1,
          },
        ],
      };
    },
    query(_opts) {
      return [];
    },
    // ECS surface mutations (9): spawn / despawn / insertComponents /
    // removeComponents / insertResource / flush / register / clear / delete.
    spawn() {
      return { ok: true, value: { id: 99 } };
    },
    despawn() {},
    insertComponents() {},
    removeComponents() {},
    insertResource() {},
    flush() {},
    register() {},
    clear() {},
    delete() {},
    // Array.prototype mutations (7): push / pop / shift / unshift / splice /
    // sort / reverse. The fixture exposes these directly on world so the
    // alpha-mode get-trap intercepts them as named blacklist members.
    push() {
      return 1;
    },
    pop() {
      return undefined;
    },
    shift() {
      return undefined;
    },
    unshift() {
      return 1;
    },
    splice() {
      return [];
    },
    sort() {
      return [];
    },
    reverse() {
      return [];
    },
    // Map.prototype mutation (1): set (also doubles as ECS `world.set(...)`).
    set() {},
  };
  return world;
}

async function main() {
  // Import the server lazily so an early `node --version` style smoke
  // failure does not pull in @forgeax/engine-console at module load time. The
  // dist/server.mjs entry is the same one engine.startConsole resolves
  // dynamically.
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
  if (typeof startConsoleServer !== 'function') {
    console.error('e2e-cli: missing startConsoleServer export from @forgeax/engine-console/server');
    process.exit(1);
  }

  const world = makeWorld();
  // feat-20260517-console-ecs-plugin-extraction · M3 · w25 update: wire a
  // Registry + registerEcsInspector contribution so the merged sandbox
  // blacklist sees `world.spawn` / `world.despawn` / etc.; case 8 + case
  // 12 below depend on this contribution to surface
  // `inspector-write-denied` for ECS-domain mutating methods.
  const engineFixture = {
    backend: 'webgpu',
    spawn() {
      return { ok: true };
    },
  };
  const assetsFixture = {
    register() {
      return 1;
    },
    get(handle) {
      return { kind: 'mesh', handle };
    },
  };
  const registry = new Registry();
  const wireRoots = registry.registerRoot('world', world);
  if (!wireRoots.ok) {
    console.error('e2e-cli: registry.registerRoot(world) failed:', wireRoots.error);
    process.exit(1);
  }
  registry.registerRoot('engine', engineFixture);
  registry.registerRoot('assets', assetsFixture);
  const ecsResult = registerEcsInspector(registry, world);
  if (!ecsResult.ok) {
    console.error('e2e-cli: registerEcsInspector failed:', ecsResult.error);
    process.exit(1);
  }
  const startResult = await startConsoleServer({
    port: 0,
    host: '127.0.0.1',
    scriptTimeoutMs: SCRIPT_TIMEOUT_MS,
    registry,
  });
  if (!startResult.ok) {
    console.error('e2e-cli: startConsoleServer failed:', startResult.error);
    process.exit(1);
  }
  const handle = startResult.value;
  const port = handle.port;
  // Per cli.ts dispatch, --port / --host are stripped from `rest` (the
  // arguments after the subcommand). So the invocation shape is:
  //   forgeax <subcommand> <positional> --port <N> --host 127.0.0.1
  // We accumulate the port/host suffix once and append per-case.
  const portArgs = ['--port', String(port), '--host', '127.0.0.1'];

  const tmpRoot = await mkdtemp(join(tmpdir(), 'inspector-e2e-'));
  const scriptFile = join(tmpRoot, 'inspect-world.js');
  await writeFile(scriptFile, 'world.inspect()\n', 'utf8');

  try {
    // ── case 1: ecs entities --with Transform (kubectl 4th-path plugin) ─
    {
      const r = await runEcsCli([
        'entities',
        '--with',
        'Transform',
        ...portArgs,
      ]);
      const ok = r.code === 0 && r.stdout.includes('archetypes');
      logCase('inspect-entities', ok, {
        code: r.code,
        stdoutPreview: r.stdout.slice(0, 200),
        stderrPreview: r.stderr.slice(0, 200),
      });
    }

    // ── case 2: ecs components ────────────────────────────────────────────
    {
      const r = await runEcsCli(['components', ...portArgs]);
      const ok = r.code === 0 && r.stdout.includes('Transform');
      logCase('inspect-components', ok, {
        code: r.code,
        stdoutPreview: r.stdout.slice(0, 200),
        stderrPreview: r.stderr.slice(0, 200),
      });
    }

    // ── case 3: ecs systems ───────────────────────────────────────────────
    {
      const r = await runEcsCli(['systems', ...portArgs]);
      const ok = r.code === 0 && r.stdout.includes('systemCount');
      logCase('inspect-systems', ok, {
        code: r.code,
        stdoutPreview: r.stdout.slice(0, 200),
        stderrPreview: r.stderr.slice(0, 200),
      });
    }

    // ── case 4: ecs resources ─────────────────────────────────────────────
    {
      const r = await runEcsCli(['resources', ...portArgs]);
      const ok = r.code === 0 && r.stdout.includes('resourceKeys');
      logCase('inspect-resources', ok, {
        code: r.code,
        stdoutPreview: r.stdout.slice(0, 200),
        stderrPreview: r.stderr.slice(0, 200),
      });
    }

    // ── case 5: ecs world ─────────────────────────────────────────────────
    {
      const r = await runEcsCli(['world', ...portArgs]);
      const ok = r.code === 0 && r.stdout.includes('entityCount');
      logCase('inspect-world', ok, {
        code: r.code,
        stdoutPreview: r.stdout.slice(0, 200),
        stderrPreview: r.stderr.slice(0, 200),
      });
    }

    // ── case 6: script <file> ─────────────────────────────────────────────
    {
      const r = await runCli(['script', scriptFile, ...portArgs]);
      const ok = r.code === 0 && r.stdout.includes('entityCount');
      logCase('script-file', ok, {
        code: r.code,
        stdoutPreview: r.stdout.slice(0, 200),
        stderrPreview: r.stderr.slice(0, 200),
      });
    }

    // ── case 7: eval "<inline-script>" happy ─────────────────────────────
    // w31 fixture expansion (5 entities total: root cube + 2 children +
    // Camera + DirectionalLight) matches the apps/hello/room M7
    // convergence scene; see makeWorld().inspect().entityCount above.
    {
      const r = await runCli(['eval', 'world.inspect().entityCount', ...portArgs]);
      const ok = r.code === 0 && r.stdout.trim() === '5';
      logCase('eval-happy', ok, {
        code: r.code,
        stdoutPreview: r.stdout.slice(0, 200),
        stderrPreview: r.stderr.slice(0, 200),
      });
    }

    // ── case 8: eval write-denied -> inspector-write-denied (-32004) ─────
    {
      const r = await runCli(['eval', 'world.spawn({ component: null })', ...portArgs]);
      const ok =
        r.code !== 0 &&
        r.stderr.includes('inspector-write-denied') &&
        r.stderr.includes('read-only');
      logCase('eval-write-denied', ok, {
        code: r.code,
        stdoutPreview: r.stdout.slice(0, 200),
        stderrPreview: r.stderr.slice(0, 200),
      });
    }

    // ── case 9: script-syntax-error -> -32001 ─────────────────────────────
    {
      const r = await runCli(['eval', 'world.}{', ...portArgs]);
      const ok = r.code !== 0 && r.stderr.includes('script-syntax-error');
      logCase('script-syntax-error', ok, {
        code: r.code,
        stdoutPreview: r.stdout.slice(0, 200),
        stderrPreview: r.stderr.slice(0, 200),
      });
    }

    // ── case 10: script-runtime-error -> -32002 ───────────────────────────
    {
      const r = await runCli(['eval', 'world.nonExistentMethod()', ...portArgs]);
      const ok = r.code !== 0 && r.stderr.includes('script-runtime-error');
      logCase('script-runtime-error', ok, {
        code: r.code,
        stdoutPreview: r.stdout.slice(0, 200),
        stderrPreview: r.stderr.slice(0, 200),
      });
    }

    // ── case 11: script-timeout -> -32003 ─────────────────────────────────
    {
      const r = await runCli(['eval', 'while(true){}', ...portArgs], { timeoutMs: 10_000 });
      const ok = r.code !== 0 && r.stderr.includes('script-timeout');
      logCase('script-timeout', ok, {
        code: r.code,
        stdoutPreview: r.stdout.slice(0, 200),
        stderrPreview: r.stderr.slice(0, 200),
      });
    }

    // ── case 12: fixture injection negative test ──────────────────────────
    // AIUser F-4 P3 merge + Round 2 F-3 fix-up: inject a mutation method
    // call directly through the inspector evidence path and assert the
    // same denied response. The fixture is a synthetic eval body that
    // walks every blacklist member; if any one of them silently succeeds
    // (silent regression), the case fails -> CI red. Charter proposition
    // 6 delta (compile-time grep) + zeta (runtime stderr structural
    // assertion) double gate.
    //
    // Round 2 F-3 fix-up: import MUTATION_BLACKLIST from the @forgeax/engine-console
    // package SSOT so the fixture and the sandbox runtime check the same
    // set (architecture-principles #1 SSOT). Previously the fixture
    // hardcoded 8 ECS-flavoured names; now it dynamically expands to all
    // 17 members (ECS 9 + Array 7 + Map 1) covering both the world root
    // and the engine.assets nested path (F-2 fix-up evidence on the
    // recursive Proxy wrap).
    {
      const consoleIndexMod = await import(
        /* @vite-ignore */ resolve(WORKSPACE_ROOT, 'packages/console/dist/index.mjs')
      );
      const blacklistSet = consoleIndexMod.MUTATION_BLACKLIST;
      if (!(blacklistSet instanceof Set)) {
        console.error('e2e-cli: missing MUTATION_BLACKLIST export from @forgeax/engine-console');
        process.exit(1);
      }
      // Build the eval expression list. Each blacklist method name
      // becomes a `world.<name>(null)` call (or no-arg variant for the
      // four methods that take no parameters under the sandbox stub).
      // The fixture deliberately exercises every blacklist member so a
      // future drop / typo / refactor in MUTATION_BLACKLIST surfaces as
      // a runtime regression on this case.
      const blacklistArr = Array.from(blacklistSet).sort();
      const noArgMethods = new Set([
        'flush',
        'clear',
        'pop',
        'shift',
        'sort',
        'reverse',
      ]);
      const exprs = blacklistArr.map((m) =>
        noArgMethods.has(m) ? `world.${m}()` : `world.${m}(null)`,
      );
      // F-2 fix-up evidence: nested mutation on engine.spawn surfaces
      // inspector-write-denied (the ECS_MUTATING_METHODS contribution
      // covers `spawn` regardless of which root holds the bound function;
      // recursive Proxy wrapping in sandbox.ts ensures the trap fires).
      // `assets.register(null)` was a v1 expectation; in v2 (feat-20260517
      // Registry-driven blacklist) `register` is not in MUTATION_BLACKLIST
      // nor ECS_MUTATING_METHODS, so the call is intentionally NOT denied.
      // Asset write paths land in feat-future-inspector-write-api.
      exprs.push('engine.spawn(null)');

      let allDenied = true;
      const perCall = [];
      for (const expr of exprs) {
        const r = await runCli(['eval', expr, ...portArgs]);
        const denied = r.code !== 0 && r.stderr.includes('inspector-write-denied');
        perCall.push({ expr, code: r.code, denied });
        if (!denied) allDenied = false;
      }
      logCase('fixture-injection-mutation-blacklist', allDenied, {
        blacklistedExpressionsTested: exprs.length,
        blacklistMembersFromSSOT: blacklistArr.length,
        perCall,
      });
    }

    // ── case 13: hierarchy visualisation (feat-20260511-asset-system-v1 / w31) ─
    // AC-08: AI users discover the parent/child structure of the hello-room
    // 3 mesh scene via `forgeax-engine-console-ecs world` (the inspect
    // payload surfaces the `ChildOf` / `Children` active components +
    // a `Transform|ChildOf|MeshFilter|MeshRenderer` archetype row
    // with entityCount=2 for the Sphere + Plane children under the root
    // Cube). Charter proposition 3 machine-readable structure > prose.
    //
    // Gate: run `ecs world`, parse stdout JSON, assert the archetype
    // list contains at least one ChildOf-bearing archetype AND the
    // active components list contains both `ChildOf` and `Children`.
    {
      const r = await runEcsCli(['world', ...portArgs]);
      let parsed = null;
      let archetypeWithParent = null;
      let parentRegistered = false;
      let childrenRegistered = false;
      try {
        parsed = JSON.parse(r.stdout);
        const snapshot = parsed?.result ?? parsed;
        parentRegistered =
          Array.isArray(snapshot?.activeComponents) &&
          snapshot.activeComponents.includes('ChildOf');
        childrenRegistered =
          Array.isArray(snapshot?.activeComponents) &&
          snapshot.activeComponents.includes('Children');
        archetypeWithParent = Array.isArray(snapshot?.archetypes)
          ? snapshot.archetypes.find(
              (a) => Array.isArray(a?.componentNames) && a.componentNames.includes('ChildOf'),
            ) ?? null
          : null;
      } catch (_) {
        // parsed stays null -> case will fail below with the stdout preview.
      }
      const ok =
        r.code === 0 &&
        parsed !== null &&
        parentRegistered &&
        childrenRegistered &&
        archetypeWithParent !== null;
      logCase('hierarchy-visualisation-inspect-world', ok, {
        exitCode: r.code,
        parentRegistered,
        childrenRegistered,
        archetypeWithParent,
        stdoutPreview: r.stdout.slice(0, 240),
      });
    }
  } finally {
    await handle.close();
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const summary = {
    feature: 'feat-20260511-inspector-p0-spike',
    task: 'T-16',
    casesTotal: evidence.length,
    casesPassed: evidence.length - failures,
    casesFailed: failures,
    port,
    cases: evidence,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failures > 0) {
    process.stderr.write(
      `e2e-cli: ${failures}/${evidence.length} case(s) failed; see stdout summary for diagnostics\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('e2e-cli: harness error:', err);
  process.exit(2);
});
