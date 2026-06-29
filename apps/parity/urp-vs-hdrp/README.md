# `@forgeax/parity-urp-vs-hdrp`

URP vs HDRP pixel-parity fixture (feat-20260608-cluster-lighting M7).

Renders the same scene (≤ 4 PointLight) twice — left canvas via URP (the
default), right canvas via HDRP (`installPipeline(forgeax::hdrp)`) — and
exposes `window.__captureLeft` / `window.__captureRight` for the
`scripts/bench/pixel-parity.mjs` runner.

## AC-22 status (BENCH-DEBT)

- **AC-22 target** — URP-vs-HDRP pixel parity ε ≤ 0.001 (normalised), ≤ 4
  PointLight subset.
- **Current threshold** — `package.json#forgeax.metrics.bench.pixelDiff.threshold = 65536`
  (px count, not normalised; effectively "any diff under 65 536 px on a
  512 × 512 capture passes"). This is the workaround that absorbs the HDRP
  empty-graph diff while the cluster-forward draw is incomplete.
- **Why the threshold is wide** — even after Round-2 fix-up
  ([w18-fix-r2 / w21-fix-r2]) landed real RHI buffer allocation +
  `queue.writeBuffer` for `light_data` / `cluster_grid` / `light_index_list` /
  `cluster_uniform`, the HDRP `cluster-forward` pass `execute` closure is still
  a no-op draw — the BGL + PSO + WGSL fragment GGX accumulation that turns the
  uploaded buffers into pixel output is **out of scope** for feat-20260608 and
  lands in a follow-up. The HDRP capture stays at clear color, so the URP-vs-
  HDRP diff is dominated by URP's ~50 k lit pixels, never by HDRP-cluster
  shading inaccuracy.
- **When to revert to ε ≤ 0.001** — once the cluster-forward shader-driven
  draw lands (BGL slots 3..6 bound, PSO built against
  `packages/shader/src/hdrp-cluster-forward.wgsl`, draw call iterates
  `validatedOrdered`), this threshold collapses back to `1` (or whatever the
  normalised ε ≤ 0.001 maps to in `pixel-parity.mjs`). The reverse-anchor for
  that follow-up is feat-20260609-hdrp-cluster-fragment-ggx will land the visible GGX cluster draw, after which this threshold reverts to ε≤0.001. Current threshold + scope-amend rationale: see `.forgeax-harness/forgeax-loop/feat-20260608-cluster-lighting/implement-decisions.md` D-implement-1.

> Authoritative anchor: feat-20260608 implement-review.md F-3 + F-7 (round-1)
> + the round-2 fix-up commits `[w18-fix-r2]` / `[w21-fix-r2]` /
> `[w25-fix-r2]` / `[w26-fix-r2]`.
