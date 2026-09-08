---
name: forgeax-engine-material
description: ForgeaX MaterialAsset authoring and visibility route. Use when creating, loading, or debugging materials, textures, lighting response, or material readiness.
---

# forgeax-engine-material

## Contract index

Keep one MaterialAsset subject and one Pack publication. Runtime bool/value
data, composed module slots, and a closed compiler context are inputs; macros,
feature defines, runtime cooking, and app-local fallbacks are not. Trace
`materialContractDigest`, `sourceClosureDigest`, `layoutIdentity`,
`programIdentity`, `cookIdentity`, and `materialPublicationIdentity` from
`current` to `generation`, repair the first producer divergence, cold-cook the
same GUID, and verify receipt, artifact, and provenance.

> [!IMPORTANT]
> The visible-object recipe is `MeshFilter` + `MeshRenderer` + `MaterialAsset`. Author one material payload, cook its effective contract, load it by GUID, and allocate the World handle. The recovery route is structured error inspection. Do not create an app-local shader artifact or bypass an engine resource defect in a demo.

## Color-lighting parity handoff

For a direct-light material issue, use the [color-lighting parity entry](../../apps/parity/color-lighting/README.md), then follow its [status recovery map](../../apps/parity/color-lighting/status-index.md). The `SceneCase` and `CaseReport` schemas are the report contract; repair the named material or producer owner and rerun the same case. Do not turn a missing producer capture into a material pass.

## Direct-light parity entry

When a visible material is used by a direct-light parity case, start with the
revision-pinned
[`three-r184-finite-range-authority.json`](../../apps/parity/color-lighting/cases/direct-light/calibration/three-r184-finite-range-authority.json)
and its executable authority test. The entry is `ready` only with a matching
Three revision/source hash, fixed config, and complete expected samples;
missing fields mean `blocked` and require evidence recovery.

The shared light vocabulary is:

| Field | Public meaning |
|:--|:--|
| `DirectionalLight.intensity` | Lux in a one-world-unit-per-meter scene |
| `PointLight.intensity` | Candela with positive meter range or no cutoff |
| `SpotLight.intensity` | Candela with meter range and KHR cone mapping |
| `color` | Linear RGB, without a global compensation factor |
| `cosInner` / `cosOuter` | Snapshot fields derived from imported cone radians |
| `direction` | Extract-normalized world direction consumed by both pipelines |

The runtime range factor is the Three r184 squared window
`clamp(1 - (d / c)^4, 0, 1)^2`; KHR's unsquared curve remains an import/reference
falsification and must not be used as the Forge runtime curve. Exposure belongs
to the camera tone/output stage after lighting, so material authoring and light
intensity do not receive an exposure multiplier.

For diagnosis, run the authority and light-snapshot tests, inspect the
normalized snapshot and its buffer projection, then compare independent
browser WebGPU and Dawn captures. Preserve the case `provenance`, named
`captures`, raw hash, analytic/ROI metrics, and `CaseReport.verdict`. Do not
replace a missing engine path with a custom mesh, fallback shader, or app-local
light profile.

## Mental model

The recovery route is structured error inspection followed by source or cook
repair; it never adds a parallel material surface.

`MaterialAsset` owns `passes`, `parameters`, `values`, and optional `parent`.
The root owns the effective contract. A child inherits the root and supplies
only its changed values. A texture value is structured:

```ts
{
  texture: textureGuid,
  sampler: samplerGuid,
  coordinates: {
    set: 1,
    transform: { offset: [0.1, 0.2], scale: [2, 2], rotation: 0.25 },
  },
}
```

The coordinate set and transform remain attached to the named texture slot.
The glTF bridge, pack cook, runtime extract, and built-in PBR shader consume
that same data.

## Author, cook, load

```ts
const material: MaterialAsset = {
  kind: 'material',
  parent: parentGuid,
  values: { baseColor: [0.2, 0.55, 0.95, 1] },
};

assets.configurePackIndex('/pack-index.json');
const loaded = await assets.loadByGuid<MaterialAsset>(materialGuid);
if (!loaded.ok) {
  report(loaded.error.code, loaded.error.detail, loaded.error.hint);
  return;
}
const handle = world.allocSharedRef('MaterialAsset', loaded.value);
```

For a custom module, put `passes[].program.module` in the root contract. The
shader build publishes the module; the material cook publishes the record and
artifact. The application only performs the catalog load and readiness check.

## Points and Lines route

For first-class point or line authoring, route the request through the existing
asset and material owners:

1. Confirm the `MeshAsset` has `point-list` or paired `line-list` topology.
2. Admit exactly one `Points` or `Lines` component with finite positive
   `sizePx` or `widthPx`.
3. Select `Materials.unlit`; do not author a replacement shader or mesh.
4. Let Standard extract, prepare, and record the retained expansion.
5. Use `renderer.inspect` and the RHI debug capture when source, derived,
   binding, or draw evidence is needed.

Admission is atomic. Unsupported topology, invalid style, lane conflicts, or a
missing unlit forward material return a structured refusal. Read `.code`,
`.expected`, `.hint`, and narrowed `.detail`; never infer support from a
message or silently substitute a generic mesh draw.

The direct WebGPU probe is runtime evidence. Clustered unlit, WebGL2 capability
restrictions, and RhiNull structural-only records are separate evidence rows;
RhiNull does not prove pixels or hardware timing. Recovery is inspect, repair
the named source or producer, rebuild or cold-cook, then retry the same
retained/prepared renderer owner. There is no new CLI, RPC, registry, cache, or
recovery ledger for this route.

## Built-in PBR slots

Built-in PBR names its coordinate records by texture slot: base color,
metallic roughness, normal, specular tint, emissive, and occlusion. Each record
contains offset, scale, rotation, coordinate set, and physical extent data.
The vertex input selects the requested coordinate set and clamps only when the
primitive has fewer sets than the material requires.

## Recovery checklist

| Symptom | Inspect | Recovery |
|:--|:--|:--|
| Black standard material | `DirectionalLight`, effective pass, render error | Add the required light or repair the pass, then draw again |
| `material-parent-not-found` | `detail.missingParent`, `detail.chain` | Fix the GUID and re-cook the child |
| `material-circular-inheritance` | `detail.chain` | Remove the repeated parent and re-cook |
| `material-value-unknown` | `detail.parameter` | Declare the parameter in the root contract or remove the value |
| `material-value-type-mismatch` | `detail.expectedType`, `detail.actualType` | Change the value and re-cook |
| `material-specialization-not-cooked` | requested material and selection | Run the cook path and publish the record and artifact |
| `material-specialization-stale-generation` | `detail.dependencies` | Re-cook after dependent sources settle |
| `gltf-material-uv-set-missing` | slot and available sets | Add the source UV set and re-import |

Read `.code`, `.expected`, `.hint`, and the narrowed `.detail`; this is the
recovery route, and it never parses a diagnostic message or silently replaces
an engine resource.

## Routing

- Material shape and error union: [`packages/types/README.md`](../../packages/types/README.md)
- Pack/cook record: [`packages/pack/README.md`](../../packages/pack/README.md)
- Shader module and reflection: [`packages/shader/README.md`](../../packages/shader/README.md)
- Runtime catalog: [`packages/assets-runtime/README.md`](../../packages/assets-runtime/README.md)
- Migration: [`docs/material-asset-migration.md`](https://github.com/ForgeaX-Games/forgeax-engine-harness/blob/main/docs/material-asset-migration.md)

## Visibility is a render boundary, not a material field

Quick start: author `Visibility` through ECS, inspect its effective state from
the render package, and leave `MaterialAsset` unchanged:

```ts
import { Visibility, VisibilityStateValue, resolveVisibility } from '@forgeax/engine-scene';

world.spawn({ component: Visibility, data: { state: VisibilityStateValue.hidden } }).unwrap();
const snapshot = resolveVisibility(world);
```

| Question | Authority | Recovery |
|:--|:--|:--|
| Why is an entity hidden? | `Visibility` intent plus `resolveVisibility` | Inspect `source` and hierarchy diagnostics |
| Why did a material fail? | Material/shader structured errors | Repair the cooked contract and retry |
| Why is the count unexpected? | `renderer.inspect().visibilityStats` | Inspect the renderer candidate path |

Do not replace a missing material, mesh, camera, or visibility path with a
demo-side stand-in. Visibility does not own camera, picking, lifecycle, assets,
or VFX shadow behavior. Those are out of scope for this material skill.
