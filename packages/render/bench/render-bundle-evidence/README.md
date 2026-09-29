# Render Bundle measurements and changing-workload evidence

> [!IMPORTANT]
> These are software-GPU CPU-submission diagnostics from 2026-09-25 on a shared host, measured before integration with newer main changes. They do not establish hardware FPS, GPU speed or complete Renderer performance. The measured source base is `787eac1a35f9e1948b6543798c1dad06e10a3565`; [measurement-source.json](measurement-source.json) binds the then-uncommitted source files. Pull-request checks record final integration verification separately.

## Changes justified by the measurements

| Demonstrated problem | Repair | Regression owner |
|:--|:--|:--|
| A single dynamic offset copied a 65,536-element arena for every binding | Read only the selected slice and reuse equal immutable snapshots | `render-bundle-cache.unit.test.ts` |
| Slicing silently clamped invalid ranges and bypassed native validation | Flush direct and forward the original overload and arguments | `render-bundle-validation.fixture.ts` |
| Full command-list copying/replay amplified changing-frame overhead | Retain one sequence; replay its matched prefix once, then stream changes and truncate shortened lists | Cache unit and stress benchmark |
| Per-work RHI Debug replay missed uploads after draw recording but before submission | Apply retained-resource uploads up to the selected command submission | `replay-session.unit.test.ts`, real Browser/Dawn live-data fixture |

The cache keeps two-matching-frame admission without adaptive cooldown, scene rules or revision/history registries. Uniform, vertex and indirect buffer contents remain live. Physical resource handles, draw arguments and order own invalidation. The first mismatch permanently returns that compiled pass to direct recording; device replacement or compiled-graph retirement creates the next opportunity to evaluate reuse.

## Volatile-pass follow-up

The first implementation continued proxying and comparing every frame after invalidation. The table below measures the follow-up that pays one mismatch and then calls the original recorder directly for the rest of the compiled graph lifetime. Both complete runs used identical benchmark bytes (`3dd391fd3967ebeae6c17e69bd35c6a480e705148281b2dc02b111c1ebdc2d3c`) and archived-cache bytes (`e3494157f157729b40ffd5fb8532b5835d04fc8b4f56650c910362b9b5255348`) from worktree base `611f0e9042b3bab0f1425ea42c2f07e1a2a1260f`. D is direct recording and A is the follow-up cache.

The host was busy and non-stationary: run 1 load moved from 39.44 to 42.12 and run 2 from 45.86 to 29.67. Absolute pooled quantiles are retained, including outliers. The paired median compares A and D from the same balanced-order triad and is the more local estimate of steady volatile-path overhead. It does not erase the absolute p95 values.

| Case | Pooled p50 D / A (ms) | Absolute p50 delta | Paired median delta run 1 / run 2 | Pooled p95 D / A (ms) |
|:--|--:|--:|--:|--:|
| stable | 5.524 / 1.792 | -67.6% | -68.9% / -70.5% | 10.269 / 12.241 |
| first-change | 23.353 / 25.005 | +7.1% | +2.0% / -1.3% | 38.500 / 38.811 |
| last-change | 18.722 / 23.279 | +24.3% | +1.8% / +2.8% | 40.445 / 39.651 |
| sparse-change | 18.081 / 18.267 | +1.0% | +1.2% / -0.0% | 38.110 / 36.175 |
| count-churn | 4.468 / 4.521 | +1.2% | +1.0% / +2.4% | 8.045 / 13.427 |
| empty-refill | 4.003 / 4.037 | +0.9% | +0.1% / +2.6% | 10.473 / 8.390 |
| reverse-order | 4.603 / 4.555 | -1.0% | +1.0% / -2.2% | 15.340 / 16.075 |
| resource-churn | 4.815 / 4.813 | -0.0% | +0.6% / -0.1% | 18.450 / 11.230 |
| offset-churn | 5.393 / 5.131 | -4.9% | -0.1% / -0.3% | 15.677 / 10.980 |
| large-offset-slice | 1.760 / 0.575 | -67.4% | -59.2% / -67.8% | 2.407 / 0.917 |
| live-buffer-data | 4.790 / 1.630 | -66.0% | -71.3% / -69.6% | 8.399 / 16.159 |
| two-frame-runs | 7.516 / 7.123 | -5.2% | -1.6% / -0.2% | 20.181 / 10.896 |
| eight-frame-runs | 5.051 / 4.676 | -7.4% | -5.6% / -1.9% | 17.758 / 10.291 |
| mixed-passes | 19.946 / 12.785 | -35.9% | -34.3% / -35.6% | 39.456 / 29.663 |
| draw-pressure-stable | 73.757 / 22.243 | -69.8% | -70.4% / -72.4% | 128.638 / 69.388 |
| draw-pressure-churn | 77.038 / 77.657 | +0.8% | +1.2% / +4.8% | 123.774 / 132.958 |
| resource-soak | 4.293 / 4.303 | +0.2% | +0.2% / +0.3% | 7.848 / 8.540 |

Steady volatile paths now track direct recording: per-run paired medians stay within 4.8% across prefix, suffix, sparse, count, empty, order, handle, offset, 8,192-draw churn and the 300-triad resource soak. The pooled `last-change` p50 remains 24.3% higher because the two variants crossed the distribution midpoint under changing host load; its paired medians are +1.8% and +2.8%, and its pooled p95 is 2.0% lower. Stable 512- and 8,192-draw paths retain 67.6% and 69.8% p50 reductions. Pooled p95 still has scheduling outliers in both directions, including stable and live-buffer cases, so these software-GPU diagnostics do not establish production frame-time tails.

Raw samples are [volatile run 1](volatile-performance-1.json) and [volatile run 2](volatile-performance-2.json). The summary script verifies every displayed row against those files as well as the original three-way measurements.

## Changing and stress coverage

| Layer | Executed coverage before integration |
|:--|:--|
| Cache | 1,000 deterministic changing frames over eight Null passes; growth/shrink/empty/reorder/handle/offset changes; create/finish/execute failures |
| Real World/Renderer | Repeated spawn, cull, delete and resize cycles with a direct-renderer oracle |
| Browser WebGPU and Dawn | Five cases per backend; 448 cached frames and matching direct frames; pixel comparison every frame; selected fresh-device replay |
| Multi-pass pressure | Eight passes of 128 draws over 64 frames: 65,536 draws per path; replay a 1,024-work prefix |
| Live uploads | One bundle over 96 frames; uniform upload after draw recording; both cold and warmed replay |
| Source-built WASM/WebGL2 | 60 stable native executions and 96 alternating populated/empty cached frames with readback |

The original failing live-data tape is retained unchanged in the delivery artifact archive, outside this source-only repository: digest `sha256:1054ad595f6ed606f2980f559475f53e508a8de41aca7df5be38e49e83aafef4`, selected work 19. After the replay fix, fresh-device replay through built packages returns green `[0, 255, 0, 255]` for every pixel. Selected stress tapes have zero unseeded resources. The [live-data fixture](../../../runtime/src/__tests__/render-bundle-stress.fixture.ts) synthesizes the capture and verifies fresh-device replay in both Browser and Dawn; it does not require a committed binary fixture.

## Pre-integration validation scope

Complete Render (2,367 tests), Runtime (2,797 passing tests), RHI Debug (179 tests), canonical Dawn (21 groups), and all 82 hello/learn smoke gates passed before integration. The smoke fleet retained its normal 60-frame receipts and falsifiers. The test-helper type correction additionally passed seven affected files (106 tests), strict typecheck and AC-08.

The canonical Browser command passed groups 1-46, with the built-in retry used for group 46, then failed group 47 twice at the standard 300-second process limit. Unchanged groups 47-49 passed diagnostic continuation under a 900-second outer budget. Group 47 passed all 18 tests but took 301.798 seconds including process setup/cleanup. This completes local roster execution with existing conditional skips, not a passing canonical Browser command. Final pull-request CI must pass separately before merge; no test or pixel threshold was weakened.

## Performance protocol and results


Two full runs use identical benchmark bytes (`2bd6051c52e11a22132f21b433565cfc6baff708732b8cf541034fea30d88830`) and archived cache bytes (`55a0a720b52b9530fca6d21dd0119a28db38eb3f939dc80c165dde9dc0ce9f69`). D = direct recording; B = cache before this stress follow-up; A = current cache. B is the initial implementation, not the repository base without bundles.

Each case uses all six order permutations, 12 warmup triads and 60 measured triads per run. The resource soak uses 300 measured triads. Tables pool 120 observations per variant per case, or 600 for the soak, without trimming. Quantiles interpolate at `(n - 1) * p`. Raw samples, per-run distributions and host load remain in [run 2](performance-2.json), [run 3](performance-3.json) and the [summary script](summarize.mjs). Recompute with `node packages/render/bench/render-bundle-evidence/summarize.mjs`.

CPU submission spans command encoder creation through `queue.submit` return. Encoding measures only direct recording or `cache.encode`; finish and submit calls are separate fields. Input mutation, resource setup, explicit GC and GPU completion are outside timing. This is a synthetic 1x1 target with indexed draws and per-draw buffer/group binding, not a complete Renderer frame. Host: Intel Xeon Gold 6133, 72 logical CPUs, Node 24.19.0; Dawn uses Mesa 25.2.8 llvmpipe. Browser correctness uses SwiftShader.

| Case | Draws x passes | CPU submission p50 D / B / A (ms) | CPU submission p95 D / B / A (ms) | After vs direct p50 |
|:--|--:|--:|--:|--:|
| stable | 512 x 1 | 4.513 / 3.726 / 1.582 | 8.686 / 11.655 / 3.479 | -64.9% |
| first-change | 2048 x 1 | 16.928 / 24.604 / 20.427 | 35.675 / 46.066 / 44.295 | +20.7% |
| last-change | 2048 x 1 | 17.730 / 24.896 / 20.203 | 39.366 / 48.015 / 41.310 | +13.9% |
| sparse-change | 2048 x 1 | 17.063 / 24.166 / 20.420 | 37.039 / 43.376 / 42.474 | +19.7% |
| count-churn | 512 x 1 | 4.175 / 5.789 / 4.670 | 6.029 / 10.239 / 9.218 | +11.8% |
| empty-refill | 512 x 1 | 3.799 / 2.183 / 0.992 | 8.111 / 12.272 / 8.593 | -73.9% |
| reverse-order | 512 x 1 | 4.122 / 6.009 / 5.368 | 10.467 / 11.284 / 10.279 | +30.2% |
| resource-churn | 512 x 1 | 4.204 / 5.883 / 5.223 | 11.571 / 11.388 / 9.727 | +24.2% |
| offset-churn | 512 x 1 | 4.339 / 6.374 / 5.578 | 8.802 / 11.878 / 10.205 | +28.5% |
| large-offset-slice | 128 x 1 | 1.220 / 432.611 / 0.523 | 2.145 / 533.501 / 0.924 | -57.1% |
| live-buffer-data | 512 x 1 | 4.326 / 2.372 / 1.274 | 13.094 / 4.019 / 1.881 | -70.6% |
| two-frame-runs | 512 x 1 | 4.253 / 5.890 / 4.709 | 13.707 / 9.289 / 5.984 | +10.7% |
| eight-frame-runs | 512 x 1 | 4.341 / 2.592 / 1.468 | 7.940 / 10.881 / 8.406 | -66.2% |
| mixed-passes | 256 x 8 | 16.777 / 16.071 / 12.169 | 40.770 / 28.356 / 34.560 | -27.5% |
| draw-pressure-stable | 8192 x 1 | 72.624 / 49.845 / 24.434 | 124.862 / 87.267 / 69.174 | -66.4% |
| draw-pressure-churn | 8192 x 1 | 71.367 / 115.905 / 82.616 | 137.389 / 176.136 / 146.723 | +15.8% |
| resource-soak | 128 x 4 | 4.539 / 6.284 / 5.281 | 8.942 / 11.556 / 10.347 | +16.3% |

| Case | Encoding p50 D / B / A (ms) | Encoding p95 D / B / A (ms) |
|:--|--:|--:|
| stable | 3.619 / 2.055 / 0.762 | 6.881 / 4.221 / 1.530 |
| first-change | 13.915 / 21.542 / 17.818 | 25.957 / 38.272 / 30.509 |
| last-change | 14.516 / 21.792 / 17.243 | 26.926 / 37.521 / 29.272 |
| sparse-change | 14.311 / 21.457 / 17.664 | 26.396 / 37.391 / 29.987 |
| count-churn | 3.491 / 5.051 / 3.946 | 4.499 / 6.243 / 5.657 |
| empty-refill | 3.279 / 1.607 / 0.453 | 6.965 / 9.470 / 7.261 |
| reverse-order | 3.438 / 5.179 / 4.604 | 6.742 / 9.456 / 8.355 |
| resource-churn | 3.454 / 5.078 / 4.451 | 6.699 / 9.333 / 7.776 |
| offset-churn | 3.523 / 5.431 / 4.709 | 7.026 / 9.359 / 8.571 |
| large-offset-slice | 0.918 / 431.862 / 0.210 | 1.652 / 532.856 / 0.348 |
| live-buffer-data | 3.572 / 1.661 / 0.585 | 4.965 / 2.393 / 0.919 |
| two-frame-runs | 3.518 / 5.157 / 3.951 | 4.560 / 6.695 / 4.877 |
| eight-frame-runs | 3.573 / 1.770 / 0.742 | 6.666 / 7.551 / 6.458 |
| mixed-passes | 13.952 / 13.496 / 9.524 | 19.767 / 18.189 / 11.833 |
| draw-pressure-stable | 56.579 / 34.379 / 11.643 | 95.889 / 54.742 / 18.656 |
| draw-pressure-churn | 55.786 / 94.339 / 64.623 | 106.111 / 156.729 / 113.568 |
| resource-soak | 3.547 / 5.172 / 4.216 | 6.775 / 9.453 / 7.820 |

Stable 8,192-draw CPU submission p50 falls from 72.624 ms direct to 24.434 ms cached (66.4%). Stable 512 draws fall 64.9%, live-buffer updates 70.6%, and mixed passes 27.5%. The oversized-offset case falls from 432.611 ms in the old cache to 0.523 ms, demonstrating removal of work proportional to unused arena length.

Changing 8,192-draw sequences improve from 115.905 ms in the old cache to 82.616 ms, but remain 15.8% slower than 71.367 ms direct. Other volatile cases remain 10.7%-30.2% slower at p50. A two-frame stable interval barely reaches bundle construction and does not amortize it. p95 regresses against direct in several changing cases and in short-burst cases; these results do not establish universally improved frame pacing. The existing two-frame admission plus one retained sequence remains a bounded tradeoff. Further admission policy would require representative application traces and additional evidence, rather than tuning to these synthetic cases.

## Native failure and memory limits

The initial [full run log with local paths redacted](native-abort.txt) aborted with `std::system_error: Invalid argument` / SIGABRT after 14 case summaries, entering 8,192-draw pressure. It did not checkpoint raw samples and is excluded from pooled statistics. Direct, initial-cache and current-cache isolated pressure runs passed; direct resource replacement under GDB also passed without a backtrace.

The harness now retains the Dawn `create()` owner for its full lifetime, matching its lifetime contract, and checkpoints completed cases. The same native abort signature was later reproduced immediately after the benchmark intentionally rejected an empty case name with `Unknown stress case`. This narrows the symptom to Dawn teardown after a JavaScript exception rather than 8,192-draw pressure, but does not establish a native root cause or repair. Both original complete runs and both volatile follow-up runs exited zero.

The 300-triad resource soak observed combined-process post-GC JS heap of approximately 5.87-6.03 MB and RSS of 569-579 MB. The process includes all three variants and timing samples. This is neither per-variant allocation nor GPU memory evidence, and does not establish leak freedom.

## Reproduction

`cache-before.ts` is the archived initial implementation used only for the three-way comparison. It is not a runtime export. The raw data records hashes of the measured compiled benchmark and baseline bytes; rebuilding at a different path or with another toolchain can change those executable hashes.

```bash
node packages/render/bench/render-bundle-evidence/summarize.mjs
node node_modules/tsup/dist/cli-default.js packages/render/bench/render-bundle-evidence/cache-before.ts \
  --format esm --out-dir artifacts/render-bundle/baseline
node node_modules/tsup/dist/cli-default.js packages/render/bench/render-bundle-stress.ts \
  --format esm --external webgpu --out-dir artifacts/render-bundle/bench
node scripts/ci/local-graphics.mjs --probe dawn -- \
  node --expose-gc artifacts/render-bundle/bench/render-bundle-stress.js \
  artifacts/render-bundle/new-measurement.json artifacts/render-bundle/baseline/cache-before.js
```

Use a fresh output filename; creation is exclusive. Run measurements separately from heavy graphics gates. Optional isolation filters do not replace the complete workload roster.
