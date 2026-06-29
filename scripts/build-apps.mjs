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
const totalGB = os.totalmem() / 1024 ** 3;

// Reserve ~2.5GB for the OS; assume ~2GB per concurrent cold vite build (conservative).
const memBudget = Math.max(1, Math.floor((totalGB - 2.5) / 2));
const auto = Math.max(1, Math.min(cpus, memBudget));

// Explicit override wins, e.g. FORGEAX_BUILD_CONCURRENCY=1 on a busy laptop.
const n = process.env.FORGEAX_BUILD_CONCURRENCY ?? String(auto);

console.error(`[build-apps] ${totalGB.toFixed(0)}GB / ${cpus} cpu -> --workspace-concurrency=${n}`);

const r = spawnSync(
  'pnpm',
  ['-r', '--filter', './apps/**', `--workspace-concurrency=${n}`, '--no-sort', 'run', 'build'],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);

process.exit(r.status ?? 1);
