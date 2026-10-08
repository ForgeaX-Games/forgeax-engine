# GPU frame evidence

`gpu-frame-samples.json` is intentionally not checked in as a synthetic
benchmark. A real runner must capture the same build, glTF source, sidecar,
generated Pack digest, seed, viewport, adapter, backend, capability set, and
fixture identity (`candidateScale = [0.5,0.5,0.5]`, `occluderScale =
[2,10,0.1]`) for both `[baseline,treatment]` and `[treatment,baseline]` orders. Each order has
32 successful-submit warm-up frames followed by 64 retained timestamp samples,
for 128 retained samples total (32 per condition across both orders). The
shorter window keeps the real GPU timestamp comparison while bounding hosted
CPU and memory pressure.

The producer uses one locked workload for every comparison group: 128 authored
LOD candidates, 16 intentionally visible side-band instances, and 112
instances behind the same authored occluder. The report separates `control`
and the A/B baseline (root-pinned LOD0 + no occluder), `lodOnly` (LOD-on + no
occluder), `occlusionOnly` (root-pinned LOD0 + occluder), and `treatment`
(LOD-on + occluder). This
prevents the combined 15% GPU gain floor from being attributed to either feature in
isolation. The occluder uses the imported root payload with its LOD policy
stripped, so it is real geometry but cannot inflate the LOD candidate count.
`metrics.workload` must repeat the locked counts, and
`submittedInstanceRatio` is submitted candidates divided by 128; the
production budget therefore requires `<= 0.2` (at least an 80% reduction), not
a visibility-retention threshold. CPU p50/p95, linked candidate/histogram
counts, and derived geometry-work reduction are required when timestamps are available.
The CPU p95 regression is derived from `treatment` versus `occlusionOnly` so
the fixed occluder and HZB cost is not misattributed to LOD. GPU
timestamps continue to use the no-occluder baseline versus the complete
treatment, preserving the combined feature-gain comparison.

The CI runtime producer permits one fresh-process retry only when all five
falsification cases, CPU admission, workload budget, and GPU median gain pass
but the GPU p95 tail alone exceeds the unchanged 5% limit. The retry collects
new same-device samples; it does not alter the workload or relax any threshold.

GPU frame samples come from renderer-owned timestamps on the same graph,
encoder, and submit. Missing or
cross-identity samples produce `unavailable` or `identity-mismatch`; they cannot
be promoted to a production-ready result. RhiNull is structural evidence only.
The producer's two-sentinel occluder calibration is a GPU HZB sanity check,
not proof of the 16/112 distribution. A group snapshot must run the
`SETTLE_SUBMITS` window before the validator can admit its workload
attribution.

Falsification cases are recorded independently for forced LOD0, all-visible,
occlusion off/on, GPU occlusion config off/on, and World reorder. Each
falsification records the one injected intervention and its held facts;
unavailable timestamp artifacts still carry that protocol so schema validation
and later recovery remain deterministic. Forced LOD0 and GPU occlusion off/on
use the same locked placement/camera fixture; with `gpuOcclusion: false` the
treatment must report 128 visible / 0 occluded, and re-enabling it must
restore 16 / 112.

World reorder remains `unavailable` until the renderer exposes per-world facts
from the same submit. Aggregate histogram equality and a later single-world
redraw are diagnostic only; they cannot be promoted to a reorder pass.
