# @forgeax/engine-fbx

Import FBX assets via Autodesk FBX SDK 2020.3.7 native addon.
Same `loadByGuid<SceneAsset>()` interface as the glTF importer —
register once, load any `.fbx` file.

## Quick start

```ts
import { fbxImporter } from '@forgeax/engine-fbx';
import { importers } from '@forgeax/engine-import';

importers.register(fbxImporter);
// Then import via vite-plugin-pack with a *.fbx.meta.json sidecar
// (CLI subcommand `forgeax-engine-remote-fbx` is a stub; deferred to follow-up feat).
// or via vite-plugin-pack with a *.fbx.meta.json sidecar.
```

## 7 sub-asset POD types (SSOT in `@forgeax/engine-types`)

| POD | Description | FBX source |
|:--|:--|:--|
| `MeshPod` | vertices, indices, attributes, submeshes | `FbxMesh` control points |
| `MaterialPod` | PBR parameters (StingrayPbs / Phong fallback) | `FbxSurfaceMaterial` |
| `ScenePod` | entity hierarchy + mounts | `FbxNode` tree |
| `TexturePod` | external file path | `FbxFileTexture` |
| `SkeletonPod` | jointCount + inverse bind matrices | `FbxSkin` deformer |
| `SkinPod` | skeletonGuid + jointPaths | `FbxSkin` clusters |
| `AnimationClipPod` | duration + channels + samplers (30 fps fixed, merge-keys from per-axis X/Y/Z, linear resample) | `FbxAnimStack` curves |

## Importer registration

```ts
import { fbxImporter } from '@forgeax/engine-fbx';
import { importers } from '@forgeax/engine-import';

importers.register(fbxImporter);
```

The import runner dispatches on `meta.importer: 'fbx'`.

## Error codes

Errors are structured (charter P3): every error object carries `.code`,
`.expected`, `.hint`, and `.detail`. AI users switch on `.code` for
exhaustive handling — no string parsing required.

### FbxErrorCode (this package, closed union)

| Code | Detail | Hint |
|:--|:--|:--|
| `fbx-binding-not-built` | `{ sdkRoot, binding }` | Set `FBX_SDK_ROOT` then `pnpm rebuild @forgeax/engine-fbx` |
| `fbx-mesh-type-unsupported` | `{ meshType: 'nurbs'\|'patch', meshName }` | Convert NURBS/patch surface to polygon mesh before export |

> **Note on error surfacing via import-runner.** The `Importer.import` contract
> returns `Promise<readonly ImportedAsset[]>` (no `Result` envelope), so `fbxImporter`
> throws a plain `Error` whose `.message` contains the `FbxErrorCode` string.
> The import-runner catches it as `import-internal-error`; the code string appears
> in `detail.reason`. AI users grepping for `'fbx-binding-not-built'` will find it
> there.
> A future plan-layer feat (OOS-*) may introduce `ResultImporter` for structural
> error surfacing.

### ImportErrorCode (in `@forgeax/engine-types`, 5 members)

Runtime dispatch errors: `importer-not-registered`, `source-read-failed`,
`import-produced-no-assets`, `guid-mismatch`, `import-internal-error`.

### GltfErrorCode (in `@forgeax/engine-gltf`)

The glTF importer's 15 error codes were migrated from `@forgeax/engine-types`
to `@forgeax/engine-gltf` during feat-20260615 (DIP: types does not know
any importer-specific error code). Import from `@forgeax/engine-gltf` when
handling glTF-specific failures.

## Material mapping

Three branches, one output (`passes[0].shader` = `'forgeax::default-standard-pbr'`).
Priority: StingrayPBS > Phong > Lambert > fallback.

| Branch | Detection | Mapping |
|:--|:--|:--|
| **StingrayPBS** | `FbxImplementation::GetName() === 'StingrayPBS'` | Channels copied directly: `baseColor`, `metallic`, `roughness`, `normal`, `occlusion` |
| **Phong / Lambert** | `FbxSurfacePhong` or `FbxSurfaceLambert` | `baseColor = diffuse`, `metallic = 0`, `roughness = 1 - sqrt(shininess / 100)` |
| **Default fallback** | No recognizable material type | `baseColor = #808080` (grey), `metallic = 0`, `roughness = 0.5` |

The Phong-to-PBR roughness formula (`roughness = 1 - sqrt(shininess / 100)`)
maps the Phong `shininess` exponent (range ~0-100) to the PBR `roughness` factor
(range 0-1), assuming `max_specular_power = 100` in the source tool.

## CLI

```bash
forgeax-engine-remote-fbx import <file>.fbx
```

The `cli-fbx.ts` entrypoint is an export-only stub; full CLI subcommand
registration in `@forgeax/engine-remote` is deferred to a follow-up feat.

## Toolchain

Requires FBX SDK 2020.3.7. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for
platform-specific installation instructions.

Set `FBX_SDK_ROOT` to the SDK install root, then:

```bash
pnpm rebuild @forgeax/engine-fbx
```

### CI job

An optional `smoke-fbx-macos-arm64` job runs on `macos-latest` with FBX SDK
installed. It is `continue-on-error: true` — failure does not block PR merge.

## OOS (out of scope)

- NURBS / patch surfaces (fail-fast with `fbx-mesh-type-unsupported`)
- Embedded media textures (warn + skip)
- Multiple animation takes (first take only)
- Hermite weighted tangent (linear resample only)
- Runtime FBX import (build-time only)

## License

Apache-2.0. FBX SDK is distributed under the Autodesk FBX SDK license.