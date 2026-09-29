# State projection cost measurements

Render Bundle submission has a separate [changing-workload report](render-bundle-evidence/README.md)
with two complete 17-case runs, raw samples, RHI Debug failure evidence, and explicit
stable/changing workload tradeoffs. Its [carrier](render-bundle-stress.ts) measures
CPU command submission rather than full-frame FPS.

The comparison runs identical workloads against two source revisions. Production
changes use one current-state projection; the sequential extractor exists only
as a lower-bound measurement and does not include persistent topology or GPU work.

| Carrier | Workload contract | Records |
|:--|:--|:--|
| Node | 60 warm-up + 180 measured frames; 64 / 2,048 entities | Simulation, projection and total CPU median/p95, scanned rows, process heap peak |
| Chromium WebGPU | 30 warm-up + 90 measured frames; 32 / 512 entities | Simulation, draw CPU, submit CPU, submission-completion latency, buffer-write calls/bytes and raw samples |

Both carriers cover small, static, contiguous sparse, scattered, dense,
fragmented-table, historical-empty-table, parent-transform and shared-material
workloads. The Node carrier additionally runs the sequential extractor.
Material changes use the old shared-ref protocol only when measuring a revision
that predates managed content. Node asserts equivalent material output.

```sh
node scripts/bench/run-state-projection.mjs /path/to/baseline /tmp/projection-baseline
node scripts/bench/run-state-projection.mjs . /tmp/projection-candidate
node scripts/bench/run-state-projection-browser.mjs /path/to/baseline /tmp/browser-baseline
node scripts/bench/run-state-projection-browser.mjs . /tmp/browser-candidate
```

The baseline needs installed dependencies and the usual checked WASM payloads.
The browser carrier uses this checkout's browser fixture/compiler preparation and
aliases runtime packages to the requested revision's source. Run the normal
browser shader preparation first. Its temporary test uses a separate Vite cache
and is excluded from the normal browser roster by filename.
Raw browser results are written through a Vitest Browser command into
`result.json`; console forwarding is not the artifact transport. A successful
test process without that file remains a failed measurement.

> [!IMPORTANT]
> Compare matching workloads on the same device. The fixed diagnostic budgets
> are baseline p95 × 1.20 + 0.2 ms for Node total CPU, and baseline p95 × 1.20 +
> 2 ms for browser draw CPU / completion latency. Preserve failed and contended
> runs. Passing one pair on a loaded machine does not establish an improvement.

Submission completion is a fence observation, not a GPU timestamp or a browser
presentation timestamp. These carriers do not measure DOM input latency, a
separate Render Worker, or SAB transport. Heap peak is not allocated bytes or GC
pause time; use a CPU/heap profile to investigate those costs. The browser
functional gate separately checks two consumers, material and mesh changes,
input-array isolation, rebind, removal, and visible restoration.
