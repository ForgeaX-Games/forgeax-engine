// Run app vite builds with machine-adaptive concurrency.
// Each app's `build` is a cold `vite build` that loads the shader plugin's
// naga/wgpu-wasm (CPU- and RAM-heavy, no cross-app reuse), so `pnpm --parallel`
// (unbounded) oversubscribes cores and thrashes swap: on a 2-vCPU runner all
// ~69 apps fork at once and each *reports* ~5min while wall-time is ~5m50s.
// Pick a concurrency that fits both core count and a conservative RAM budget.
// Mirror of scripts/typecheck-apps.mjs (same low-RAM oversubscription failure).

import { spawnSync } from 'node:child_process';
import os from 'node:os';

const cpus = os.availableParallelism?.() ?? os.cpus().length;
// Round to the nominal GB: the kernel reserves a slice, so an "8GB" box reports
// os.totalmem() ~= 7.6GB. Without rounding, floor((7.6-2)/2)=2 silently pins the
// self-hosted runner to concurrency 2 (the value that timed the cold build out);
// round(7.6)=8 recovers the intended 3.
const totalGB = Math.round(os.totalmem() / 1024 ** 3);

// Reserve ~2GB for the OS; assume ~2GB per concurrent cold vite build. The 2GB
// per-build figure is the measured cold peak of a texture-heavy learn-render app
// (~1975MB RSS while Basis-encoding its images); a warm DDC build peaks ~350MB,
// so this budget is conservative once the DDC cache (issue #709) keeps builds
// warm. On the 4-core/8GB self-hosted runner this yields concurrency 3
// (floor((8-2)/2)=3), up from 2, shortening the cold worst case without risking
// OOM (3 x 2GB + 2GB OS = 8GB).
const memBudget = Math.max(1, Math.floor((totalGB - 2) / 2));
const auto = Math.max(1, Math.min(cpus, memBudget));

// Explicit override wins, e.g. FORGEAX_BUILD_CONCURRENCY=1 on a busy laptop or a
// higher value on a CI runner with a warm DDC cache and RAM headroom.
const n = process.env.FORGEAX_BUILD_CONCURRENCY ?? String(auto);

console.error(`[build-apps] ${totalGB.toFixed(0)}GB / ${cpus} cpu -> --workspace-concurrency=${n}`);

const r = spawnSync(
  'pnpm',
  ['-r', '--filter', './apps/**', `--workspace-concurrency=${n}`, '--no-sort', 'run', 'build'],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);

process.exit(r.status ?? 1);
