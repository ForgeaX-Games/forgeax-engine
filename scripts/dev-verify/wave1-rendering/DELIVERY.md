# Wave 1 Engine P0 delivery

This change delivers the Engine P0 surface (items 1-5 and observation,
budget, and recovery) from the Voxel rendering infrastructure strategy. The
implementation baseline is `634c561d12a3132f5730de25fe5cf74f5a6e2ee5`.
Later evidence and smoke-test changes do not change that runtime baseline.

> [!NOTE]
> This is an Engine PR handoff. P1/P2, an npm release, and Voxel's real
> destruction/physics joint acceptance are outside this delivery. The branch
> is submitted for review and is not merged by this task.

## Result and evidence

| Concern | Result | Reproduction and evidence |
|:--|:--|:--|
| Ordinary scene updates | One retained update operation handles geometry, material, root and instance edits; conservative extraction enters the same projection | Mixed-World oracle tests, temporal retry tests, and upload accounting in [the recipe guide](README.md#one-retained-scene-update-flow) |
| Wall and ground shadows | Shadow draws consume each mesh's actual layout; colored 64-byte vertices no longer use a 48-byte shadow stride | Paired RHI tapes, 20 matched draws per capture, and [before/after images](README.md#shadow-layout-regression) |
| Materials and dynamic meshes | Public recipe covers multiple material slots, vertex colors, emissive patterns, aperture replacement, successors and retirement | P0 and materials browser fixtures; screenshots are generated locally under `artifacts/wave1-rendering/` |
| Sun, sky and air | Atmosphere background follows the selected directional sun; normal geometry occludes the disc; existing VolumetricFog provides the independently switchable air layer | Sun ROI, sky-only view, atmosphere/volume controls, successful-submit publication and retry tests |
| TAA | Direct YCoCg bound reduction preserves all three GPU output attachments | Byte equality against the pinned shader, five GPU falsifiers, raw hardware timing archives |
| Recovery | The first replacement-device draw consumes the current World, including a mesh never submitted before loss | Two injected host-loss cycles, actual completed GPU frames, first/steady/unload images and counters |
| World asset identity | Mesh projection is keyed by retained composition slot; graph deduplication uses resolved GPU resource identity | Two real Worlds with equal numeric asset handles and different meshes; source/epoch switch tests |

## Cost and limits

TAA measurements use Apple M4 Pro / Metal, 1920 by 1080, 420 submitted frames,
and ordinals 121-420 for statistics. GPU timestamp interval-union p50 was
11.993-14.025 ms for the two baseline runs and 8.651-8.847 ms for the two final
runs. The corresponding p95 values were 21.365-24.904 ms and 16.450 ms.
These are frame-work interval unions, not exclusive TAA timings or FPS.
Raw reports, hardware facts and shader fingerprints are retained in the
[performance evidence](evidence/previous-run/performance-summary.json).

The mixed CPU benchmark was noisy under concurrent builds; no CPU latency
improvement is claimed. Its deterministic RHI-null upload probe changed from
200 calls / 405,680 bytes to 120 calls / 215,600 bytes. That is software upload
accounting, not measured hardware execution time.

Atmosphere retains a 128 by 128 by 6 RGBA16F cube (786,432 bytes), 64 bytes of
parameters and 216 bytes of background vertices. It updates six faces only
when its source signature changes and publishes the signature after a
successful submission. Recovery can perform cold work for newly introduced
World content; it does not promise zero first-frame uploads or pipeline work.
The loss fixture injects the host's `unknown` signal and does not establish
native driver-reset survival.

## Fixed SDK

| Field | Identity |
|:--|:--|
| Version | `0.0.0-dev.634c561d12a3` |
| Engine commit | `634c561d12a3132f5730de25fe5cf74f5a6e2ee5` |
| Archive | `forgeax-sdk-v0.0.0-dev.634c561d12a3.zip` |
| SHA-256 | `fd60694bdaa0e60ef0c0e582318eb626133c30210d5b45e8bae50e33b8f0f706` |
| Archive bytes | 324182225 |
| Physical packages | 62 |
| Local durable directory | `artifacts/sdk-wave1-p0/634c561d12a3132f5730de25fe5cf74f5a6e2ee5/` in the primary checkout |

The SDK was built in a detached checkout of the implementation commit and
verified from that exact ZIP. The verifier reports `ok: true` and checks
project creation, skill verification, checking, tests, typechecking, build,
packaging, dev startup and preview. The source-template browser journey
checks real rendering, input, movement, camera, animation and FixedTick.
Its declared long collision journey omission remains
`passed-with-omissions`; it is not claimed as full Voxel acceptance.

## Validation record

| Gate | Result |
|:--|:--|
| Render unit/contract suite | 394 files, 1,620 tests passed; no type errors |
| Runtime unit suite | 342 files passed / 4 skipped; 2,763 tests passed / 20 skipped |
| Final mesh identity, production integration and temporal retry tests | 3 files, 17 tests passed |
| `pnpm test:browser` | All 25 groups passed: 139 files passed / 4 skipped; 262 tests passed / 8 skipped / 1 todo |
| `pnpm test:dawn` | Full command exited 0, including the full app build and isolated/compact/direct-light partitions |
| Final rebuilt GPU-driven Dawn tests | 2 files, 4 tests passed |
| Final rebuilt TAA equivalence Dawn test | 1 file, 2 tests passed |
| Final rebuilt P0/material/recovery browser tests | 3 files, 7 tests passed |
| SDK build and exact-ZIP verification | Passed; identity above |
| Changed package source lint, typecheck and code line limit | Passed; changed legacy smoke scripts use `node --check` because repository Biome configuration excludes them |

The fixed-commit owner build was repeated after the last private parameter
rename (`meshes` to `meshBySlot`). The focused GPU-driven, TAA and P0 browser
gates above use those rebuilt outputs. The full browser and Dawn runs already
contained the same functional namespace and resource-deduplication fixes.

Raw command logs are generated under the local
`artifacts/wave1-rendering/validation/` directory when the delivery gates run;
compressed logs stay out of the Engine Git history because the repository has
a zero-binary invariant. A contributor P0 test attempted in the SDK build
checkout failed during shader-catalog setup before running assertions; that
failure remains described by the tracked validation record and is not counted
as a successful test. The exact-ZIP consumer verifier and the correctly
prepared contributor fixture both passed.

Raw smoke reports and logs are produced in the local
`artifacts/wave1-rendering/` directory. Binary archives are intentionally not
tracked; the reviewable JSON reports retain the command plan, status and
digests. No failure output was edited to satisfy formatting or receipt checks.

The smoke runners record their complete command plan, stdout, exclusions and
results under `dawn-smokes/` and `additional-smokes/`. Every one of the 80
canonical-roster commands exited 0 without timeout or skip. The strict
FrameReceipt aggregate nevertheless failed: only cinder-fall emits the new
canonical receipt; the other producers retain legacy output. Current base CI
explicitly runs the same roster with `--allow-blocked` while that migration
remains incomplete. This PR does not change that parser or promote legacy
counts into canonical receipts. Callback/attempt counters alone do not prove
completed GPU frames; the P0 fixture uses actual completed receipts.

The supplemental run initially passed 10 of 14 commands. Its retained failures
found an obsolete texture POD in the coordinate-systems smoke and missing Dawn
host shutdown in format-tier1. The former now constructs the current
`TextureAsset.shape`/`mips` contract and counts only successful completed draws;
its rerun completed 300 frames, all three pixel sites, and zero renderer errors.
The latter now finishes awaited renderer disposal, releases its surface and GPU
reference, then exits; its 300-frame rerun exits 0. Original failures remain in
the artifact set. A failed run's printed `frames=300` must not be interpreted
as 300 successful frames.

Three smoke owners now count successful `FrameReceipt.completed` results and
enforce their requested smoke budget: MSAA completed 600 frames across its two
control passes, transmission completed 309 frames while its four tests passed,
and Happy Blob completed 300 frames with animation delta 0.04117. Happy Blob
also publishes its material-time mutation through `sharedRefs.markChanged`.
The no-draw and MSAA-no-op falsifiers still fail for the intended reasons.
Ordinary transmission Dawn tests remain bounded and pass without the explicit
smoke marker. These are test-only changes after the SDK baseline.

The two IBL examples are already excluded from the canonical gate because of
reference-image stability. Both were nevertheless executed here and rebuilt
and rerun in an isolated checkout of base
`974757dcacd9cb25ba3d902a9fe5a573693ec265`, with the same asset commit and lockfile.
They fail their 0.05 image threshold on both revisions:

| IBL example | Exact base mean absolute delta | Implementation delta | Legacy loop count on each |
|:--|--:|--:|--:|
| Irradiance | 0.07083 | 0.07083 | 332 |
| Specular | 0.08039 | 0.08039 | 332 |

Both runs reached asset loading and final queue/readback completion without
logged draw errors. Their scalar metrics reproduce the baseline failure;
they do not establish byte-identical images. No reference image or threshold
was changed. The baseline source/build identities and raw logs are under
[`ibl-baseline-974757dc`](evidence/previous-run/ibl-baseline-974757dc/).
These remain explicit failed reference comparisons, not passing smoke gates.

The [execution overview](evidence/previous-run/smoke-execution-overview.json)
retains every canonical command's original status and log digest and binds
the five successful owner rechecks to their test-source hashes. Together,
the supplemental commands have 12 successful original/recheck results and
the two reproduced IBL reference failures. The original 10/14 report remains
unchanged so the timeout and obsolete-texture failures stay auditable.

Historical tracked reports are archived under `evidence/previous-run/`. Their
embedded paths and hashes describe the original run. New runs still write to the
ignored `artifacts/wave1-rendering/` output directory.
