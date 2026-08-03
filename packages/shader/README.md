# @forgeax/engine-shader

> [!IMPORTANT]
> A custom material starts as WGSL source plus one `MaterialAsset` contract. The build manifest publishes the composed module and the material cook publishes the resolved record, artifact bytes, references, and receipt. Runtime resolves those facts from the catalog; application code does not install or duplicate shader artifacts. The recovery route is always source or cook repair.

## MaterialAsset and shader route

The recovery route is to inspect the structured code, detail, and hint, then
repair the source or cook input before retrying the catalog load.

Declare `passes[].program.module`, `parameters`, `values`, and optional `parent` on the same
MaterialAsset. A texture value keeps its own `coordinates.set` and
`coordinates.transform`, so every slot remains explicit from glTF import to
fragment sampling. The root contract is inherited by child materials; a child
only supplies values it owns.

```ts
assets.configurePackIndex('/pack-index.json');
const result = await assets.loadByGuid<MaterialAsset>(materialGuid);
if (!result.ok) {
  report(result.error.code, result.error.detail, result.error.hint);
  return;
}
const materialHandle = world.allocSharedRef('MaterialAsset', result.value);
```

The custom-shader demo is the executable reference: [`apps/hello/custom-shader`](../../apps/hello/custom-shader). It loads the root and derived GUIDs, validates their cooked records, checks the manifest artifact, and only then draws.

## Shader module catalog

`ShaderRegistry` owns the content-addressed build manifest. It is a runtime
lookup boundary, not an authoring store.

| Entry | Shape | Description |
|:--|:--|:--|
| `ShaderRegistry.loadManifest()` | `() => Promise<Result<void, ShaderError>>` | Load and validate the manifest |
| `ShaderRegistry.get(hash)` | `(string) => Result<ShaderModule, RhiError \| ShaderError>` | Resolve an engine module by content hash |
| `ShaderRegistry.findMaterialArtifact(id)` | `(string) => Result<MaterialArtifact, ShaderError>` | Find the published module selected by a cooked material |
| `ShaderRegistry.materialShaderIdentifiers()` | `() => IterableIterator<string>` | Enumerate published material module identifiers |

The WGSL-level module and the RHI GPU handle are different concepts. This
package owns the former; `@forgeax/engine-rhi` owns the latter.

## Contract derivation

The compiler derives binding layout, uniform offsets, texture field names, and
the injection boundary from the material parameter contract. WGSL reflection
must agree with that derived shape before a record is published. Per-slot
texture coordinates are data in `MaterialTextureValue`, not a global shader
switch.

## Error recovery

Material and shader errors are closed. Switch on `error.code`, then use the
code-specific `detail` and `hint`:

| Code | Meaning | Recovery |
|:--|:--|:--|
| `material-contract-program-mismatch` | A pass does not satisfy the root contract | Align the pass module and re-cook |
| `material-reflection-binding-mismatch` | Reflection differs from the derived bindings | Fix WGSL or parameters, then re-cook |
| `shader-module-not-found` | The published module is absent | Add it to the build source catalog and rebuild |
| `material-specialization-not-cooked` | No runtime artifact exists for the selection | Run the cook path and publish its record |
| `material-specialization-stale-generation` | A dependency changed after cooking | Wait for dependencies to settle and re-cook |

Never hide one of these errors by creating an app-local artifact or changing a
demo's material shape.

## Built-in PBR contract

The built-in PBR shader has named coordinate records for base color, metallic
roughness, normal, specular tint, emissive, and occlusion. Each record carries
offset, scale, rotation, coordinate set, and physical extent metadata. The
render package projects the records into the UBO; the shader selects the
declared vertex coordinate input per slot.

## References

- [`@forgeax/engine-types` MaterialAsset](../types/README.md#materialasset-route)
- [`@forgeax/engine-pack` cook contract](../pack/README.md#materialasset-cook-contract)
- [`MaterialAsset migration`](https://github.com/ForgeaX-Games/forgeax-engine-harness/blob/main/docs/material-asset-migration.md)
