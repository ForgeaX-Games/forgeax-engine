# @forgeax/engine-shader

## MaterialAsset 唯一成功路径

`paramSchema -> derive -> compile/reflect -> cook/load -> extract/record`
贯穿 shader 与 material。WGSL producer 只声明与 schema 对应的字段；纹理槽
携带 `coordinateSet`、transform 与 `physicalUvScale`，cook 后由
`layoutIdentity` 绑定 shader artifact。identity 失效时修 source 或 cook 输入，
再执行 recook/load。

> [!IMPORTANT]
> Runtime 只查找已发布的 content-addressed artifact；恢复沿 producer、cook
> 与 catalog 的 owner 边界进行，不在 app 侧复制 shader artifact。

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
| `ShaderRegistry.entries()` | `() => IterableIterator<ManifestEntry>` | Enumerate published content-addressed modules in manifest order |
| `ShaderRegistry.materialShaderManifestEntries()` | `() => IterableIterator<MaterialShaderManifestEntry>` | Enumerate validated material shader manifest rows |
| `ShaderRegistry.findMaterialArtifact(id)` | `(string) => Result<MaterialArtifact, ShaderError>` | Find the published module selected by a cooked material |
| `ShaderRegistry.materialShaderIdentifiers()` | `() => IterableIterator<string>` | Enumerate published material module identifiers |

`loadManifest()` validates the complete document before publication. A malformed
entry or material shader row returns one `manifest-malformed` error and leaves
`entries()`, `materialShaderManifestEntries()`, and lazy `get()` resolution
unchanged. Repair the same source and retry on the same registry; a successful
load publishes rows in source order and a later call is idempotent.

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

## Points and Lines shader contract

Points and Lines use the engine-owned `forgeax::points-lines` material shader
manifest row. The row is a content-addressed runtime artifact selected by the
same `MaterialAsset` and `Materials.unlit` route as other built-in materials.
The Standard renderer binds the Points/Lines view at group 0, binding 10, then
uses the prepared expansion geometry in the active main geometry pass.

The runtime contract is compiler-free: it loads a published artifact and never
imports Naga, a shader compiler, or WGSL authoring helpers. `paramSchema`
remains the single source for derived layout and uniform shape. Manifest
validation is atomic; a malformed or stale row leaves the prior published
catalog unchanged and returns a structured error.

| Evidence | Meaning |
|:--|:--|
| shader manifest row | `forgeax::points-lines` is published and content-addressed |
| runtime isolation triple | no Naga in dist, no runtime shader compiler dependency, and no compiler import |
| graph contract | points-lines uses the existing Standard main pass and material binding path |
| lane contract | direct WebGPU is the focused runtime route; clustered unlit and WebGL2 restrictions are structural contracts unless a lane-specific runtime probe is available |

When lookup or reflection fails, inspect `.code`, `.expected`, `.hint`, and the
code-specific `.detail`; repair the source or cook input and republish through
the build-time producer. Do not create an app-local WGSL module, bypass the
manifest, or add a backend-specific shader branch. The same retained/prepared
state supplies render inspection and recovery evidence.

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
