---
name: forgeax-engine-shader
description: Author WGSL modules that are consumed by cooked MaterialAsset contracts.
---

# forgeax-engine-shader

> [!IMPORTANT]
> The authoring route is WGSL source plus one MaterialAsset contract. Build-time composition and reflection publish a module manifest entry; material cook publishes the artifact and receipt; runtime resolves both through the catalog. App code never installs or duplicates a shader artifact. The recovery route is source or cook repair.

## Route

The recovery route is structured error inspection followed by source or cook
repair before the first draw. Per-slot `coordinates` stay on the material
texture value.

1. Give the WGSL source a package-owned `#define_import_path`.
2. Import engine modules such as `forgeax_view::common` and
   `forgeax_pbr::brdf`.
3. Declare the same fields in the root MaterialAsset `parameters`, optional
   `parent`, and `values`; use `passes[].program.module` for the module identity.
4. Run build composition, reflection, and material cook.
5. Load the MaterialAsset by GUID and inspect structured readiness errors before
   the first draw.

```ts
assets.configurePackIndex('/pack-index.json');
const result = await assets.loadByGuid<MaterialAsset>(materialGuid);
if (!result.ok) {
  report(result.error.code, result.error.detail, result.error.hint);
  return;
}
const materialHandle = world.allocSharedRef('MaterialAsset', result.value);
```

## Coordinate inputs

The built-in and custom paths use named texture values. `coordinates.set`
selects the vertex coordinate input and `coordinates.transform` applies offset,
scale, and rotation. Do not add a global material coordinate selector; it
cannot represent glTF materials whose slots use different inputs.

## Contract and reflection

The compiler derives uniform layout, sampler/texture bindings, and injection
slots from the MaterialAsset parameter contract. WGSL reflection must match the
derived layout. A mismatch is a build or cook failure and must be repaired at
the source boundary.

## Recovery

| Code | Recovery |
|:--|:--|
| `shader-module-id-missing` | Add a compiler-native module identifier |
| `shader-module-id-duplicate` | Keep one source for the module id |
| `shader-module-not-found` | Add the module to the build source catalog |
| `shader-module-namespace-reserved` | Choose a user-owned namespace |
| `material-reflection-binding-mismatch` | Align WGSL bindings with the root contract and re-cook |
| `material-specialization-not-cooked` | Run the cook path for the requested selection |
| `material-specialization-stale-generation` | Re-cook after dependent source changes settle |

For every failure, switch on `error.code` and read `error.detail` and
`error.hint`. A demo failure routes to the engine or cook boundary; it is not
fixed by changing the demo's material data. This is the recovery route.

## Routing

- Material shape: [`forgeax-engine-material`](../forgeax-engine-material/SKILL.md)
- Asset catalog and pack roots: [`forgeax-engine-assets`](../forgeax-engine-assets/SKILL.md)
- Shader package: [`packages/shader/README.md`](../../packages/shader/README.md)
- Migration: [`docs/material-asset-migration.md`](../../docs/material-asset-migration.md)
