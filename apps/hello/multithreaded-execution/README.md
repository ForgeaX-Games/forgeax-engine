# Multithreaded execution reference

Production browser reference for the Web/TypeScript execution tiers. It keeps World, Renderer, and WebGPU co-located in the Engine Worker and uses a persistent Kernel Worker pool only for eligible shared numeric `QuerySpan` work.

## Run

```bash
pnpm --filter @forgeax/hello-multithreaded-execution dev
pnpm --filter @forgeax/hello-multithreaded-execution smoke:browser
pnpm --filter @forgeax/hello-multithreaded-execution bench:production
pnpm --filter @forgeax/hello-multithreaded-execution m0
```

The Vite server and preview send `COOP: same-origin` and `COEP: require-corp`. Open `/?tier=engine-worker`, `/?tier=shared`, or `/?tier=shared&fault=1`. The fault route performs one possible partial write, stops simulation, exposes `shared-kernel-failed`, and allows explicit rebuild to a fresh World identity.

## Evidence gates

| Command | Proves | Threshold |
|:--|:--|--:|
| `m0` | Real response headers, Worker capability matrix, and raw SAB Kernel speedup | Shared p50 speedup >= 1.5x |
| `smoke:browser` | Real production bundle, both Worker tiers, shared dispatch, poison freeze, falsification, and rebuild | All structural assertions pass |
| `bench:production` | Same Engine Worker and workload with forced-inline versus shared raw Host-frame samples | 95% confidence interval lower bound for p95 improvement >= 15% |

The benchmark uses 65,536 rows, 96 iterations per row, 20 warmup frames, and 240 retained samples per tier. It reads end-to-end `host-frame` durations from the App-owned bounded Profiler capture, retains presentation cadence as secondary evidence, and writes raw samples, distribution summaries, and a deterministic 95% bootstrap interval to the active closed-loop evidence directory.

## Module boundaries

| File | Owner |
|:--|:--|
| `src/shared-bootstrap.ts` | Realm-local World population and system registration |
| `src/shared-kernel.ts` | Inline reference function and independently loadable shared Kernel |
| `src/fault-kernel.ts` | Deliberate partial-write fault used only by the fault route |
| `scripts/smoke-browser.mjs` | Browser contract and falsification gate |
| `scripts/bench-browser.mjs` | Production raw-sample product benchmark |
| `m0/scripts/*` | Capability and raw-Kernel admission evidence |

The public architecture entry is [`@forgeax/engine-app`](../../../packages/app#execution-tiers); shared storage and Kernel eligibility belong to [`@forgeax/engine-ecs`](../../../packages/ecs#shared-numeric-kernels).
