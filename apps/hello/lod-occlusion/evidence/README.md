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
a visibility-retention threshold. CPU p50/p95, query-map p50/p95, query page
pressure, query memory, linked candidate/histogram counts, and derived
geometry-work reduction are required when timestamps are available.
The CPU p95 regression is derived from `treatment` versus `occlusionOnly` so
the fixed occlusion-query transport cost is not misattributed to LOD. GPU
timestamps continue to use the no-occluder baseline versus the complete
treatment, preserving the combined feature-gain comparison.

The CI runtime producer permits one fresh-process retry only when all six
falsification cases, CPU admission, workload budget, and GPU median gain pass
but the GPU p95 tail alone exceeds the unchanged 5% limit. The retry collects
new same-device samples; it does not alter the workload or relax any threshold.

The renderer-owned timestamp spans the first graph pass through the occlusion
resolve/copy terminal marker on the same graph, encoder, and submit. Missing or
cross-identity samples produce `unavailable` or `identity-mismatch`; they cannot
be promoted to a production-ready result. RhiNull is structural evidence only.
The producer's two-sentinel occluder calibration is a query-path sanity check,
not proof of the 16/112 distribution. A group snapshot must visit the
renderer-derived settle floor before the validator can admit its workload
attribution.

Falsification cases are recorded independently for forced LOD0, all-visible,
occlusion off/on, page exhaustion, delayed map, and World reorder. Each
falsification records the one injected intervention and its held facts;
unavailable timestamp artifacts still carry that protocol so schema validation
and later recovery remain deterministic. Forced LOD0 and delayed-map use the
same locked placement/camera fixture, and delayed-map injects a 15 ms
delay inside the renderer's test-only map boundary; the observed map latency
must remain at least 10,000 µs.

World reorder remains `unavailable` until the renderer exposes per-world facts
from the same submit. Aggregate histogram equality and a later single-world
redraw are diagnostic only; they cannot be promoted to a reorder pass.
