// Run app vite builds with machine-adaptive concurrency.
// Each app's `build` is a cold `vite build` that loads the shader plugin's
// naga/wgpu-wasm (CPU- and RAM-heavy, no cross-app reuse), so `pnpm --parallel`
// (unbounded) oversubscribes cores and thrashes swap: on a 2-vCPU runner all
// ~69 apps fork at once and each *reports* ~5min while wall-time is ~5m50s.
// Pick a concurrency that fits both core count and a conservative RAM budget.
// Mirror of scripts/typecheck-apps.mjs (same low-RAM oversubscription failure).

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { runnerResources, workspaceConcurrency } from './lib/runner-resources.mjs';

const { cpus, memoryBytes, containerized } = runnerResources();
const totalGB = Math.ceil(memoryBytes / 1024 ** 3);

// Reserve ~2GB for the OS; assume ~2GB per concurrent cold vite build. The 2GB
// per-build figure is the measured cold peak of a texture-heavy learn-render app
// (~1975MB RSS while Basis-encoding its images); a warm DDC build peaks ~350MB,
// so this budget is conservative once the DDC cache (issue #709) keeps builds
// warm. On the 4-core/8GB self-hosted runner this yields concurrency 3
// (floor((8-2)/2)=3), up from 2, shortening the cold worst case without risking
// OOM (3 x 2GB + 2GB OS = 8GB).
const auto = workspaceConcurrency({ cpus, memoryBytes, reserveGB: 2, workerGB: 2 });

// Explicit override wins, e.g. FORGEAX_BUILD_CONCURRENCY=1 on a busy laptop or a
// higher value on a CI runner with a warm DDC cache and RAM headroom.
const n = process.env.FORGEAX_BUILD_CONCURRENCY ?? String(auto);
const sharedManifestIndex = process.argv.indexOf('--shared-input-manifest');
const sharedInputManifest =
  sharedManifestIndex === -1 ? undefined : process.argv[sharedManifestIndex + 1];
const apps = process.argv
  .slice(2)
  .filter(
    (argument, index, argv) =>
      argument !== '--shared-input-manifest' &&
      (index === 0 || argv[index - 1] !== '--shared-input-manifest'),
  );
const filters =
  apps.length === 0
    ? ['--filter', './apps/**']
    : apps.flatMap((app) => ['--filter', `./apps/${app}`]);

console.error(
  `[build-apps] ${totalGB.toFixed(0)}GB / ${cpus} cpu (${containerized ? 'cgroup' : 'host'}) -> --workspace-concurrency=${n}`,
);

const r = spawnSync(
  'pnpm',
  ['-r', ...filters, `--workspace-concurrency=${n}`, '--no-sort', 'run', 'build'],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env:
      sharedInputManifest === undefined
        ? process.env
        : { ...process.env, FORGEAX_SHARED_APP_INPUTS_MANIFEST: resolve(sharedInputManifest) },
  },
);

process.exit(r.status ?? 1);
