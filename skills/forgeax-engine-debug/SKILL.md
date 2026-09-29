---
name: forgeax-engine-debug
description: >-
  ForgeaX troubleshooting router with RHI Debug first for difficult rendering failures.
  Use when rendering is wrong, CI is slow or flaky, tests fail, asset hot reload fails,
  or a clean worktree behaves differently.
---

# forgeax-engine-debug

> Rendering/test/CI symptom index with diagnostic signals and repair owners. Package READMEs and AGENTS.md own design contracts.

> [!IMPORTANT]
> **A broken demo can expose a real Engine gap.** Repair the owner rather than adding demo-side placeholders, manual rAF, or ad-hoc asset fetches that hide it. Trace the call chain into Engine before choosing the fix.

## Rendering: RHI Debug first

> [!IMPORTANT]
> For difficult or unexplained rendering failures, load
> [`forgeax-engine-rhi-debug`](../forgeax-engine-rhi-debug/SKILL.md) before
> speculative fixes. Capture the real failing frame and use work, binding,
> resource, and pixel evidence to choose the owning subsystem. Do not exhaust
> this symptom catalogue or add broad logging before taking that route.

Black/missing output, incorrect lighting or shadows, flicker, post-processing
artifacts, and browser/backend divergence all take this route. A concrete
startup, asset, or schema error can go directly to its named owner. Treat the
historical causes below as hypotheses to check against current evidence; use
the RHI Debug skill's recovery path when capture or replay is unavailable.

## English-only guidance gate

CI checks all tracked AGENTS.md/SKILL.md files and text under skills, including
references and SDK templates, through `python3 scripts/forgeax/check-agent-docs-english.py`.
Translate prose and example comments, update heading links, and preserve command/API
identifiers. The CI guide owns scope and regression commands; ordinary localized
README files outside skills remain permitted.

## CI diagnosis and iteration

In an Engine contributor checkout, open
[`scripts/ci/README.md`](../../scripts/ci/README.md) before changing CI scheduling,
caching or recovery. It owns the full-run time budget, measurement and acceptance
rules, and exact `ci:focus` commands. Installed game skills should route repository
CI work to an Engine contributor checkout; game tests use the project's own CLI.

| Symptom | First action |
|:--|:--|
| Browser scheduler test fails after adding a test owner | Check deterministic assignment, complete ownership and load balance through the [scheduler regression](../../scripts/ci/README.md#focused-startup-and-shader-dependency-regressions); arbitrary test pairs need not stay on different shards. |
| Snake process E2E fails during bind, or extracted grazing shader lacks a helper | Use the [focused startup and shader regressions](../../scripts/ci/README.md#focused-startup-and-shader-dependency-regressions); retain real socket/GPU assertions and inspect the structured failure before rerunning. |
| AC-08 rejects a GPU fixture's raw-device call | Check each call against the [native validation fixture boundary](../../scripts/ci/README.md#native-rhi-validation-fixture), register only exact test paths for validation/disposal, and rerun the artifact-storage policy regression. |
| Preview template smoke stalls on Catalog | Follow [Catalog startup diagnosis](../../scripts/ci/README.md#preview-catalog-startup): separate ESM capture, metadata inventory, source leases and material compilation. Use `FORGEAX_WORKSPACE_TIMING=1`; preserve the 90-second deadline, producer failures, freshness fence and full template roster. |
| Aggregate reports a missing shard after successful artifact downloads | Check that the product-head downloader supports the workflow's `--merge-multiple` flag; follow [build inputs and recovery](../../scripts/ci/README.md#build-inputs-and-recovery) and retain SHA, digest, and complete-roster admission. |
| Full Smoke producers pass after retry but aggregation reads the earlier failed row | Follow [build inputs and recovery](../../scripts/ci/README.md#build-inputs-and-recovery): select the newest immutable artifact per shard through the shared downloader; preserve old failures and require the full exact-commit aggregate. |
| Focus or GPU timing contract source recovery fails with missing or stale wgpu provenance | Follow [unpublished wgpu source recovery](../../scripts/ci/README.md#focused-ci-and-unpublished-wgpu-source): use the shared verified cache/release/source Action, then rerun current-head tests. Best-effort install is not input admission. |
| An explicit 300-frame Smoke request reports only 60 or omits independent owners | Follow [explicit Smoke budgets](../../scripts/ci/README.md#explicit-smoke-frame-budgets): use `ci:focus --kind smoke --select all --frames 300`, require complete same-HEAD aggregation, and retain separate assertion/composite semantics. Default CI stays 60; never add short lifecycles together. |
| Render Worker browser group exceeds its process deadline | Keep the four pressure/recovery cases in their own group; follow the [CI operating guide](../../scripts/ci/README.md#local-software-graphics-on-linux--linux-x64). |
| Linux/Linux Dawn returns no adapter or the system ICD overrides a working local driver | Use the [local software graphics lane](../../scripts/ci/README.md#local-software-graphics-on-linux--linux-x64); preserve actual adapter identity and full gate failures. |
| Multithread source recovery demands unrelated Pack files before tests | Verify the core/shared consumer contract and scoped shader preparation in [source recovery](../../scripts/ci/README.md#multithread-coreshared-source-recovery); run both Node preparation and Vitest execution regressions. The executable app still builds once; browser scripts run from its app directory and retain all gates. |
| Multithread smoke and benchmark each spend minutes in Vite build | The app transfer contains shader/Pack projections only. Build the executable app once with the shared-input manifest, then run both assertion scripts. A missing index must report its absolute path. Local package commands intentionally rebuild. See [benchmark preparation](../../scripts/ci/README.md#browser-multithread-benchmark-input-materialization). |
| Each browser shard compiles point-shadow shaders again | Check the shared manifest's `shaderBuild` receipt and the profile producer's concrete admission failure. Compare executable compiler inputs; omitted wasm-pack `.gitignore` is packaging metadata. Matching compiler inputs reuse existing bytes; missing or stale receipts rebuild through the source owner. See [CI preparation](../../scripts/ci/README.md#avoid-unused-rendering-test-output). |
| Rendering tests spend time on screenshots or GPU readback | Separate required frame submissions from consumed pixel observations; use the [test-output route](../../scripts/ci/README.md#avoid-unused-rendering-test-output) and preserve all pixel oracles and negative controls. |
| Shared runtime content times out with two Browser renderers | Inspect renderer/submission/capture progress, preserve all seven pixel states, and follow the [owner completion budget](../../scripts/ci/README.md#shared-runtime-content-browser-completion-budget) before changing scheduling. |
| Eight adjacent runtime Renderer files exceed the Browser process deadline without an assertion failure | Keep the measured two-group boundary in the [owner completion budget](../../scripts/ci/README.md#shared-runtime-content-browser-completion-budget); preserve all eleven tests and unchanged deadlines. |
| Runtime browser group reaches 300 seconds while its files pass separately | Check the [material publication process boundary](../../scripts/ci/README.md#material-publication-browser-process-isolation); check both material-publication and render-publication owners; retain each complete journey and unchanged deadlines, then verify the regrouped neighbors and complete roster. |
| Runtime Browser group expires with capture/replay owners unfinished | Follow the [measured process boundaries and four-file Runtime cap](../../scripts/ci/README.md#multi-camera-browser-process-isolation); retain all assertions and deadlines, including the real multi-camera Worker capture/replacement singleton, then verify complete singletons, regrouped neighbors and the full roster. |
| GBuffer capture/replay Browser group times out or reports a cleanup error | Preserve the original fixture failure and follow the [capture/replay process boundary](../../scripts/ci/README.md#gbuffer-capturereplay-browser-process-isolation); passing intermediate pixels do not override a failed process. |
| Standard displacement Browser group reaches its process deadline | Follow the [displacement process boundary](../../scripts/ci/README.md#standard-displacement-browser-process-isolation); retain every pixel oracle and replay, then verify the regrouped neighbors. |
| Decal capture/replay passes alone but its mixed Browser group times out | Follow the [decal process boundary](../../scripts/ci/README.md#decal-capturereplay-browser-process-isolation); retain both 60-frame paths, live/replay pixels, draw-removal falsifiers and unchanged deadlines. |
| A mixed runtime Browser group reaches 300 seconds after roster additions | Follow the [runtime rendering process budget](../../scripts/ci/README.md#runtime-rendering-browser-process-budgets); retain isolated long owners, all journeys and deadlines, then verify regrouped neighbors and complete CI. |
| Normal/bump material and replay journey exhausts a mixed Browser group | Follow the [normal/bump process boundary](../../scripts/ci/README.md#normalbump-browser-process-isolation); preserve both render paths, every 60-frame case and replay assertion, then verify regrouped neighbors and the full roster. |
| Dawn fixture exhausts time, memory or string length while percent-encoding a large shader manifest | Use the [large shader fixture guide](../../scripts/ci/README.md#large-shader-fixtures-and-cache-recovery-tests); preserve JSON bytes, real fetch, and explicit URL cleanup. |
| App build fails while loading an importer | Read `detail.loadError` and its missing path; follow [importer failure recovery](../../scripts/ci/README.md#importer-failures-during-ci-builds) before editing GUID declarations. |
| M6 replay emits validation errors or its viewer falsifier times out | Check [M6 replay and viewer falsifiers](../../scripts/ci/README.md#m6-replay-and-viewer-falsifiers); require valid attachment descriptors, terminal readback, and an active falsifier. |
| Recovery fails at `compile-graph` with an unavailable fullscreen pipeline | Compare graph and prewarm identities using the [fullscreen recovery guide](../../scripts/ci/README.md#fullscreen-feature-recovery-identity), then rerun the real loss-cycle browser owner. |
| Transmission Smoke reaches the Node heap limit | Compare the full and focused fleet Node ceilings using the [Smoke heap budget](../../scripts/ci/README.md#smoke-node-heap-budget); preserve all cases, pixel checks and frame counts, then require complete latest-head CI. |
| A CI job exceeds twelve minutes | Measure compiler, fixture, readback and packing work inside the job; start with the [workload investigation](../../scripts/ci/throughput-2026-09-19.md). |
| A Dawn shard reaches its job deadline while its assertions keep passing | Compare completed lane duration and per-group `process-result` times, then rebalance the complete roster through [`dawn-gate-roster.mjs`](../../scripts/ci/dawn-gate-roster.mjs) and the [Dawn workload guide](../../scripts/ci/README.md#dawn-fixture-cold-shader-preparation); retain serial GPU work and the required aggregate. |
| Hosted Windows nightly is cancelled during hello-triangle Vite build | Compare package preparation and Vite timestamps with the [hosted nightly budgets](../../scripts/ci/README.md#hosted-nightly-probe-budgets); preserve the smoke and Dawn probes before changing the per-platform limit. |
| Process cleanup fails after a short TERM grace | Inspect `phase=group-exit` versus `phase=stdio-close`; use the [completion regression](../../scripts/ci/README.md#process-cleanup-completion-observation) before retrying. |
| Full CI is slow | Inspect the current run's dependency chain and separate build, transfer, queue and execution time. For expensive rendering loops, follow the CI guide's 60-frame window and preserve phase transitions, falsifiers and receipt validation. |
| CI bounds tests require retired hydration steps or old startup limits | Compare the clean-base reproduction with current [regression ownership](../../scripts/ci/README.md#ci-regression-ownership); assert the delegated preparation, ordering and existing budgets instead of restoring duplicate workflow commands. |
| A job only shows exit 1, timeout or SIGKILL | Open its CI child attempt summary and `process-start` / `failure-detail` records for the command, last output, silence duration and cleanup result. Follow [child failure diagnostics](../../scripts/ci/README.md#child-failure-diagnostics); a signal alone does not establish OOM or an engine cause. |
| Dawn VFX mesh spends most of its time preparing point-shadow shaders | Check the shared-input admission and prepared `point-ssao` profile before the GPU phase. The standalone builder reuses that profile; source validation must opt out explicitly. See [Dawn preparation](../../scripts/ci/README.md#dawn-fixture-cold-shader-preparation). |
| Dawn cooked-material or VFX mesh test passes only after a retry | Reproduce with `--retry=0` and separate cold shader preparation from GPU execution; follow [the fixture guide](../../scripts/ci/README.md#dawn-fixture-cold-shader-preparation). |
| One Dawn lane reaches 25 minutes while the other finishes early | Compare exact run timestamps and the last completed group, then rebalance complete groups in `dawn-gate-roster.mjs` while conserving the full roster; follow the [two-lane evidence](../../scripts/ci/README.md). |
| Render Worker content browser group times out | Follow the CI guide's Local software graphics section; keep the five semantic process owners, the independent VFX mesh-lighting owner, and all 300-frame recovery cases. |
| A test fails after source edits | Reproduce the failing owner locally or on a qualified test machine; use the guide's focused diagnostic branch before updating the PR. |
| M7 baseline capture fails before the first GPU crash | Inspect `faultRequested`, browser arguments and snapshot progress in the [M7 failure record](../../scripts/ci/README.md); the software carrier must use the preflight backend. Retain all capture and recovery assertions. |
| Software-browser tests fail with `external Instance` after a GPU-process exit | Capture the actual browser arguments and reproduce the original owner alone; follow the [CI operating guide](../../scripts/ci/README.md) for the CI watchdog policy while preserving test deadlines and assertions. |
| Browser R32Float generation group reports `No test files found` | Keep the shared integration file explicitly included in `config/vitest-browser-project.ts`; retain its Browser and Dawn executions and fail-closed empty-group policy in the [CI operating guide](../../scripts/ci/README.md). |
| Browser suite runs a `.forgeax-harness` experiment or lacks its private commands | Verify the [Browser discovery boundary](../../scripts/ci/README.md#browser-discovery-boundary) in both the split runner and actual Vitest discovery; preserve the experiment and Engine test roster. |
| Process cleanup regression cannot find `descendant.pid` | Check fixture readiness before diagnosing cleanup; use the [startup and cleanup evidence contract](../../scripts/ci/README.md#process-cleanup-fixture-startup). |
| M3 reports two resolve targets or video-cutscene misses C | Count distinct resolve views, and wait for the App completed-frame projection before keyboard input; see [M3 topology](../../scripts/ci/README.md#m3-resolve-topology) and [video readiness](../../scripts/ci/README.md#video-texture-completion-and-recovery-samples). |
| Bevy skybox Smoke reports a skybox pass but a black HDR readback | Drain each synthetic frame before advancing; follow [skybox frame pacing](../../scripts/ci/README.md#bevy-skybox-smoke-frame-pacing), retaining the pixel gate and remove-skybox falsifier. |
| Bevy audio Smoke grows memory before reporting frames | Check that its direct Dawn driver drains submissions between frames; follow the [measured fixture evidence](../../scripts/ci/README.md#bevy-audio-smoke-frame-pacing). |
| Bevy depth-of-field Smoke stops before its pixel report | Reproduce with the runner's actual Node version and lifecycle wrapper; inspect the [per-frame queue drain and RSS evidence](../../scripts/ci/README.md#bevy-depth-of-field-smoke-frame-pacing) without inferring a remote OOM from a truncated log. |
| Learn Render Hello Triangle reaches Vitest's implicit 15-second timeout | Preserve its 15-second bootstrap observation and positive draw assertions; check the [separate cold-import and total startup budget](../../scripts/ci/README.md#hello-triangle-browser-startup-budget). |
| Covered DevKit scene bootstrap reaches a Worker deadline | Inspect the App error's `detail.phase`; the [generated development startup policy](../../packages/devkit/README.md#startup-diagnostics) includes cold Vite compilation. |
| CI source recovery fails on missing wgpu provenance after transfer timeout | Check that the job runs the shared `prepare-wgpu-wasm` Action before optional inputs; follow [unpublished wgpu recovery](../../scripts/ci/README.md#focused-ci-and-unpublished-wgpu-source). Best-effort hydration alone cannot prove readiness. |
| Artifact missing after cleanup | Distinguish optional build acceleration from required test evidence; follow the guide's recovery path for that class. |
| Shader materialization times out immediately after successful source recovery | Check whether the consumer reparses each hardlink to the shared catalog; follow [build input recovery](../../scripts/ci/README.md#build-inputs-and-recovery). |
| Empty-unit-marker API regression times out during workspace initialization | Use the isolated marker fixture with the real API runner; preserve ordinary-empty and mixed-selection failures and inspect captured child output. |
| Rust setup downloads an installer despite an existing toolchain, or bootstrap fails with TLS EOF | Linux x64 jobs use the shared `setup-rust-toolchain` Action: restore Cargo bin discovery before checking rustup, reuse the exact installed version, and hydrate only missing inputs with bounded retry. |
| AC-08 flags `continue-on-error` on an optional diagnostic upload | Verify it is the canonical `upload-optional-artifact` step. AC-08 admits only that step policy; test commands, required uploads and job-level overrides must remain fatal. |
| Pin reachability fails to refresh `origin/main` with a username/authentication error | The ancestry verdict is undetermined. Check source-checkout authorization; the pin gate passes matching HTTP credentials only to its fetch child and never accepts a stale remote ref. |
| Pin reachability reports that `third_party/wgpu` is not initialized | Run the maintained `prepare-wgpu-checkout.mjs` after authenticated checkout and before the all-submodule pin gate; do not weaken or skip the reachability check. |
| Checkout reports `Needed a single revision` or cannot find the assets submodule's current revision | All asset-consuming CI, SDK preflight and focused jobs run `node scripts/ci/prepare-assets-checkout.mjs` after source checkout and Node setup; it verifies the gitlink and restores only checkout-owned submodule metadata before normal update. |
| Submodule pin reachability reports `third_party/wgpu` is not initialized | Run `node scripts/ci/prepare-wgpu-checkout.mjs` after authenticated checkout and before the pin gate; asset preparation intentionally does not fetch wgpu. |
| Tests pass but an optional diagnostic upload fails during Action initialization | The workflow caller must own optional failure handling; the composite's inner step cannot cover download or outer timeout failures. See the CI guide's release-input recovery route. |
| Auto Render Worker starts but Kernel Workers stay disabled | Inspect `report.workers.kernels` and real COOP/COEP headers; use the [combined/fallback browser owners](../../scripts/ci/README.md#composable-worker-browser-coverage). |
| Runner offline or resource contention suspected | Use the installed `forgeax-github-runner` skill to verify host identity, capacity and live state. |
| pnpm reports only an exit code after a short Node gate fails | Check the Dawn preload wrapper's stderr ownership; asynchronous shell filters can lose child diagnostics. Run the real wrapper regression in `scripts/ci/__tests__/dawn-device-limits-action.test.mjs`. |
| `pnpm test:unit` reports every package group passing but exits 1 on `No test files found` | The named `unit` project is an intentional empty orchestration marker; inspect `scripts/ci/run-vitest-projects.mjs` and apply its marker-only `passWithNoTests` path. Keep `VITEST_FILES_NOT_FOUND` fatal for every real package project. Follow the [CI marker procedure](../../scripts/ci/README.md#intentional-empty-unit-marker). |

## Symptom index

| Symptom | Likely cause | Reference |
|:--|:--|:--|
| Textured demo shows a white square without texture or lighting gradient | Texture paramValues contain unresolved GUID strings instead of Handles. | [White textures](references/assets-and-ci.md#white-textures) |
| spawn-data-unknown-field or invisible/gray entities | Misspelled/stale data field, such as MeshRenderer.material instead of materials. | [Spawn fields](references/assets-and-ci.md#misspelled-spawn-data-fields) |
| register MaterialAsset reports shader not registered | Stale shader identifier in pack.json. | [Shader identifiers](references/assets-and-ci.md#stale-shader-identifiers) |
| CI fails despite all assertions passing | Unhandled rejection during teardown sets exit 1. | [Exit status](references/assets-and-ci.md#passing-assertions-with-exit-1) |
| Fresh worktree alone fails with ENOENT/unresolved package | Submodule initialization or build missing. | [Worktree setup](references/assets-and-ci.md#fresh-worktree-environment-failures) |
| Texture disappears after warm HMR | vite-plugin-pack DDC loses sourcePath or writes to source tree. | [Pack HMR](references/assets-and-ci.md#vite-plugin-pack-ddc-hot-reload) |
| Windows-only failures or CRLF diffs | Missing LF attributes or path-separator handling. | [Windows](references/assets-and-ci.md#windows-compatibility) |
| Upside-down cubemap | Redundant V-flip in skybox.wgsl. | [Skybox V-flip](references/lighting-and-materials.md#skybox-v-flip) |
| All CSM shadows fully lit despite valid matrices and running cascades | Negative viewZ compared to positive splitPlanes selects the near cascade; distant projections leave the tile and return 1.0. | [CSM depth sign](references/lighting-and-materials.md#csm-shadows-fully-lit) |
| Meshes do not cast shadows although castShadow is enabled | Hand-authored materials omit ShadowCaster and never enter the shadow depth pass. | [ShadowCaster](references/lighting-and-materials.md#missing-directional-shadows-castshadow-and-shadowcaster) |
| Standard material black during cold startup or without IBL | Asynchronous Skylight cubemap is the only ambient source. | [Ambient readiness](references/lighting-and-materials.md#ambient-black-until-ibl-loads) |
| Multi-mesh glTF nodes bind every mesh's materials | Bridge fails to filter by meshIndex. | [glTF materials](references/lighting-and-materials.md#gltf-bridge-mixes-mesh-materials) |
| pbr-skin pipeline fails with missing binding/vertex slot 5 | Skin shader reuses standard PBR layout; JOINTS_0/WEIGHTS_0 are not uploaded. | [Skin pipeline](references/skinning-and-fbx.md#pbr-skin-pipeline-build-fail) |
| Browser skin black but Dawn passes; VBO 768 instead of 1152 bytes | Break in parser, bridge, mesh-loader, render-data, pipeline context, or extraction. | [Attribute chain](references/skinning-and-fbx.md#skin-vertex-attribute-chain) |
| hello-skin dev Fox black with asset-not-imported while smoke passes | Missing build/submodule or sibling using the port. | [Fox dev loading](references/skinning-and-fbx.md#fox-development-loading-asset-not-imported) |
| Skin remains in bind pose while clip/world matrices advance | Palette allocator/dynamic-offset/extract wiring, MAX_JOINTS overflow, or async instantiation before SkinAsset registration. Skin.joints.length=0 and JointCountMismatchError identify the latter; e5e68b35 added SceneAsset.skinGuids and fail-fast skin-asset-unresolved. | [Static skin](references/skinning-and-fbx.md#skin-entity-stays-static) |
| Distorted/flipped FBX skin animation in historical SDK implementation | Removed binding.cc misread Euler degrees as quaternions and sampled one axis; ufbx bridge.c uses ufbx_evaluate_transform. | [Historical FBX deformation](references/skinning-and-fbx.md#historical-fbx-skin-deformation) |
| FBX parity snapshot fails | bridge.c drift in axis conversion, material classification, node filtering, or animation extraction. | [FBX parity](references/skinning-and-fbx.md#fbx-parity-snapshot-differences) |
| FBX WASM ENOENT | Contributor checkout lacks generated pkg payloads. | [FBX WASM](references/skinning-and-fbx.md#missing-fbx-wasm-payload) |
| FBX WASM initializes in browser but fails in Node | ENVIRONMENT flags or Node version mismatch. | [Node WASM](references/skinning-and-fbx.md#fbx-node-wasm-initialization-failure) |
| SkinPaletteOverflowError needs=16384 cap=16320 at first frame | MAX_JOINTS=256 exceeds the pbr-skin group-2 binding-1 capacity established by PR #361. | [Palette overflow](references/skinning-and-fbx.md#skinpaletteoverflowerror-needs-16384-b-exceeds-16320-b) |
| Edge adapter-unavailable and black output | Browser settings disable hardware GL. | [Edge configuration](references/backends-and-ci.md#edge-webgpu-disabled) |
| Startup/release reports only WebGPU, adapter-unavailable, or object Object | Flattened diagnostics or only one backend channel observed; insufficient to declare the machine unsupported. | [Capability diagnosis](references/backends-and-ci.md#webgpu-messages-do-not-decide-whole-machine-support) |
| WebGL2 fallback validation panic: storage/uniform mismatch or VIEW_FORMATS | Missing capability gates in variant keys, graph viewFormats, or texture reinterpretation. | [Fallback gates](references/backends-and-ci.md#wgpu-wasm-webgl2-fallback-cap-gates) |
| WebKit reports mesh SSBO ceiling 0 B and black scene | Downlevel defaults report maxStorageBufferBindingSize=0, incorrectly consumed as a real ceiling. | [SSBO ceiling](references/webkit-and-lifetimes.md#webkit-mesh-ssbo-ceiling-0) |
| WebKit black/GPU loss after submit without onError | wgpu error-sink failures never reach JS. | [Submit errors](references/webkit-and-lifetimes.md#webkit-black-output-after-submit) |
| WebKit probe panics Surface does not exist while hello-triangle works | Probe main returns after a finite loop without retaining Renderer; GC finalizes the WASM Surface. | [Probe lifetime](references/webkit-and-lifetimes.md#webkit-probe-renderer-gc-finalize) |
| CI job, cache or skip behavior differs from old troubleshooting notes | Workflow layout has changed; verify the failing commit before applying historical advice | [CI operating guide](../../scripts/ci/README.md) |
| Math bench fails during asset submodule checkout before installation | Check the source-only checkout boundary, then run the unchanged Math benchmark command. | [Math benchmark checkout](../../scripts/ci/README.md#math-benchmark-checkout) |
| Typecheck preflight regression cannot find `typescript/bin/tsc` on a clean runner | Check that the real-compiler regression follows frozen dependency installation. | [Cold declarations](../../scripts/ci/README.md#cold-declarations-with-hoisted-workspace-links) |
| Bun cold declarations report `TS7016` after the referenced project emitted its types | Inspect hoisted-symlink negative lookups; run the explicit emit then forced-check preflight and preserve first-error failure. | [Cold declarations](../../scripts/ci/README.md#cold-declarations-with-hoisted-workspace-links) |
| Smoke input recovery reaches 20 minutes while building Bevy or performance apps | Verify contract `sourceAppRoots` covers the full Smoke roster, then reproduce source recovery; do not expand the timeout. | [Build inputs and recovery](../../scripts/ci/README.md#build-inputs-and-recovery) |
| Bun CI input recovery starts parallel pnpm installs and terminates with `SIGKILL` | pnpm 11 auto-install replaced the Bun-owned dependency tree; preserve the job-scoped dependency policy and rerun the input regression. | [Bun dependency ownership](../../scripts/ci/README.md#bun-dependency-ownership) |
| Extended-lighting Spot or Probe browser comparison reaches the implicit 15-second timeout | Check the owner-specific completion bound and reproduce with the real software GPU; keep the pixel and oracle assertions intact. | [Extended lighting completion bounds](../../scripts/ci/README.md#extended-lighting-browser-completion-bounds) |
| **Fog is stable but its beam becomes banded or changes shape** | Run the compact Dawn punctual-scattering oracle and compare the approved demo pose; homogeneous Beer transmittance and frame deltas do not protect spatial appearance. | [Volume stability gate](../../scripts/ci/README.md#volumetric-fog-stability-regression) |
| **Volumetric fog flickers again after a prior fix** | Verify the served worktree and prior-fix ancestry, then run the advancing-World pixel gate; frozen-time or single-image noise checks miss this failure. | [Volume stability gate](../../scripts/ci/README.md#volumetric-fog-stability-regression) |
| **Preview browser test times out or reports Boss VFX GUID 404s** | Check shared Preview declarations, external resources, and root-discovered VFX modules. Reproduce the isolated group with preview-only scope and before-consume readiness before changing timeouts. | [Preview browser asset closure](../../scripts/ci/README.md#preview-browser-asset-closure) |
| **Runtime Surface provenance times out before rendering** | Use its singleton Browser group and existing Surface-only asset closure with before-consume readiness; retain all four publication and pixel checks. | [Browser asset closure](../../scripts/ci/README.md#preview-browser-asset-closure) |
| **Browser discovers a failing test under `.forgeax-harness/solo/`** | Keep the floating harness experiment outside both split discovery and Vitest collection; run it with its own fixture commands. | [Browser roster boundary](../../scripts/ci/README.md#browser-roster-excludes-floating-harness-experiments) |
| **A mixed runtime Browser group stalls without an assertion failure** | Inspect per-file timings: the fifteen-case shadow-contact owner requires its own process. Preserve every camera sweep and pixel check. | [Browser asset closure](../../scripts/ci/README.md#preview-browser-asset-closure) |
| **Wave1 recovery reaches the compile-graph deadline only in a mixed browser group** | Run the complete owner in its singleton process and retain both host-loss cycles and the existing recovery deadline. | [Recovery process isolation](../../scripts/ci/README.md#browser-recovery-process-isolation) |
| **Browser shard reaches 300 s after solar-atmosphere calibration reports six passing tests** | The six-test WebGPU owner was packed with other runtime files; keep its singleton process boundary and measured shard weight, then rerun the owner selector. | [Solar calibration owner](../../scripts/ci/README.md#browser-solar-atmosphere-calibration) |
| **Multithread benchmark reaches the two-minute shader materialization timeout before its browser starts** | The single `apps/hello/multithreaded-execution` consumer used the broad `apps/` manifest walk; pass its exact `--app-root` to the materializer and preserve the benchmark contract. | [Multithread benchmark input materialization](../../scripts/ci/README.md#browser-multithread-benchmark-input-materialization) |
| GPU buffer/texture/cubemap counts grow throughout long sessions | Missing symmetric release in store eviction, instance buffers, transient resize, or handle-keyed WeakMaps. | [Resource growth](references/webkit-and-lifetimes.md#monotonic-gpu-resource-growth) |


> [!TIP]
> Open only the linked recipe file; package READMEs remain the design SSOT.
