// Run app typecheck with machine-adaptive concurrency.
// Each app's `typecheck` is a cold `tsc --noEmit` (~1.5GB peak, no incremental
// reuse), so `pnpm --parallel` (unbounded) thrashes swap on low-RAM machines.
// Pick a concurrency that fits both core count and a conservative RAM budget.

import { spawnSync } from 'node:child_process';
import os from 'node:os';

const cpus = os.availableParallelism?.() ?? os.cpus().length;
const totalGB = os.totalmem() / 1024 ** 3;

// Reserve ~2.5GB for the OS; assume ~2GB per concurrent cold tsc (conservative).
const memBudget = Math.max(1, Math.floor((totalGB - 2.5) / 2));
const auto = Math.max(1, Math.min(cpus, memBudget));

// Explicit override wins, e.g. FORGEAX_TYPECHECK_CONCURRENCY=1 on a busy laptop.
const n = process.env.FORGEAX_TYPECHECK_CONCURRENCY ?? String(auto);

console.error(`[typecheck] ${totalGB.toFixed(0)}GB / ${cpus} cpu -> --workspace-concurrency=${n}`);

const r = spawnSync(
  'pnpm',
  ['-r', '--filter', './apps/**', `--workspace-concurrency=${n}`, '--no-sort', 'run', 'typecheck'],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);

process.exit(r.status ?? 1);
