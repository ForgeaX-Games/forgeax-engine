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

Dawn job-deadline cancellation: also check post-job cleanup after a passing native body and the [measured lane recovery](../../scripts/ci/README.md#dawn-lane-deadline-recovery-october-5); read native annotations and compare shader-profile preparation, ordinary partitions and complete fixed-group tails, including [lane1 cancellation after transfer](../../scripts/ci/README.md#lane1-cancellation-after-the-first-transfer). Also preserve the [main renderer profile ownership](../../scripts/ci/README.md#renderer-profile-ownership-after-the-first-lane-deadline). A passing ordinary partition does not admit unfinished renderer/GI/light owners. Move the complete base-profile producer with its renderer owner to a lane with measured headroom. Require complete final-head CI after placement changes; cancellation is never PASS.

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

For unselected shader plugin discovery exceeding its original five-second gate,
follow [revision discovery](../../scripts/ci/README.md#unselected-shader-plugin-revision-discovery).
Keep all 100 instances, subprocess-count and virtual-load revision controls.
Regenerate strict publications after built-byte changes; configured GitHub CI
already avoids Git, so this is not a whole-CI or GPU timing claim.

For accepted 380 evidence and missing GPU samples after a process-title rewrite,
follow [complete acceptance and process titles](../../scripts/ci/README.md#complete-380-acceptance-and-rewritten-gpu-process-titles).
Keep the exact-token and real Linux Worker-child regressions; this observation
correction does not establish isolation, a GPU stall fix or thirty-minute CI.

For the integrated e9b Dawn3 cancellation, use the
[current complete-owner recovery](../../scripts/ci/README.md#complete-owner-recovery-after-e9b-lane-three-cancellation).
Keep the original benchmark/SDK/View/Catalog negatives and complete all owners;
missing GPU samples do not establish isolation. The same route documents owned
Linux thread discovery and Lens Effects failure capture retention.

When single-worker source preparation repeatedly composes identical inputs,
follow [single-worker source composition](../../scripts/ci/README.md#navigation-followup-single-worker-source-composition).
Run the real Naga count and output regressions before changing the batch owner;
preserve sequential admission, bounded reuse and option-specific validation.
Reduced composition counts do not qualify the original source-case deadline
or complete CI without their own new-head acceptance.

For the literal314 lane-four cancellation inside direct-light, follow
[matched complete-owner transfer](../../scripts/ci/README.md#navigation-followup-matched-dawn-owner-transfer).
Use complete eed/314 process costs, not the censored direct-light prefix.
Preserve all four lanes, owners, native bounds and the original cancelled run;
allocation estimates require complete new-head CI before acceptance.

If sticky reporting says `successful metrics producer has no report body`,
check the producer's immutable artifact ID and actual download step. Unrelated
gate failure must not suppress available metrics. Follow the CI guide's report
contract and `metrics-report-workflow.test.mjs`; preserve downloader identity
checks, failed gate context and successful-producer missing-body rejection.

If a package build fingerprint fails on a Dawn .native-build tool link or
walks Cargo scratch output, follow [build inputs and recovery](../../scripts/ci/README.md#build-inputs-and-recovery).
Check the exact producer-owned exclusion and run the real filesystem regression;
keep authored paths and native source/provenance/output admission intact.

For current lane-one cancellation inside GI-1, follow the
[complete current-head transfer](../../scripts/ci/README.md#complete-dawn-transfer-after-current-lane-one-cancellation).
Preserve the original complete owners and use the maximum measured cost model;
historical costs for censored GI work are estimates until full CI passes.

In an Engine contributor checkout, open
[`scripts/ci/README.md`](../../scripts/ci/README.md) before changing CI scheduling,
caching or recovery. It owns the full-run time budget, measurement and acceptance
rules, and exact `ci:focus` commands. Installed game skills should route repository
CI work to an Engine contributor checkout; game tests use the project's own CLI.

The CI guide also owns the explicit View Worker comparison selector and its
success/failure artifact retention. Compare the retained execution reports and
capture attempts; a successful diagnostic process is not the 60-frame acceptance
gate and does not establish rendering performance.

| Symptom | First action |
|:--|:--|
| View assertions pass but `FinalizeArtifact ECONNRESET` fails the job | Follow [View evidence transport recovery](../../scripts/ci/README.md#view-evidence-transport-recovery): retry the canonical upload once, retain hidden preview captures and required evidence; exhausted transport remains failure. |
| An uploaded failing View/RHI artifact immediately returns 404 | Inspect [failure capture retention through recovery](../../scripts/ci/README.md#failure-capture-retention-through-recovery), cleanup dependency closure and the failure artifact prefix; preserve the original deadline and structured failure while capture is unavailable. |
| View or Dawn repeatedly recompiles base-SSAO while shared point-SSAO is present | Follow [shared base profile and preserved failure evidence](../../scripts/ci/README.md#shared-base-profile-and-preserved-failure-evidence); verify the distinct profile receipt and core transfer before source recovery. Never alias point to base or weaken fingerprint admission. |
| Native ready/completed frames stall, or concurrent jobs have equal CPU masks | Preserve the original oracle and [correlate failures](../../scripts/ci/README.md#shared-base-profile-and-preserved-failure-evidence) using frame completion stages, nested loss cause, opaque kernel identity, actual selected CPU sibling lists and owned GPU thread masks. Parent taskset masks alone do not prove driver-thread isolation; equal masks alone do not prove shared-host contention, and disjoint masks do not prove separate physical cores. |
| Browser RHI evidence upload throws `Illegal invocation` before its first request | Follow [default capture ID recovery](../../scripts/ci/README.md#default-capture-id-recovery): retain the Crypto receiver, exercise default-ID upload through real HTTP routes and qualify actual Chromium; a successful upload does not resolve the original frame deadline. |
| GPU CI spends time on unasserted output or repeated source compilation | Follow the [workload audit](../../scripts/ci/README.md#conservative-workload-trimming): trace each consumer before removing replay/readback work, keep real pixel/falsifier and source-compilation owners, and report job minutes separately from wall time. |
| Dawn four reaches its original job deadline inside Direct Light on e393 | Follow the [complete-owner transfer](../../scripts/ci/README.md#complete-owner-transfer-after-e393-lane-four-cancellation). Preserve the cancelled second partition and all35 owners; Surface moves whole to1 and Direct Light whole to3. Require new final-head complete CI; projections exclude setup, transfer and queueing. |
| Standard cold cooking exceeds its bound or recovery cannot select a uniform program | Follow [Standard cold cooking and profile identity](../../scripts/ci/README.md#standard-cold-cooking-and-profile-identity): rebuild owners, pin Node, keep all four cases and original bounds, inspect actual WGSL/selection contracts and Native publication, then require full installed SDK acceptance. A point/base input mismatch must rebuild, not bypass admission. |
| App build exhausts the heap while hashing transported shader or mesh arrays | Follow [Pack revision hashing and build memory](../../scripts/ci/README.md#pack-revision-hashing-and-build-memory): reproduce the real build at its original heap limit, trace allocations to the finalizer, preserve exact digests and mutation controls, then qualify complete CI and SDK. |
| Named DevKit shader-check expires before the requested WGSL is reached | Follow [consumer preparation](../../scripts/ci/README.md#devkit-consumer-preparation-and-canonical-roots): verify shared/package inputs before ordinary source fallback; preserve the complete project and original deadline. |
| Host page assertions finish but Chromium does not exit | Separate Context, native process and Vite/HTTP cleanup through [the existing diagnostic route](../../scripts/ci/README.md#devkit-consumer-preparation-and-canonical-roots); a teardown watchdog/native exit 2 is not PASS. |
| A prepared standalone probe holds a local GPU lease without terminal output | Require its original complete `--timeout-ms` budget at the [maintained lease entrypoint](../../scripts/ci/README.md#concurrent-local-sessions-and-the-gpu-lease); preserve stage logs, timeout failure and owned-descendant cleanup before another owner enters. |
| DevKit fixture fails with `/var` versus `/private/var`, denied Worker imports or invalid emitted HTML paths | Canonicalize the actual temporary project/snapshot root before Vite assembly, following production `readProjectFacts`; rerun the real HTTP/module/archive path with its sibling-access falsifier. Do not weaken allow-lists or replace public imports. |
| Local focus expires after a long GPU queue | Follow [the coordinator queue budget](../../scripts/ci/README.md#local-focus-coordinator-lease-queue-budget); preserve the first failure and separate excluded queue intervals from CPU/native execution. Keep every original owner deadline and cleanup. |
| Complete Dawn lane 4 cancels inside direct-light on e630 | Follow the [complete preparation and receiving-lane evidence](../../scripts/ci/README.md#path-e630-complete-preparation-and-receiving-lanes): preserve the historical transfer evidence, then use the [integrated allocation](../../scripts/ci/README.md#navigation-and-path-main-integration-allocation). Retain all 35 owners and original bounds; preserve incomplete partitions and separate Preview/SDK failures. Require complete final-head CI; timing estimates are not acceptance. |
| Lighting-channel capture/replay exceeds a mixed Browser lifetime | Follow [surface lighting-channel evidence](../../scripts/ci/README.md#surface-lighting-channel-evidence): preserve all eight World/publication, rigid/skin and Forward/Deferred cases in fresh Browser processes and ordinary Dawn file partitions, original deadlines, HDR oracles and fresh-device bypass falsifiers. Verify exact-once routing; local process timings and estimated placement weights do not qualify complete CI. Finish source-profile producers before consumers. |
| Local agent sessions wait hours for the GPU or hold it during a full build | Use the [per-owner local GPU lease](../../scripts/ci/README.md#concurrent-local-sessions-and-the-gpu-lease); prepare outside the lease, retain each complete native owner and inspect queue/execution timings. Under shared CPU pressure, set package/shader/Cargo concurrency to one; the Dawn entry preserves that explicit override. Preserve existing holders and qualify same-device parallelism before enabling it. |
| Input, WebSocket, Web Audio or DOM UI browser tests wait for rendering inputs or the GPU | Follow the [qualified Host contract route](../../scripts/ci/README.md#browser-host-contracts-without-gpu-admission). The split runner uses the exact roster, real Chromium and graphics rejection; unknown or rendering-dependent files retain native GPU admission. |
| Native dynamic imports fail after Host config re-optimization | Follow [Browser dependency cache isolation](../../scripts/ci/README.md#browser-dependency-cache-isolation). Inspect both resolved Vitest cache paths and the original published dependency request; retain the shared-cache red control and fresh-source repair negative control. Do not infer GPU or Chrome-close causality from an import failure. |
| Local Browser roster discovery slows after a native build | Follow the [Browser traversal boundary](../../scripts/ci/README.md#browser-dependency-cache-isolation); skip only the owned generated Rust/Dawn directories, keep source directories named target and compare the actual Vitest roster. |
| TransformGizmo fleet correctness uses the full performance viewport or unconsumed timings | Follow [Transform gizmo Browser admission](../../scripts/ci/README.md#transform-gizmo-browser-admission). Enable the existing lightweight policy only for its CI browser owner and request timings only when sampling; keep all pointer, lifecycle, frame and deadline gates. |
| Browser owners spend time before the Vitest RUN banner | Follow [Browser startup and authored material reuse](../../scripts/ci/README.md#browser-startup-and-authored-material-reuse); separate native startup, Vitest duration and cleanup. File-only discovery skips plugins. Profile actual initialization and retain full material variants, validation, native owners and final-head CI. |
| Concurrent material preparation repeats the same Naga composition key | Follow [concurrent material composition](../../scripts/ci/README.md#concurrent-material-composition): reproduce with the real scoped compiler, share bounded pending work, retain failure retry and independent results, and keep Catalog/native/final-head gates separate from call-count evidence. |
| Node shared-manifest loading allocates large temporary UTF-8 buffers | Follow [Node publication verification](../../scripts/ci/README.md#node-shared-shader-publication-verification); reuse the existing Node source-string verifier, preserve every digest and producer receipt, and compare complete publication contents. Loader measurements do not certify Catalog or GPU readiness. |
| Forced-source point-shadow manifest reaches its original V8 deadline | Follow [the measured closure-hash owner](../../scripts/ci/README.md#forced-source-closure-hash-recovery). Profile the actual Vitest fork and compiler Workers, preserve complete source variants and original bounds, and verify published digest bytes before changing the build-time owner. A separate Surface pass is not proof that its earlier timeout was repaired. |
| View runtime-content repetition or a complete Dawn terminal owner dominates CI | Follow [the October 5 workload and tail evidence](../../scripts/ci/README.md#october-5-view-workload-and-complete-dawn-tail): use the View-owned CI workload (including the combined plugin panel viewport), retain JS/TS live/cold admission, sixty completed frames and native retirement, and move whole measured GI-2, direct-light, Bloom or Runtime Pack tails without dropping their checks or evidence. Preserve complete source scans while eliminating redundant metadata and regex work. Require complete final-head checks including SDK. |
| Full SDK verification removes its unpack directory while a source build survives | Follow [SDK source preparation ownership](../../scripts/ci/README.md#sdk-source-preparation-ownership); confirm the private process identity, retain the original failure, run the process regression, and repeat the full archive gate. |
| SDK consumers fail artifact discovery with HTTP 403 before running tests | Verify the workflow declares `actions: read` for the existing REST downloader. Preserve exact seed identity, complete payload hashes and hard failure for missing transport; require a new complete final-head run. |
| SDK seed repeats release shader compilation | Follow [verified profile reuse](../../scripts/ci/README.md#measured-balance-and-verified-profile-reuse): restore optional generated inputs, validate current source/compiler/profile and actual payload bytes through the existing receipt, and rebuild every miss from source. Keep all consumer gates, distinguish cold and warm runs, and use `FORGEAX_BUILD_NO_TASK_CACHE=1` for forced-source diagnostics. |
| SDK View remains the slowest of four consumers | Follow [the measured SDK balance](../../scripts/ci/README.md#october-5-sdk-critical-path-balance): place the complete installed JS/TS live/cold and Game 3D owner on the shorter Project lane, retain paired diagnostics and immutable-store checks, conserve every default journey and require new exact-head CI. Exclude Runner waiting from this optimization target and report wall time separately. |
| All PR checks exceed forty minutes because SDK consumers run serially | Follow [the complete PR budget](../../scripts/ci/README.md#october-4-complete-pr-budget-and-four-sdk-consumers): one exact byte-verified seed, four independent consumer groups, required conservation/identity aggregate, complete default Release verification. Include transport, queueing and all terminal checks in the measured result. |
| CI grows past 40 minutes or a matrix grows beyond four shards | Follow [the bounded workload route](../../scripts/ci/README.md#october-3-workload-reduction-four-shard-ceiling): separate runner waiting from active work, include terminal-group duration and complete fixed-step tails when refreshing placement costs, keep artifact-independent source checks in the required primary job, reserve each serial tail on its owner, keep exclusive work contiguous, move shader profile preparation with its native owner, reduce repeated static sampling and recovery fill cost while retaining final poses, full physical qualification and actual frame receipts, preserve semantic assertions and measure complete final-commit CI. |
| Dawn reaches its deadline after the compact group passes | Follow the [four-lane workload evidence](../../scripts/ci/README.md#october-3-workload-reduction-four-shard-ceiling): derive disjoint compact partitions from the existing roster, preserve native isolation, prove complete unique ownership and measure the next complete final-head run. |
| One browser or Smoke shard finishes minutes after its siblings | Compare per-file and fixed-step seconds against the [PR 3561 critical path](../../scripts/ci/README.md#critical-path-on-pr-3561); refresh `browser-file-seconds.json` or the smoke tail reservations instead of hand-tuned weights, keeping the full roster and 60-frame windows. First compare that shard's group seconds with their modeled weights: a uniform 1.5-2x slowdown points at the host, not the plan. |
| A shorter capture-recovery fixture sees zero active ReflectionProbes | Inspect the reflection owner's raw face and filtered-step counts: PMREM work continues after raw capture under the one-work-per-frame budget. Follow the [workload evidence](../../scripts/ci/README.md#preview-catalog-startup), settling on actual probe activation within the original 120-frame cap. Preserve all three probes, both capture intents and every recovery/readback/resource assertion. |
| Actual Browser file discovery times out before any GPU group starts | Follow the [Browser discovery boundary](../../scripts/ci/README.md#browser-discovery-boundary): `list --filesOnly` must enumerate the actual project without initializing renderer/asset publications; ordinary execution keeps its producers. Preserve the roster, 60-second bound and missing-input execution falsifier. |
| Headed Browser PNG dimensions shrink despite an explicit viewport and canvas size | Check that the shared browser project disables the Vitest preview UI; follow [focused startup regressions](../../scripts/ci/README.md#focused-startup-and-shader-dependency-regressions), preserving the real backend and authored pixel dimensions. |
| Render water-consumer or Runtime Surface semantic TypeScript case hits its 30-second bound under split coverage | Follow [serial semantic fixture checks](../../scripts/ci/README.md#serial-semantic-typescript-fixture-checks). Preserve the complete file, public import closure and deadline; use the existing preflight roster for both execution and exclusions, then require full final-head CI. |
| PR CI comment is truncated, miscounts auxiliary JSON, or contains only an empty partial warning | Follow [PR report evidence](../../scripts/ci/README.md#pr-metric-report-evidence); inspect the existing workflow `needs` projection and producer report files, then run the CLI-renderer regression before requiring complete final-head CI. |
| Mesh interchange capture fails during a page reload | Read the preserved nested browser/Host failure, then run the [fresh-cache acceptance gate](../../scripts/ci/README.md#mesh-interchange-browser-acceptance); retain single-navigation admission, real GPU frames and partial tapes. |
| CI input staging or Xvfb fails with system `/tmp` quota while `RUNNER_TEMP` is writable | Verify the common bootstrap runs before staging and exports the job temporary root; check the failing owner for hardcoded system-temp paths that bypass Node `tmpdir()`; follow [temporary-root recovery](../../scripts/ci/README.md#job-temporary-root-and-system-volume-quota). Preserve pre-test failures and require complete final-head CI. |
| Native Ray Query GI fails while Dawn/SDF passes | Check foundation/mutation/gather, including cancellations. Download `native-node-gi-failing-frames-*` and its group JSON within one day; follow [native source checkout](../../scripts/ci/README.md#native-source-checkout) and RHI Debug. Separate same-cache sampling from independently converged clipmap/fixed/coarse images; compare hidden-emitter cold controls (feedback on/off, half/full) and one/three-bounce exact transport before changing visibility or feedback. For Screen Probe darkening or stale pixels, inspect support through resolve/filter/convolution/integrate/history with `screen-probe-support`; distinguish missing transport from physically resolved zero. For replay divergence, compare placement and generated rays by receiver pixel, then run `screen-probe-order` on permuted adaptive records. Retain scroll/replay, leak/envelope and post-edit ghost bounds. |
| Native MSAA partial-coverage or Reverse-Z black-output falsifier fails | Inspect real input samples and linear HDR color before changing rendering; follow [depth fixture measurements](../../scripts/ci/README.md#depth-fixture-coverage-and-output-measurement), retain failed tapes and all original coverage/depth assertions. |
| CI roster discovery intermittently reports a missing package export during script tests | Inspect concurrent real package producers; follow [artifact writer isolation](../../scripts/ci/README.md#package-artifact-writer-isolation), retain the complete producer and discovery regressions, and require final-head CI. |
| Environment presentation passes eleven modes but its mixed Browser group reaches 300 seconds | Follow the [environment process boundary](../../scripts/ci/README.md#environment-presentation-browser-process-boundary); keep all modes and regrouped neighbors, original deadlines, frames and pixels, then require full CI. |
| Dawn lanes expire after completed groups while other lanes finish | Follow the [complete-group balance evidence](../../scripts/ci/README.md#dawn-complete-group-balance-after-the-27-minute-bound); distinguish job timeout from a test failure, preserve censored tails and every group, and verify all four lanes at the unchanged deadlines. Transfer estimates are not passes. |
| G28 integration conflicts with a newer complete Dawn allocation | Follow the [verified main allocation](../../scripts/ci/README.md#g28-integration-adopts-the-verified-main-dawn-allocation): prefer its whole four-lane result over independent historical transfer estimates, conserve every owner and deadline, and require fresh complete integrated-head CI. |
| Real Node reconnect receives an epoch-zero baseline before session-resume | Follow the [logical announcement barrier](../../scripts/ci/README.md#logical-announcement-before-authority-publication). Reproduce delayed announcement at NetSession; retain real WebSocket and all epoch/order falsifiers. Pure Node tests use their Node config, without render shader preparation. |
| Dawn lane 4 expires in GI-2 after surface-pipelines and all VFX-depth partitions | Follow the [fourth-lane tail evidence](../../scripts/ci/README.md#fourth-lane-tail-after-transmission-transfer); retain censored tails and every original owner, transfer only complete groups into measured headroom, and keep Native GI whole-command failures separate. |
| Dawn lane 2 repeatedly completes transmission, then expires before its remaining owners | Follow the [repeated transmission lane evidence](../../scripts/ci/README.md#repeated-transmission-lane-budget); move only the complete owner into measured headroom, conserve all groups and process semantics, and require fresh whole-lane results. |
| Renderer bootstrap or composite readback times out in a mixed browser group | Follow the [short bootstrap owner route](../../scripts/ci/README.md#short-renderer-bootstrap-owners): verify submission completion and Renderer disposal, focus the exact owner, and retain the case and process deadlines with fresh native state. |
| Physical Atmosphere reports 16 sampled textures in a Chromium software test | Check the real adapter and the [browser adapter limit policy](../../scripts/ci/README.md#browser-adapter-limits); preserve SwiftShader, WebGPU validation, and the insufficient-capability rejection test. |
| Point-shadow Smoke spends minutes before its short render window | Follow the [measured preparation route](../../scripts/ci/README.md#october-3-workload-reduction-four-shard-ceiling): prepare the existing point profile from verified shared bytes immediately before its sole owner, retain source recovery and all 60 frames, and verify the actual workflow projection plus complete final-head CI. |
| WASM preparation waits ten minutes with zero cache bytes | Follow the [cache-stall evidence](../../scripts/ci/README.md#october-3-workload-reduction-four-shard-ceiling): bound only the optional package-cache segment wait, preserve verified release/source recovery and provenance checks, and include the idle wait in complete final-head timing. |
| Shared shader producer oversubscribes a CPU container or rebuilds common dependencies | Follow the [CI workload profile](../../scripts/ci/README.md#october-3-workload-reduction-four-shard-ceiling): build the union of the complete plugin closures once and use the existing cgroup CPU budget for the shader worker pool; retain source identity, complete programs and recovery. |
| Browser shard tails change after bounded sampling | Refresh the measured complete tail, including uploads, in the [CI workload profile](../../scripts/ci/README.md#october-3-workload-reduction-four-shard-ceiling); conserve every owner, distinguish runner slowdown from workload growth, and require another complete final-head run. |
| Browser scheduler test fails after adding a test owner | Check deterministic assignment, complete ownership and load balance through the [scheduler regression](../../scripts/ci/README.md#focused-startup-and-shader-dependency-regressions); arbitrary test pairs need not stay on different shards. |
| A mixed runtime browser group reaches its process deadline after other files pass | Inspect per-file completion times and focus the complete owners through [runtime group completion](../../scripts/ci/README.md#runtime-browser-group-completion); preserve the exact roster, case deadlines and process bound, then require full final-head CI. |
| Solar calibration singleton exceeds its300-second group deadline beside other native groups | Focus the complete six-case owner with its original300-second bound and preserve both attempts; follow [Solar runner admission](../../scripts/ci/README.md#solar-calibration-runner-admission) before changing rendering or frame counts. |
| Browser shard records a SIGKILL near the cgroup memory limit | Correlate cgroup events, top RSS processes, and concurrent group logs; schedule the identified full owner group exclusively while retaining its files and deadlines. Follow [browser shard memory pressure](../../scripts/ci/README.md#browser-shard-memory-pressure), then verify the affected shard and full CI. |
| Snake process E2E fails during bind, or extracted grazing shader lacks a helper | Use the [focused startup and shader regressions](../../scripts/ci/README.md#focused-startup-and-shader-dependency-regressions); check valid third-attempt recovery against the existing bind budget, retain real socket/GPU assertions and inspect the structured failure before rerunning. |
| AC-08 rejects a GPU fixture's raw-device call | Check each call against the [native validation fixture boundary](../../scripts/ci/README.md#native-rhi-validation-fixture), register only exact test paths for validation/disposal (including caller-owned replay device cleanup), and rerun the artifact-storage policy regression. |
| ECS repository scans expire in a mixed coverage child | Follow [repository scan coverage ownership](../../scripts/ci/README.md#repository-scan-coverage-ownership): check nested generated/dependency exclusions, the exclusive complete-file owner and original deadlines; retain Git HEAD and full authored-root checks. |
| Preview template smoke stalls on Catalog or Game 3D readiness | Follow [Catalog startup diagnosis](../../scripts/ci/README.md#preview-catalog-startup) and the [measured remaining failures](../../scripts/ci/README.md#remaining-failures-on-the-four-shard-tree): separate inventory, source leases, repeated material composition and shadow pressure. Use `FORGEAX_WORKSPACE_TIMING=1`; preserve original deadlines, producer failures, freshness fence and the complete template roster. |
| Native graphics preflight renders correctly but aborts at exit | Follow the [shared teardown correction](../../scripts/ci/README.md#remaining-failures-on-the-four-shard-tree); retain device destruction, completion drainage and instance ownership before accepting process exit. |
| Aggregate reports a missing shard after successful artifact downloads | Check that the product-head downloader supports the workflow's `--merge-multiple` flag; follow [build inputs and recovery](../../scripts/ci/README.md#build-inputs-and-recovery) and retain SHA, digest, and complete-roster admission. |
| Full Smoke producers pass after retry but aggregation reads the earlier failed row | Follow [build inputs and recovery](../../scripts/ci/README.md#build-inputs-and-recovery): select the newest immutable artifact per shard through the shared downloader; preserve old failures and require the full exact-commit aggregate. |
| Focus or GPU timing contract source recovery fails with missing or stale wgpu provenance | Follow [unpublished wgpu source recovery](../../scripts/ci/README.md#focused-ci-and-unpublished-wgpu-source): use the shared verified cache/release/source Action, then rerun current-head tests. Best-effort install is not input admission. |
| A transform handle is missing, misses the pointer, or moves the wrong axis | Follow [transform manipulator gates](../../scripts/ci/README.md#transform-manipulator-gates): inspect actual canvas extent and parent basis, reproduce through the real pointer gate, then inspect the captured GPU mesh/material offsets and fresh-device pixels before changing presentation. |
| An explicit 300-frame Smoke request reports only 60 or omits independent owners | Follow [explicit Smoke budgets](../../scripts/ci/README.md#explicit-smoke-frame-budgets): use `ci:focus --kind smoke --select all --frames 300`, require complete same-HEAD aggregation, and retain separate assertion/composite semantics. Default CI stays 60; never add short lifecycles together. |
| RHI Smoke timeout regression has empty stdout before its synthetic receipt | Reproduce the delayed producer fixture and retain valid-receipt parsing plus signal/null-credit assertions; do not increase real Smoke budgets. | [Transmission Smoke owners](../../scripts/ci/README.md#transmission-bounded-smoke-owners) |
| Wave1 Smoke rejects a newly declared assertion owner or counts it as a frame owner | Follow the [explicit Smoke budget contract](../../scripts/ci/README.md#explicit-smoke-frame-budgets); preserve the complete roster, derive frame coverage from validated receipts, and run both the budget and Wave1 consumer regressions. |
| Render Worker browser group exceeds its process deadline | Keep the four pressure/recovery cases in their own group; follow the [CI operating guide](../../scripts/ci/README.md#local-software-graphics-on-linux--linux-x64). |
| Transmission partitions pass but their parent Smoke process expires | Inspect import and test wall times through the [bounded Transmission partitions](../../scripts/ci/README.md#smoke-node-heap-budget); retain every case, native lifetime boundaries, pixels and 60-frame receipt. |
| Linux/Linux Dawn returns no adapter or the system ICD overrides a working local driver | Use the [local software graphics lane](../../scripts/ci/README.md#local-software-graphics-on-linux--linux-x64); preserve actual adapter identity and full gate failures. |
| Multithread source recovery demands unrelated Pack files before tests | Verify the core/shared consumer contract and scoped shader preparation in [source recovery](../../scripts/ci/README.md#multithread-coreshared-source-recovery); run both Node preparation and Vitest execution regressions. The executable app still builds once; browser scripts run from its app directory and retain all gates. |
| Multithread smoke and benchmark each spend minutes in Vite build | The app transfer contains shader/Pack projections only. Build the executable app once with the shared-input manifest, then run both assertion scripts. A missing index must report its absolute path. Local package commands intentionally rebuild. See [benchmark preparation](../../scripts/ci/README.md#browser-multithread-benchmark-input-materialization). |
| Each browser shard compiles point-shadow shaders again | Check the shared manifest's `shaderBuild` receipt and the profile producer's concrete admission failure. Compare executable compiler inputs; omitted wasm-pack `.gitignore` is packaging metadata. Matching compiler inputs reuse existing bytes; missing or stale receipts rebuild through the source owner. See [CI preparation](../../scripts/ci/README.md#avoid-unused-rendering-test-output). |
| Rendering tests spend time on screenshots or GPU readback | Separate required frame submissions from consumed pixel observations; use the [test-output route](../../scripts/ci/README.md#avoid-unused-rendering-test-output) and preserve all pixel oracles and negative controls. |
| Shared runtime content times out with two Browser renderers | Inspect renderer/submission/capture progress, preserve all seven pixel states, and follow the [owner completion budget](../../scripts/ci/README.md#shared-runtime-content-browser-completion-budget) before changing scheduling. |
| Eight adjacent runtime Renderer files exceed the Browser process deadline without an assertion failure | Keep the measured two-group boundary in the [owner completion budget](../../scripts/ci/README.md#shared-runtime-content-browser-completion-budget); preserve all eleven tests and unchanged deadlines. |
| Runtime browser group reaches 300 seconds while its files pass separately | Check the [material publication process boundary](../../scripts/ci/README.md#material-publication-browser-process-isolation); check both material-publication and render-publication owners; retain each complete journey and unchanged deadlines, then verify the regrouped neighbors and complete roster. |
| Runtime Browser group expires with capture/replay owners unfinished | Follow the [measured process boundaries and four-file Runtime cap](../../scripts/ci/README.md#multi-camera-browser-process-isolation); retain all assertions and deadlines, including the real multi-camera Worker capture/replacement singleton, then verify complete singletons, regrouped neighbors and the full roster. |
| VFX mesh Browser process reaches 300 seconds during native publication | Follow the [VFX publication process boundary](../../scripts/ci/README.md#vfx-mesh-publication-process-boundary); keep both local cases, complete publication/replay and unchanged per-case deadlines. |
| GBuffer capture/replay Browser group times out or reports a cleanup error | Preserve the original fixture failure and follow the [capture/replay process boundary](../../scripts/ci/README.md#gbuffer-capturereplay-browser-process-isolation); passing intermediate pixels do not override a failed process. |
| Standard displacement Browser group reaches its process deadline | Follow the [displacement process boundary](../../scripts/ci/README.md#standard-displacement-browser-process-isolation); retain every pixel oracle and replay, then verify the regrouped neighbors. |
| Eight-file ray Browser group reaches 300 seconds while assertions pass | Follow the [path-tracer process boundary](../../scripts/ci/README.md#ray-path-tracer-browser-process-isolation); retain all six path-tracer cases, the seven neighbors, and unchanged deadlines. |
| Gizmo probe reports Playwright's default 30 seconds despite declaring 180 seconds | Check the [frame admission contract](../../scripts/ci/README.md#transform-gizmo-browser-admission); keep real completed frames and pass options in Playwright's third argument. |
| Gizmo Browser process reaches 300 seconds | Follow its elapsed phase logs and original failure JSON. Keep the 60-frame minimum and all interaction/resource assertions; run the hardware sampling soak explicitly with `verify:performance`, as described in the [admission contract](../../scripts/ci/README.md#transform-gizmo-browser-admission). |
| Decal capture/replay passes alone but its mixed Browser group times out | Follow the [decal process boundary](../../scripts/ci/README.md#decal-capturereplay-browser-process-isolation); retain both 60-frame paths, live/replay pixels, draw-removal falsifiers and unchanged deadlines. |
| A mixed runtime or Ray/GPU Browser group reaches 300 seconds after roster additions | Follow the [rendering-family process budget](../../scripts/ci/README.md#runtime-rendering-browser-process-budgets); retain isolated long owners, all journeys and deadlines, then verify regrouped neighbors and complete CI. |
| Normal/bump material and replay journey exhausts a mixed Browser group | Follow the [normal/bump process boundary](../../scripts/ci/README.md#normalbump-browser-process-isolation); preserve both render paths, every 60-frame case and replay assertion, then verify regrouped neighbors and the full roster. |
| Dawn fixture exhausts time, memory or string length while serializing a large shader manifest | Use the [large shader fixture guide](../../scripts/ci/README.md#large-shader-fixtures-and-cache-recovery-tests); for expanded transmission inputs, reuse the [verified publication fixture](../../scripts/ci/README.md#transmission-manifest-transport). Preserve all programs, variants, source bytes, real fetch and URL cleanup. |
| App build fails while loading an importer | Read `detail.loadError` and its missing path; follow [importer failure recovery](../../scripts/ci/README.md#importer-failures-during-ci-builds) before editing GUID declarations. |
| M6 replay emits validation errors or its viewer falsifier times out | Check [M6 replay and viewer falsifiers](../../scripts/ci/README.md#m6-replay-and-viewer-falsifiers); require valid attachment descriptors, terminal readback, and an active falsifier. |
| Recovery fails at `compile-graph` with an unavailable fullscreen pipeline | Compare graph and prewarm identities using the [fullscreen recovery guide](../../scripts/ci/README.md#fullscreen-feature-recovery-identity), then rerun the real loss-cycle browser owner. |
| Transmission Smoke reaches the Node heap limit | Compare the full and focused fleet Node ceilings using the [Smoke heap budget](../../scripts/ci/README.md#smoke-node-heap-budget); preserve all cases, pixel checks and frame counts, then require complete latest-head CI. |
| Transmission Smoke times out after feature partitions or selects feature work as its frame owner | Verify the single selector for all three [bounded Smoke owners](../../scripts/ci/README.md#transmission-bounded-smoke-owners), nine distinct test rows and the canonical frame receipt; preserve failed aggregate evidence and unchanged budgets. |
| Mixed raytracing Browser group times out after path/replay cases pass | Follow [path-tracer process isolation](../../scripts/ci/README.md#path-tracer-browser-process-isolation); verify the singleton, actual regrouped neighbors and complete final-commit Browser roster under unchanged deadlines. |
| Paired View shard fails private asset recovery with no Git username | Verify parent checkout authorization remains available to `prepare-assets-checkout.mjs`; the View child checkout does not replace this owner. Retain exact pin validation and the failed fetch evidence. |
| CI core rejects a View aggregate runner selector | Check the paired View guide and `check-runner-pool-labels.mjs`; the aggregate needs one capacity label like every self-hosted job. Keep the label gate and success-only aggregate. |
| A CI job exceeds twelve minutes | Measure compiler, fixture, readback and packing work inside the job; start with the [workload investigation](../../scripts/ci/throughput-2026-09-19.md). |
| A Dawn shard reaches its job deadline while its assertions keep passing | Compare native annotations and complete group durations, then use the existing [`dawn-gate-roster.mjs`](../../scripts/ci/dawn-gate-roster.mjs) owner and the [measured ordinary-process budget](../../scripts/ci/README.md#dawn-ordinary-process-budget). Retain serial GPU work, the full roster, and the required aggregate. |
| Nightly Linux package builds auto-install after Bun, or Windows reports heap/console-encoding failures | Follow [nightly dependency ownership and Windows diagnostics](../../scripts/ci/README.md#nightly-dependency-ownership-and-windows-diagnostics), [final-head Dawn allocation](../../scripts/ci/README.md#nightly-repair-final-head-dawn-allocation) and [compiler IR retirement](../../scripts/ci/README.md#nightly-compiler-ir-retirement); retain both frozen installs, the real smoke, full Dawn/coverage and a proving main nightly. |
| Hosted Windows nightly is cancelled during hello-triangle Vite build | Compare checkout, package preparation and Vite timestamps with [hosted checkout scope](../../scripts/ci/README.md#hosted-nightly-checkout-scope) and [hosted nightly budgets](../../scripts/ci/README.md#hosted-nightly-probe-budgets); retain all native probes and the original deadlines. |
| Full Linux nightly loses a native Surface worker | Follow [full Linux nightly capacity](../../scripts/ci/README.md#full-linux-nightly-capacity); verify the actual heavy pool envelope, preserve the structured failure and all native tests. An unexpected exit alone does not prove OOM. |
| Path Dawn placement conflicts with main328 compiler/gate recovery | Use the [current main integration allocation](../../scripts/ci/README.md#path-integration-adopts-main328-compiler-lifetime-and-gate-allocation); use the [integrated allocation](../../scripts/ci/README.md#navigation-and-path-main-integration-allocation), preserve historical cancellations and qualify the complete integrated head. |
| Dawn lane 2 reaches its deadline after complete Transmission and feature-depth owners | Use the [measured complete-owner transfer](../../scripts/ci/README.md#dawn-lane-two-complete-owner-headroom); preserve original groups, isolation, all frames/falsifiers and deadlines, and qualify placement on complete new-head CI. |
| Process cleanup fails after a short TERM grace | Inspect `phase=group-exit` versus `phase=stdio-close`; use the [completion regression](../../scripts/ci/README.md#process-cleanup-completion-observation) before retrying. |
| Solar calibration emits its six receipts but the equal-time replay exceeds the process bound | Follow the [separate complete replay owner](../../scripts/ci/README.md#solar-equal-time-replay-process-ownership); preserve both fresh processes, shared fixture, schedules, pixels and original deadlines. |
| Full CI is slow | Inspect the current run's dependency chain and separate build, transfer, queue and execution time. For expensive rendering loops, follow the CI guide's 60-frame window and preserve phase transitions, falsifiers and receipt validation. |
| CI bounds tests require retired hydration steps or old startup limits | Compare the clean-base reproduction with current [regression ownership](../../scripts/ci/README.md#ci-regression-ownership); assert the delegated preparation, ordering and existing budgets instead of restoring duplicate workflow commands. |
| A job only shows exit 1, timeout or SIGKILL | Open its CI child attempt summary and `process-start` / `failure-detail` records for the command, last output, silence duration and cleanup result. Follow [child failure diagnostics](../../scripts/ci/README.md#child-failure-diagnostics); a signal alone does not establish OOM or an engine cause. |
| Dawn point-shadow preparation times out, or workspace startup exhausts the heap | Check admission of both `base-ssao` and `point-ssao` before GPU tests; the disabled-shadow control consumes base. Expand profiles in the selected plugin's `buildStart`, not workspace discovery. Preserve forced-source validation, GPU deadlines and heap bounds. See [CI shader preparation](../../scripts/ci/README.md#avoid-unused-rendering-test-output). |
| Dawn cooked-material or VFX mesh test passes only after a retry | Reproduce with `--retry=0` and separate cold shader preparation from GPU execution; follow [the fixture guide](../../scripts/ci/README.md#dawn-fixture-cold-shader-preparation). |
| One Dawn lane reaches its job deadline while the others finish early | Compare exact timestamps and complete groups in `dawn-gate-roster.mjs`; distinguish an unfinished native group from an unstarted tail. Use the [current lane2 cancellation](../../scripts/ci/README.md#lane2-cancellation-with-the-complete-current-samples) and the [measured lane budget](../../scripts/ci/README.md#dawn-ordinary-fourth-partition-budget), preserve the full roster and four-lane ceiling. |
| Render Worker content browser group times out | Follow the CI guide's Local software graphics section; keep the five semantic process owners, independent VFX mesh-lighting owner, and all recovery/pixel cases with the current CI publication budget. |
| A test fails after source edits | Reproduce the failing owner locally or on a qualified test machine. Exact package unit files select only their manifest-owned project; an OOM before the test starts is a discovery failure, not test evidence. |
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
| FBX native input disappears after a later shared-artifact timeout | Inspect the completed core archive and its family admission in [consumer source recovery](../../scripts/ci/README.md#consumer-scoped-source-recovery). Retain only exact-source, digest-admitted, complete core outputs; keep the final full consumer verification and original transfer budget. |
| SDK FBX source fallback rejects `cache-publication / cache-target-exists` | Inspect the existing toolchain through the strict bootstrap admission in [local Emscripten cache recovery](../../scripts/ci/README.md#local-emscripten-cache-during-archive-fallback). An archive argument must not bypass exact local-cache validation. |
| Direct WGSL HMR times out after a failed edit is repaired | Identify the outstanding native watcher/WebSocket/HTTP phase. Follow [native HMR polling](../../scripts/ci/README.md#native-direct-wgsl-hmr-polling); preserve the real Vite route, publication/LKG assertions and 30-second bound. |
| Artifact missing after cleanup or a failed-only retry gets report404 | Inspect the source conclusion, direct cleanup dependencies and completion backstop; follow [failed CI artifact retention](../../scripts/ci/README.md#failed-ci-artifact-retention). Retain failed/cancelled CI inputs until expiry and regenerate missing test reports with their actual producers. |
| Render Worker tiles receives SIGKILL while the environment owner is active | Inspect cgroup pressure and peer RSS, then reproduce each complete real Browser owner. Follow [Render Worker memory admission](../../scripts/ci/README.md#render-worker-memory-admission); preserve full owners and their original limits. |
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

For a Catalog startup deadline after inventory scan completes, inspect real compiler CPU samples and composition eviction keys; follow [material cache pressure](../../scripts/ci/README.md#material-composition-cache-pressure-october-5) before changing deadlines.

Full Linux nightly completes Dawn but cancels in coverage: follow [full nightly native shards and measured browser overlap](../../scripts/ci/README.md#full-nightly-native-shards-and-measured-browser-overlap). Compare terminal stage durations, reuse the complete canonical Dawn shard roster and retain one complete coverage owner plus all platform gates; a partial run never closes issues. For overlapping full environment/fog browser owners, use existing exclusive-runner admission and unchanged assertions, then require full final-head CI.


If native closure hashing still misses the forced-source budget, sample the
actual remaining import/GC phase. Follow the same forced-source recovery route
for invariant catalog work and directive-only reachability, preserving ordered
imports, all capability variants and the original complete V8 gate. If the
profile still identifies serial Standard Surface preparation, put it in the
existing bounded compilation Workers and compare complete output plus errors
with the serial path; do not add another pool or change admission limits.


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
| Extended-lighting Spot/Probe comparison or three-device recovery reaches its test timeout | Check the measured owner completion bounds and reproduce with the real software GPU; preserve every recovery cycle, frame, resource/pixel check and oracle. | [Extended lighting completion bounds](../../scripts/ci/README.md#extended-lighting-browser-completion-bounds) |
| **Fog is stable but its beam becomes banded or changes shape** | Run the compact Dawn punctual-scattering oracle and compare the approved demo pose; homogeneous Beer transmittance and frame deltas do not protect spatial appearance. | [Volume stability gate](../../scripts/ci/README.md#volumetric-fog-stability-regression) |
| **Volumetric fog flickers again after a prior fix** | Verify the served worktree and prior-fix ancestry, then run the advancing-World pixel gate; frozen-time or single-image noise checks miss this failure. | [Volume stability gate](../../scripts/ci/README.md#volumetric-fog-stability-regression) |
| **Preview browser test times out or reports Boss VFX GUID 404s** | Check shared Preview declarations, external resources, and root-discovered VFX modules. Reproduce the isolated group with preview-only scope and before-consume readiness before changing timeouts. | [Preview browser asset closure](../../scripts/ci/README.md#preview-browser-asset-closure) |
| **Preview parent process expires before its allowed preparation hook** | Check the actual child process deadline against the existing 420-second Preview total, 330-second producer and 120-second gameplay bounds. Preserve all assets, frames and failure criteria. | [Preview parent deadline](../../scripts/ci/README.md#preview-preparation-and-parent-process-deadline) |
| **Lens replay accumulates fresh devices within one case** | Session disposal retains its caller-owned backend. Destroy each fixture-owned fresh device after its replay and run the original Browser and Dawn owners without changing assertions or deadlines. | [Lens replay ownership](../../scripts/ci/README.md#lens-replay-device-ownership) |
| **Runtime Surface provenance times out before rendering** | Use its singleton Browser group and existing Surface-only asset closure with before-consume readiness; retain all four publication and pixel checks. | [Browser asset closure](../../scripts/ci/README.md#preview-browser-asset-closure) |
| **Browser discovers a failing test under `.forgeax-harness/solo/`** | Keep the floating harness experiment outside both split discovery and Vitest collection; run it with its own fixture commands. | [Browser roster boundary](../../scripts/ci/README.md#browser-roster-excludes-floating-harness-experiments) |
| **A mixed runtime Browser group stalls without an assertion failure** | Inspect per-file timings: the fifteen-case shadow-contact owner requires its own process. Preserve every camera sweep and pixel check. | [Browser asset closure](../../scripts/ci/README.md#preview-browser-asset-closure) |
| **Wave1 recovery reaches the compile-graph deadline only in a mixed browser group** | Run the complete owner in its singleton process and retain both host-loss cycles and the existing recovery deadline. | [Recovery process isolation](../../scripts/ci/README.md#browser-recovery-process-isolation) |
| **Browser shard reaches 300 s after solar-atmosphere calibration reports six passing tests** | The six-test WebGPU owner was packed with other runtime files; keep its singleton process boundary and measured shard weight, then rerun the owner selector. | [Solar calibration owner](../../scripts/ci/README.md#browser-solar-atmosphere-calibration) |
| **Multithread benchmark reaches the two-minute shader materialization timeout before its browser starts** | The single `apps/hello/multithreaded-execution` consumer used the broad `apps/` manifest walk; pass its exact `--app-root` to the materializer and preserve the benchmark contract. | [Multithread benchmark input materialization](../../scripts/ci/README.md#browser-multithread-benchmark-input-materialization) |
| GPU buffer/texture/cubemap counts grow throughout long sessions | Missing symmetric release in store eviction, instance buffers, transient resize, or handle-keyed WeakMaps. | [Resource growth](references/webkit-and-lifetimes.md#monotonic-gpu-resource-growth) |
| **Mixed Browser group expires after video performance has passed, or Dawn lane 2 expires after costly input recovery** | Keep complete video performance and specular AA owners in their measured process/lane boundaries; stop owned video tracks and await disposal. Preserve original frames, deadlines and roster. | [Measured budget ownership](../../scripts/ci/README.md#video-performance-and-specular-aa-budget-ownership) |
| A fresh barrel/clamp/composite process still misses its short case deadline | Inspect phase logs and overlapping GPU groups; retain the exclusive runner boundary and original deadlines, then require complete CI. | [Short bootstrap ownership](../../scripts/ci/README.md#short-renderer-bootstrap-owners) |


> [!TIP]
> Open only the linked recipe file; package READMEs remain the design SSOT.

For repeated Renderer heap growth or Dawn lane imbalance, follow [Renderer teardown retention](../../scripts/ci/README.md#renderer-teardown-retention-and-physical-atmosphere-regression-closure). Reproduce with the existing 4 GiB heap and complete carrier before changing scheduling; preserve the full roster and serial native execution.

When a shared shader profile falls back with a compiler identity mismatch after WASM cache/release recovery, compare actual core and release WASM bytes. A matching Rust source key does not imply identical compiler bytes. Shared app inputs carry their verified compiler pkg; `prepare-ci-inputs.mjs` verifies current source provenance and both WASM/glue digests before publishing the companion. Preserve strict shader input/output fingerprints and source fallback.

When generated-game coverage stalls before loading exits, check overlapping compiler children and shadow texel count before changing deadlines. Its disposable CI project retains three cascades with 256-square maps and exclusive Browser coverage. Preview template smoke scopes one server per template and drains both Browser and server before the next; keep all four journeys and the 90-second startup bound. A final artifact header stall retries after 30 seconds, while a progressing body retains its independent 120-second idle allowance. Follow [Catalog startup diagnosis](../../scripts/ci/README.md#preview-catalog-startup) and require complete final-head timing.

When Surface material publication reaches its 30-second coverage deadline, reproduce the real Pack coverage entrypoint. Measure compiler import, publication and artifact assertions separately; deep typed-array matching can dominate after cooking. Native byte equality must still compare every artifact in full. Its complete publication file has one isolated owner; explicit cold compiler and Browser file sets drain other children before running. Preserve full publication, parent, artifact and recovery assertions plus unchanged aggregate thresholds. A single-file diagnostic cannot establish whole-repository coverage.

When GI compiler fixtures or real Live Dev process ownership exceed their coverage deadlines, inspect their generated coverage owners and overlap with other children. Follow [cold startup coverage ownership](../../scripts/ci/README.md#cold-startup-coverage-ownership); retain their real compilation/process paths, original deadlines and exact-once instrumentation. Local file success does not establish the cause or full coverage acceptance.

For generated Mesh LOD failures, follow [Generated Mesh LOD evidence](../../scripts/ci/README.md#generated-mesh-lod-evidence). Trace the source producer through HTTP/Catalog and inspect the captured indexed or indirect work; preserve all four 60-frame journeys, foreground/replay thresholds and the isolated performance protocol.

When Raster Ray Browser coverage reaches its 120-second case bound, inspect the cold command payload before increasing the budget. Its focused producer cooks/loads only emission and the authored raster shader; retain the production-published raster/transport/composite kernels and every pixel/replay falsifier. The complete path fixture still owns all nine materials. For a parameterized Vitest Browser command, consume its injected context before forwarding application arguments; reproduce through the registered command as well as the direct Node producer. Ordinary Ray commands transport the nine selected programs without unused publication artifacts; complete publication probes cook/load only their requested material set. Search all consumers, including Runtime diffuse GI/reflections/probe placement, before removing publication records from a shared fixture. For Runtime Pack tail pressure, inspect the Vase disposable scene shadow size: the CI fixture retains three 256-square cascades, both real UI journeys and 60 completed frames. Refresh measured file weights and tail reservations after load changes; a green 52m21s run is not the 40-minute timing acceptance. A Dawn lane cancellation after successful groups is incomplete evidence; refresh placement from measured tails and transfer the full GI owner to a lane with headroom, without changing the four-shard ceiling or deadlines.


When the empty template Catalog hangs after a sub-second inventory scan, compare its actual declaration closure with foreign external resource roots. Empty has no external asset dependencies; retain both tracked declarations, normal Preview roots and every other template's closure. Reproduce through the real Catalog HTTP route before changing the original 90-second deadline, then run complete final-head CI. A 2.17x median group/model slowdown across a Browser lane is host evidence; preserve it separately from workload changes and reduce redundant static frames without changing semantic assertions.


When Dawn lane 4 passes its ordinary/compact/VFX/transmission groups but reaches the job bound before later owners start, measure both completed groups and the unfinished tail. The CI guide records complete GI-5, VFX-depth, VFX-mesh and direct-light placements across lanes with headroom. Preserve all native partitions and unchanged deadlines; an ordinary partition pass or cancelled workflow never admits the full lane.


For an SDK PR consumer that submits a frame and exposes gameplay inspection but never exits its startup overlay, preserve the original deadline and renderer/fatal/server diagnostics. The CI operating guide records the bounded disposable-project shadow and viewport profile; exact archive and extracted template bytes stay immutable, and release qualification retains its full workload. Require complete exact-head SDK preflight rather than treating early frames as game readiness.


If a relocated Dawn tail times out on a slower host, use completed native group durations, individual file durations and the exact cancellation boundary rather than the previous whole-job receipt. Recheck actual Vitest discovery after moving complete files out of ordinary quarters: their membership changes. The CI guide records the costly Surface Standard, clipping and Deferred parity files as one complete isolated owner on lane 2; the current renderer base-profile producer travels with the complete renderer owner on lane 1. Placement arrays do not override canonical execution order. Preserve four jobs and every owner; follow the current job envelope in the CI guide, label projections as estimates, and require complete final-head CI.


When real LOD GPU gains and all five falsifiers pass but CPU median admission fails, retain the complete failed sample report and its original threshold. Compare the logged allowed mask, quota and actual affinity; a broad shared-host mask must not force every named runner onto its first CPU window. The CI guide records stable Runner-identity spreading with unchanged quotas and explicit non-exclusive semantics. This corrects systematic concentration, not a proven performance cause; require real final-head metrics and never broaden retries to hide CPU admission failures.


If GI-6 reaches the lane deadline after the field file passes, distinguish the Screen Probe file's incomplete recovery/replay assertions from its preceding field receipt. The canonical roster gives Screen Probe a fresh native owner with measured headroom; the original field and complete discovery remain. Dawn and authoritative Smoke descendants inherit the effective CPU budget through the same affinity envelope. Static Dawn CI settling uses the already validated Browser frame budget, while full defaults and canonical sixty-frame Smoke remain intact. Require complete next-head GPU evidence.

For GI tails dominated by repeated steady-state frames, apply the existing lightweight fixture profile before adding lanes. The CI guide defines bounded repeated residency, Screen Probe settling and deterministic bake samples while retaining all physical bounds and recovery/replay assertions. Multiview retains its complete 240-frame observation and separate 240-frame reference soak: the shorter 128-frame experiment failed to reach the shared physical target. Preserve that convergence window rather than weakening its fairness tolerance. Default and Native qualification stay full. Distinguish the 27-minute Dawn scheduling envelope from the complete 40-minute acceptance target. A Preview Catalog timeout after inventory projection is not proof of a scanner failure; preserve its deadline and reproduce the exact request before editing a producer.


For a Browser lane that keeps passing groups but exceeds the complete CI budget, compare completed per-file and native-process durations across all four lanes before changing fixture semantics. Follow the [Browser CPU envelope and refreshed balance](../../scripts/ci/README.md#browser-cpu-envelope-and-refreshed-measured-balance): preserve unfinished owners, startup and exclusive reservations, then validate the full roster under the effective Runner CPU mask. A cancelled known-failing run supplies measurements, never acceptance.


When all tests pass but reports and cleanup push the complete run beyond forty minutes, keep that green run as over-budget evidence. Follow the [complete green run above the time target](../../scripts/ci/README.md#complete-green-run-above-the-time-target): measure serial upload/cleanup tails separately from file bodies and startup, and check CPU envelopes on the remaining browser commands as well as the main split gate. Preserve the complete ending steps and require the next final-head run.

For unexplained View Play retirement latency, use the CI operating guide's
`view-play-lifecycle-diagnostic.integration.test.ts` exact-selector diagnostic.
Verify the presented owner survives until cleanup settles; retain unconfirmed
cleanup for an actual lost transport.
It restores the pinned View source and keeps the actual independent run while
observing two cycles. Read control/status/stop, close ACK and Vite close timings
before changing the owner. It is not the ten-cycle/full-CI delivery gate.


For paired View CI scheduling, the operating guide owns the complete grouped
consumer roster. A single `test:view --group` result is a diagnostic receipt;
only the complete aggregate qualifies integration. Engine CI uses four `--shard` selections over all groups; verify exact-once group coverage before changing placement. Preserve the ten-cycle
independent-run chain and each language's live-to-cold publication sequence.
Missing `.ci/forgeax-engine` paths or an independent-package `NODE_PATH` rejection
route to explicit source-mode selection in that guide. Retain the separate SDK
npm/ZIP installed-script qualifications; setting a source flag is not archive proof.


When the paired View Editor misses sixty ready frames with a healthy World,
preserve its readiness series and real failing tape before changing workload.
Follow [View diagnostic CI shadow workload](../../scripts/ci/README.md#view-diagnostic-ci-shadow-workload):
the CI profile reduces shadow maps only in the complete disposable project,
while installed SDK/template bytes, all sixty ready frames, sky pixels and the
original admission remain. A ready screenshot or partial frame count is not a pass.

When a compact independent-game screenshot fails authored-sky admission, inspect
the recorded ROI against the actual HUD before changing rendering or thresholds.
The sky probe uses the fixed outer margin before both HUD cards; proportional
horizontal positions can enter the vase HUD at 320x180. Keep the original sixteen
blue pixels and horizon-gradient falsifier, and require final-head SDK evidence.

For paired View diagnostic pressure, the CI page uses an 860x660 viewport with
the complete scene and original ready-frame admission. The copied project has
128-square shadows and bounded procedural tessellation; preserve every mesh/material identity, surface
kernel, scene entity and formal SDK/template byte. Inspect the real failing RHI
tape before attributing a slow healthy renderer to a shader. See
[paired workload evidence](../../scripts/ci/README.md#paired-view-scene-geometry-and-pixels).
Scope the lightweight
flag to that diagnostic child: the separate full plugin Runtime Capture UI
checks exact 1280x720 images, and a global CI flag changes its producer contract.

For a slow SDK independent-input gate, inspect `independentRun.launch`, capture,
reload and replacement stages before changing rendering. The real snapshot owns
the complete published dependency closure and immutable version. Follow
[snapshot I/O evidence](../../scripts/ci/README.md#independent-run-snapshot-io);
small-file buffering never permits missing dependencies, skipped rescans,
mutable links or unchanged-version admission after author edits.
The full independent run now belongs to the byte-verified View consumer, followed
by the complete JS publication/replay chain. Project retains TS and Game 3D;
compare all four paths before moving whole owners. See the
[measured seed-barrier balance](../../scripts/ci/README.md#remove-the-seed-browser-barrier-and-balance-language-chains).

When Dawn lane 1 expires before GI after a cold base-profile producer, inspect
all group timings together: the measured Surface owner now runs on lane 4 and
complete GI-5 on lane 1 after run 37248870129. Preserve their fresh native processes and the four-shard
ceiling; group transfers are estimates until the whole final-head gate passes.

If Smoke index 3 dominates after the other three jobs finish, refresh both its
real gate durations and fixed workflow-tail reservation. The weighted scheduler
now uses all 34 successful gate receipts and 257/377/215/661-second tails from
run 37197385959. Keep every complete 60-frame owner and verify final-head wall time.

When Render Worker device-loss recovery stays at epoch one, inspect the actual
`render-worker-recovery` stderr record and `render-worker-browser-*`
artifact. Determine whether execution faulted, the frame watchdog fired or the
native loss reached the renderer. Preserve the real two-epoch recovery assertion
and original forty-second poll; an unclassified rerun cannot establish a fix.


For the Render Worker recovery fixture, distinguish native `destroyed` teardown
from unexpected `unknown` loss. The `87ad683aa7` failure report stayed alive at
epoch one with 1,277 completed frames after native destruction. The fixture now
projects its explicitly injected native loss promise to unexpected loss while
leaving normal disposal unchanged; its real GPU destruction, recovery deadline,
pixel admission and World/tick invariants remain required. This projection is
not a claim of an actual native driver loss. The primary Node gate executes
`render-worker-loss-fixture.test.mjs` against the actual Blob prelude, while
complete Browser CI remains the recovery acceptance gate.


For installed SDK View backend startup failures, inspect `backend-start-failure.json`
and `backend-start.log` in the existing `view-registry` evidence before changing
startup behavior or deadlines. The diagnostic preserves the original result,
actual backend status and the log path supplied by its owner. Source-mode ready
startup is a different route; a successful retry is not a root-cause repair.
Run `37203881685` passed three Dawn lanes in 16m23s/19m38s/22m04s and expired lane
four before its GI tail. Complete Surface now runs in lane one and specular AA
plus GI-3 in lane two; all four lanes, native boundaries and admissions remain.


At `82aab30afe`, installed SDK backend startup passed in 11.9 seconds, but
RHI fit admission failed after the real resize journey restored 1440x900 while
its bound still used the initial 1000x700. Restore the configured viewport after
the retained 1280x800 resize, and derive fit/report dimensions from the actual
page viewport. The actual resize-call regression is red before and green after
for compact CI, with the full viewport and both resize transitions retained.
Complete final-head physical CI remains required.


Run `37208526589` passed Dawn lanes one/two/three in 19m57s/20m28s/21m32s,
but lane four expired in Screen Probe after ordinary 666s, compact 146s, VFX
185s and GI-2 438s. Exchange complete GI-2 with GI-3 (81s) and GI-5 (165s)
from lane two; all keep the same point-profile producer, fresh processes,
files and admissions. The estimated transfer is 191 seconds, not a new physical
measurement. Main `0eb6562bf4` is integrated with its animation and ownership
changes; local Engine build, source types, DDC and shader intersection checks
pass. Final acceptance requires complete CI on the integrated commit.

When the public point-shadow manifest case times out under coverage, preserve
`FORGEAX_ENGINE_SHADER_SOURCE_BUILD=1` and its 600-second bound. Its complete
public-surface file shares the existing explicit shader compiler coverage owner;
ordinary children derive exclusions from that same file set. Follow
[forced-source coverage ownership](../../scripts/ci/README.md#forced-source-public-shader-coverage-ownership).
Focused non-coverage success does not establish the cause or whole-coverage acceptance.

For repeated complete Dawn job-bound cancellations, compare terminal per-group
logs and use the existing `dawn-gate-roster.mjs` allocation. Transfer complete
owners only, conserve actual discovery and original process boundaries, then
require full final-head CI. The CI guide records receiving estimates separately
from measured acceptance; a successful focused group is not a whole-lane pass.

For GTA exact `217dfaf37` lane-2 job cancellation after all native groups passed, follow [the complete job-bound recovery](../../scripts/ci/README.md#gta-complete-dawn-job-bound-recovery). The historical GI-2 lane-1 transfer is superseded by the current complete-owner roster; use its latest allocation and preserve the original 27-minute bound and every owner. The projected receiving costs require full final-head CI. A passing native terminal does not override a cancelled required job.

For the SDK follow-up Dawn cancellation, inspect the [complete owner recovery](../../scripts/ci/README.md#complete-dawn-recovery-on-the-sdk-follow-up). The exact d44 four-lane pass supersedes that earlier allocation; preserve complete owners, original deadlines and require integrated final-head CI. SDK success alone does not qualify Main.

For SDK software-GPU thread pressure, verify the inherited `runner-affinity` record against the actual cgroup quota through the [SDK CPU envelope](../../scripts/ci/README.md#sdk-software-gpu-cpu-envelope). Reuse the existing wrapper for all three complete browser owners; a quota-sized mask is not an exclusive CPU lease or proof of a speedup.

For the Surface case that passes HDR/MSAA oracles but exhausts its deadline during the second App lifecycle, follow the [static warmup evidence](../../scripts/ci/README.md#surface-browser-static-warmup-recovery). CI reduces only repeated initial MSAA warmup; all pixel witnesses and lifecycle assertions must pass on the real browser within the original bounds.

For SDK player-read admission stalls or the framebuffer/environment/light/MRT group deadline, follow the [foreground and native-lifetime route](../../scripts/ci/README.md#sdk-gameplay-inspection-and-complete-browser-lifetimes). Preserve Worker/frame-boundary semantics, bounded original-cause diagnostics and every real-browser assertion; an unclassified later pass is not a root-cause claim.

For repeated resource-preview capture timeouts, inspect the target-specific App error detail and textual hint, including its Renderer environment and completed-ready floor. The healthy editor's report cannot qualify a mesh/material child. See the [October 5 recovery evidence](../../scripts/ci/README.md#october-5-view-workload-and-complete-dawn-tail); retain ten-second admission and real final-head capture.

### Browser preparation before the first test

If no Chromium or test has started and sampling shows filesystem preparation,
check the independent browser project's Vite watcher in
`config/vitest-browser-project.ts`. Test discovery exclusions do not filter
watches. Exclude floating `.forgeax-harness` loop state while retaining source,
asset roots and HMR. Reproduce with the real Vite watcher regression at
`scripts/__tests__/browser-harness-watch.integration.test.ts`, then rerun the
unchanged browser gate. Preserve preparation evidence; it is not a rendering pass.

When the glTF static image-import gate names an unrelated import, inspect the
actual syntax and diagnostic line before changing asset producers. The gate
uses TypeScript import declarations; comments and string examples do not create
dependency edges. Run its real CLI regression at
`scripts/__tests__/gltf-image-import-gate.test.ts`, retain rejection of actual
image imports, then require final-head CI. See
[glTF dependency syntax](../../scripts/ci/README.md#gltf-static-image-dependency-syntax-gate).

When the public point-shadow manifest case times out under coverage, preserve
`FORGEAX_ENGINE_SHADER_SOURCE_BUILD=1` and its 600-second bound. Its complete
public-surface file shares the existing explicit shader compiler coverage owner;
ordinary children derive exclusions from that same file set. Follow
[forced-source coverage ownership](../../scripts/ci/README.md#forced-source-public-shader-coverage-ownership).
Focused non-coverage success does not establish the cause or whole-coverage acceptance.

For repeated complete Dawn job-bound cancellations, compare terminal per-group
logs and use the existing `dawn-gate-roster.mjs` allocation. Transfer complete
owners only, conserve actual discovery and original process boundaries, then
require full final-head CI. The CI guide records receiving estimates separately
from measured acceptance; a successful focused group is not a whole-lane pass.

For navigation SDK lane-1 cancellations, use the [paired integration receipts](../../scripts/ci/README.md#navigation-sdk-final-head-dawn-recovery): retain both original 27-minute failures, latest-main profile reuse and all four Browser owner processes while adopting the complete measured native-owner transfers. Ninety scheduling regressions do not replace complete final-head CI or SDK.

For a zero diffuse direct-control or cutout visible-surface coverage failure,
read the optional Dawn artifact's original `direct.rhitape` or
`*-masked.rhitape` together with raw HDR/identity bytes and latest state.
The ordinary raster-to-Global witness directories preserve their cold frame
and bounded compute records. Route these tapes through RHI Debug before
changing the shader/material owner; artifact availability does not pass the gate.


For a cold Standard raster/ray Pack test that times out only in V8 coverage,
retain the original real-Naga test and deadline, then inspect its exclusive
file-set ownership and actual runner resource evidence. Follow
[integrated coverage and Dawn admission](../../scripts/ci/README.md#integrated-cold-material-coverage-and-complete-dawn-admission).
A non-coverage pass or scheduler contract test does not qualify the instrumented
runtime. For Dawn27-minute cancellations, use terminal complete-owner costs,
keep censored tails explicit, conserve all35 groups and require complete CI.

For integrated Dawn lane cancellation or a PCM loop failure confined to its mixed Browser cohort, follow the [measured owner boundaries](../../scripts/ci/README.md#integrated-nightly-follow-up-boundaries). Preserve censored tails, transfer only complete native groups into measured headroom, and reproduce the exact browser cohort before selecting an existing fresh-process boundary. Keep all original assertions and deadlines; require full latest-head CI and SDK.

For owned Chrome software-GPU threads outside the selected Runner CPU mask, follow
[escaped software-GPU affinity](../../scripts/ci/README.md#escaped-software-gpu-cpu-affinity).
Preserve the before-correction receipt and real RHI/deadline evidence; a corrected
mask alone is not a completed-frame or complete-CI pass.

When Dawn finishes an expensive passing prefix then reaches the job deadline,
use [final06 Dawn recovery](../../scripts/ci/README.md#final06-dawn-deadline-recovery).
Distinguish completed native receipts from censored GI work; rebalance complete
owners while retaining the original deadline and full discovery roster.

For an SDK source job reaching its outer Actions maximum after public source preparation, follow [SDK source live progress](../../scripts/ci/README.md#sdk-source-job-cancellation-and-live-progress). Preserve the cancelled job and partial captures, distinguish the original per-phase bound from the outer job limit, and read live child phases before assigning a replay or queue cause. Partial artifacts do not replace terminal acceptance.
