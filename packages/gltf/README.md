# @forgeax/engine-gltf

> Runtime glTF 2.0 importer (Tier-C subset). Pure-function pipeline `parseGlb` / `parseGltf` / `toAssetPack` consumed by build-time CLI plugin bin `forgeax-engine-console-gltf` (resolved via base bin `forgeax-engine-console-gltf import` per kubectl 4th-path discovery; replaces the deleted `forgeax-engine-console-asset import` per 2026-05-16 UX break) writing `<source>.meta.json` (external-asset-package; dispatch on top-level `importer: 'gltf'`); runtime spawn happens via the existing `loadByGuid<SceneAsset>` plus `world.instantiateScene` 4-step recipe (no `loadGltf(url)` parallel API).

## Tier-C scope (upgraded from Tier-B by feat-20260522-learn-render-3-1-sponza-model-loading-with-multi-l)

This package consumes:

- `scenes` + `nodes` (TRS or matrix decomposed via `mat4.decompose` wrapper)
- `meshes` with **multiple primitives** -- each primitive produces an independent `MeshIr` with UUIDv7 GUID; `SceneAsset` nodes reference individual primitive-level mesh sub-assets
- Vertex attributes: `POSITION` (VEC3, mandatory), `NORMAL` (VEC3), `TEXCOORD_0` (VEC2), `TANGENT` (VEC4, optional) -- decoded via `decodeAccessor` SoA path; `INDICES` (U16 scalar)
- `materials` with `pbrMetallicRoughness` 6-field mapping to `MaterialAsset { shadingModel: 'standard' }` (see MaterialIr table below)
- `textures` / `images` / `samplers` top-level arrays parsed into `GltfDoc` IR; texture index -> image index -> URI two-hop resolution via `externalLoader`
- `cameras` of `type: 'perspective'`

### MaterialIr (6-field standard PBR)

| Field | Type | Required | Notes |
|:--|:--|:--|:--|
| `name` | `string` | no | From `material.name` |
| `baseColorFactor` | `[number, number, number, number]` | yes | Defaults to `[1, 1, 1, 1]` |
| `baseColorTexture` | `number` (texture index) | no | Resolved via `textures[ti] -> images[si] -> uri` |
| `metallicFactor` | `number` | yes | Defaults to `1.0` |
| `roughnessFactor` | `number` | yes | Defaults to `1.0` |
| `metallicRoughnessTexture` | `number` (texture index) | no | Same two-hop resolution |
| `normalTexture` | `number` (texture index) | no | Same two-hop resolution; TANGENT optional decode |

### GltfDoc IR (textures / images / samplers)

| Array | Element | Notes |
|:--|:--|:--|
| `textures` | `TextureIr` | `{ sampler?, source, name? }`; `source` = image index |
| `images` | `ImageIr` | `{ uri?, mimeType?, name? }`; `uri` resolved via `externalLoader` |
| `samplers` | `SamplerIr` | `{ magFilter?, minFilter?, wrapS?, wrapT?, name? }` |

### Multi-primitive mesh handling

A single `mesh` with N primitives produces N `MeshIr` entries in `GltfDoc.meshes[]`, each with an independent UUIDv7 GUID. `SceneAsset` entity-prototype nodes carry `MeshFilter` and `MeshRenderer` referencing primitive-level mesh and material sub-assets. This aligns with the ECS single-entity-per-draw-call model (AGENTS.md Component naming).

Out of scope (each routed to its own `feat-future-*` anchor in `requirements.md` OOS-1 .. OOS-15): KHR extensions (note: `EXT_mesh_gpu_instancing` happy-path is supported, see feat-20260518-gltf-instancing-and-name-component) / morph targets / orthographic camera / sparse and interleaved accessors / inspector future fields / pixel-parity vs three.js. v1.1 OOS additions (locked by feat-20260518-gltf-instancing-and-name-component): multi-primitive instancing / mesh-level + material-level + scene-level Name (only node.name lands as ECS `Name`) / instancing hard cap / SoA TRS direct-to-GPU pipe / IR-to-GPU direct path / ROTATION BYTE/SHORT normalized encoding / Babylon thin-instances style SoA channel / Bevy multi-tier Name propagation.

## Importer sub-asset PODs (7 kinds)

`gltfImporter` (consumed by `@forgeax/engine-vite-plugin-pack` at build / dev) emits one `ImportedAsset` POD per declared sub-asset entry in the meta sidecar. The kinds, in `out[]` order, are:

| Kind | POD type (`@forgeax/engine-types`) | refs[] cross-edge |
|:--|:--|:--|
| `mesh` | `MeshAsset` | -- |
| `material` | `MaterialAsset` | texture GUIDs (slot bindings) |
| `scene` | `SceneAsset` | mesh + material + texture + skeleton GUIDs |
| `texture` | `TextureAsset` | -- |
| `skeleton` | `SkeletonAsset` | -- |
| `skin` | `SkinAsset` | skeleton GUID |
| `animation-clip` | `AnimationClip` | -- |

Skinned glTFs (e.g. Khronos `Fox.glb` with 24 joints + 3 clips) flow through the same `loadByGuid<SceneAsset>` + `assets.instantiate` spine as static glTFs. The bridge (`gltfDocToSceneAsset`) auto-emits `Skin { skeleton: <skeleton-guid-string> }` on every node with `NodeIr.skinIndex !== null` when the caller passes `skeletonGuidBySkinIndex`; `AssetRegistry._resolveSceneGuids` resolves the GUID to a runtime Handle at instantiate time, mirroring the `MeshFilter` + `MeshRenderer.materials[]` protocol. `postSpawnResolveJoints` (`@forgeax/engine-runtime`) fills `Skin.joints[]` by walking `SkinAsset.jointPaths` against the spawn root's `ChildOf`-descendant subtree, so multiple `instantiate()` calls on the same skinned `SceneAsset` produce independently-posed instances (no cross-spawn joint sharing).

Sample reference: `apps/hello/skin` -- 3 Khronos Fox foxes side-by-side, each running a different clip (Survey / Walk / Run). Asset source under `forgeax-engine-assets/khronos-gltf-samples/Fox/` (CC BY 4.0; ATTRIBUTION.md alongside).

## Error surface (13-member closed union, plan-strategy section 2.3 + section 8 + feat-20260518 +1 + feat-20260522 +2 + feat-20260523 +4)

`GltfErrorCode` is the SSOT in `@forgeax/engine-gltf` (4-field surface `.code` / `.expected` / `.hint` / `.detail`; `GltfErrorDetail` discriminated per `.code`). Exhaustive `switch (err.code)` without `default` is the AI-user pattern.

> **M1 (2026-06-15):** GltfErrorCode / GltfErrorDetail / GltfError moved from `@forgeax/engine-types` to `@forgeax/engine-gltf`. Imports must change: `import { GltfError, GltfErrorCode, ... } from '@forgeax/engine-gltf'`.

| code | meaning |
|:--|:--|
| `gltf-malformed-header` | GLB magic / version / length header rejection or missing JSON chunk |
| `gltf-version-unsupported` | `asset.version` is not `'2.0'` |
| `gltf-buffer-out-of-bounds` | accessor reads past `bufferView.byteLength` |
| `gltf-extension-unsupported` | `extensionsRequired[]` lists an extension outside the v1 allowlist (`['EXT_mesh_gpu_instancing']`) |
| `gltf-accessor-type-mismatch` | sparse / morph / interleaved / unknown componentType accessor (4 reasons) |
| `gltf-texture-load-failed` | `externalLoader` rejected for a texture `uri`; `detail.uri` carries the failing URI; hint: `'check sidecar meta.json + textures/ directory + vite-plugin-pack /__pack/lookup'` |
| `gltf-meta-missing` | sidecar `<source>.meta.json` is absent next to the `.gltf` / `.glb` source file |
| `gltf-instancing-count-mismatch` | `EXT_mesh_gpu_instancing` three TRS accessors (`TRANSLATION` / `ROTATION` / `SCALE`) have differing element counts |
| `gltf-image-mime-unsupported` | `image/mimeType` is neither `image/jpeg` nor `image/png`; `detail.mimeType` carries the failing MIME; hint: `'supported: image/jpeg \| image/png; transcode externally'` |
| `gltf-skin-joint-count-exceeded` | `skins[j].joints.length > 256` (MAX_JOINTS); hint: `'glTF skin must have <= 256 joints per skin'` |
| `gltf-skin-joint-name-missing` | glTF node referenced by a skin joint has no `name` field; hint contains skinIndex + jointPathIndex |
| `gltf-animation-cubicspline-unsupported` | animation sampler uses `CUBICSPLINE` interpolation (OOS-skin-cubicspline) |
| `gltf-morph-unsupported` | animation channel targets morph weights (`path==='weights'`, OOS-skin-morph-anim) |

## Skin & Animation importer (feat-20260523)

> Two submodules: `parse-skin.ts` (skin index dedupe via UUIDv5 + IBM decoding + jointPath derivation) + `parse-animation.ts` (LINEAR/STEP samplers, CUBICSPLINE/morph fail-fast). Called inside `parseGltfWithBin` -> `toAssetPack` which extends sub-asset output from 3 kinds (mesh/material/scene) to 6 (+ skeleton + skin + animation-clip).

- **Limitations**: CUBICSPLINE interpolation not supported; morph weight animation not supported; jointPath resolution uses leaf-name first-match (same-name sibling is warn-only).
- **BindPose AABB** derived at importer time (per skinned mesh-primitive, static BindPose) and written to mesh asset metadata for frustum cull; dynamic AABB deferred to OOS-skin-dyn-bounds.

## 4-step runtime recipe (apps/hello/gltf, M5)

```ts
// 1. configure pack index (vite-plugin-pack provides /__pack/lookup/:guid in dev mode)
engine.assets.configurePackIndex('/box-pack-index.json');

// 2-4. load mesh / material / scene by GUID, then instantiate scene into world
const sceneResult = await engine.assets.loadByGuid<SceneAsset>(sceneGuid);
if (!sceneResult.ok) {
  // GltfError surfaced upstream from the importer is converted into an AssetError
  // here; the runtime AssetRegistry uses the existing 4-member AssetErrorCode.
  return;
}
const root = engine.assets.instantiate(sceneResult.value, world);
// `root` is the synthetic root Entity (carries SceneInstance + identity Transform);
// equivalent to world.instantiateScene(handle).
```

## CLI plugin — `forgeax-engine-console-gltf`

The build-time CLI subcommand `import` ships as a standalone plugin bin `forgeax-engine-console-gltf` (entry `dist/cli-gltf.mjs`) declared in this package's `package.json#bin`. The base bin `forgeax-engine-console` discovers it via kubectl 4th-path eager PATH scan over the `forgeax-engine-console-` prefix; users invoke the surface as `forgeax-engine-console gltf <sub>` (transparent dispatch through `execvp` to `forgeax-engine-console-gltf`).

The plugin imports `parseGltfFromFile` / `parseGlbFromFile` / `toAssetPack` directly (in-process), so `@forgeax/engine-console` itself zero-imports `@forgeax/engine-gltf` — enforced by reverse grep gate `check-console-not-import-engine.mjs`.

| Subcommand | Description | Exit code |
|:--|:--|:--|
| `forgeax-engine-console-gltf import <path>` | Parse `.gltf` / `.glb`; write sidecar `<source>.meta.json` (top-level `importer: 'gltf'`) next to source; UUIDv7 GUIDs assigned per sub-asset in document order | 0 success / 1 `GltfError` |
| `forgeax-engine-console-gltf import <path> --check` | Dry-run mode — no sidecar write; surfaces `gltf-meta-missing` route b (cf. importer route a) | 0 if sidecar already present / 1 if missing |

```bash
# Invoke via base bin (kubectl-style transparent dispatch)
forgeax-engine-console-gltf import apps/hello/gltf/assets/box.glb
forgeax-engine-console-gltf import apps/hello/gltf/assets/ --check

# Direct invocation (after pnpm -F @forgeax/engine-gltf build)
forgeax-engine-console-gltf import box.glb
```

See `.forgeax-harness/forgeax-loop/feat-20260515-gltf-loader-via-asset-system/plan-strategy.md` for the full roadmap.