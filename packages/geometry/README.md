# @forgeax/engine-geometry

Pure-function procedural mesh geometry factories + the vertex-attribute-layout SSOT for
forgeax-engine. A **leaf** package: depends on `@forgeax/engine-ecs` (`Result`),
`@forgeax/engine-math` (AABB derivation), and `@forgeax/engine-types` (`MeshAsset` /
`AssetError` / `VertexAttributeMap`), and never imports the renderer or RHI.

## 30-second self-introduction

- **Surface**: 7 Three.js-r184-aligned 3D procedural factories
  (`createBoxGeometry` / `createCapsuleGeometry` / `createConeGeometry` /
  `createCylinderGeometry` / `createPlaneGeometry` / `createSphereGeometry` /
  `createTorusGeometry`),
  each returning `Result<MeshAsset, AssetError>`; the vertex-attribute-layout
  SSOT (`deriveVertexBufferLayout` / `buildMeshAttributeMapForUvSets` /
  `GpuVertexBufferLayoutEntry`); and the tangent + interleave helpers
  (`computeTangentVec4` / `meshFromInterleaved` /
  `PROCEDURAL_FLOATS_PER_VERTEX`). A single entry-point
  `import { ... } from '@forgeax/engine-geometry'`.
- **2D primitives**: `create2dGeometry` turns the twelve Bevy `2d_shapes` primitive
  definitions into triangle-list or line-list `MeshAsset` values, while
  `create2dRingGeometry` builds the reusable ring variants used by the same gallery.
- **Style**: pure functions -- no classes, no mutation, no side effects. Every
  factory returns `Result<MeshAsset, AssetError>` (charter P3 explicit failure).
  Caller owns the returned `MeshAsset`; the package never touches GPU or ECS.
- **Errors**: degenerate parameters (`dim <= 0`, `segments < minimum`, etc.)
  fail-fast with `AssetError({ code: 'asset-parse-failed' })` carrying a
  human-readable `.detail` string. No silent fallback, no `console.warn`,
  no `null` return (charter P3).

## Vertex color contract

`MeshAsset.attributes.color` is the optional geometry-owned vertex color: a
linear RGBA `Float32Array`, with exactly four finite values per vertex. It is
not an sRGB input and does not add a material flag. Procedural authors can set
the field directly; glTF `COLOR_0` is normalized into this same field at the
import boundary. Missing color is a real absence and keeps the color stream
out of the packed bytes.

Use `deriveVertexLayoutProjection` and
`packInterleavedVertexAttributes(attributes, vertexCount)` for layout and
packing. The packer returns a `Result`; callers branch on `ok` before
publishing vertex bytes. The immutable projection owns canonical offsets, stride, mask and
digest; color is host `@location(13)` (`float32x4`, 16 bytes), while existing
locations `0..12` remain unchanged. Render and asset consumers carry this
projection instead of calculating offsets or a parallel stride. See
[`VertexAttributeMap`](../types/src/index.ts) for the public POD shape.

### 30s hands-on example

```ts
import { createBoxGeometry, createSphereGeometry } from '@forgeax/engine-geometry';

// 1. Build a unit box (6 faces, 1 segment per edge)
const box = createBoxGeometry(1, 1, 1);
if (!box.ok) return; // box.error.code === 'asset-parse-failed'
console.log(box.value.vertexCount); // 24 (4 vertices * 6 faces)

// 2. Build a UV sphere and hand the MeshAsset to the AssetRegistry for a handle
const sphere = createSphereGeometry(1, 32, 24);
// ---- ⬆ the factory returns an unregistered MeshAsset POD ----
// To spawn an entity: register via renderer.assets.register(sphere.value).unwrap(),
// then hand the resulting Handle<MeshAsset> to MeshFilter.assetHandle.
```

The 7 factories cover the most common procedural primitives. For an imported
glTF mesh, use `@forgeax/engine-gltf`; FBX follows the same source-plus-Meta
route through `@forgeax/engine-fbx`. Runtime consumption is
`@forgeax/engine-assets-runtime` after the owning importer has cooked the asset.

### 2D primitive geometry

`Shape2d` is the closed input union for circles, sectors, segments, ellipses,
annuli, capsules, rhombi, rectangles, regular polygons, triangles, segments, and
polylines. `create2dGeometry(shape)` returns a filled mesh for closed shapes and a
`line-list` mesh for `segment` / `polyline`. `create2dRingGeometry(shape, thickness)`
returns the ring form for closed non-annulus shapes; ellipse and sector rings follow
the same visual approximation as Bevy's source example. `compute2dBounds(shape, pose)`
derives the transformed AABB and bounding circle from that same shape contract.

```ts
import { create2dGeometry, create2dRingGeometry } from '@forgeax/engine-geometry';

const filled = create2dGeometry({ kind: 'circle', radius: 50 });
const ring = create2dRingGeometry({ kind: 'rectangle', width: 50, height: 100 }, 5);
const arc = create2dGeometry(
  { kind: 'circular-sector', radius: 40, angle: Math.PI / 2 },
  { uv: { kind: 'circular-mask', angle: -Math.PI / 4 } },
);
if (!filled.ok || !ring.ok) return;
```

## API surface

### 7 procedural geometry factories

Each returns `Result<MeshAsset, AssetError>`. Interleaved vertex layout:
position (3xf32) + normal (3xf32) + uv (2xf32) = 8 floats/vertex at creation
time; expanded to the 12-float runtime layout (adds tangent vec4) by
`meshFromInterleaved`.

| Factory | Signature | Minimum segments |
|:--|:--|:--|
| `createBoxGeometry` | `(w, h, d, wSeg?, hSeg?, dSeg?)` | 1 / dim |
| `createCapsuleGeometry` | `(radius, length, capSeg?, radSeg?)` | capSeg >= 1, radSeg >= 3; total height = length + 2*radius (Bevy `Capsule3d` convention) |
| `createConeGeometry` | `(radius, height, radSeg?, hSeg?)` | radSeg=16; delegates to cylinder with top=0 |
| `createCylinderGeometry` | `(rTop, rBottom, h, radSeg?, hSeg?)` | radSeg=16; at least one radius > 0 |
| `createPlaneGeometry` | `(w, h, wSeg?, hSeg?)` | 1 / dim; XY plane, +Z normal |
| `createSphereGeometry` | `(radius, wSeg?, hSeg?)` | wSeg >= 3, hSeg >= 2 |
| `createTorusGeometry` | `(radius, tube, radSeg?, tubSeg?)` | radSeg >= 3, tubSeg >= 3 |

All factories populate `position` / `normal` / `uv` attributes with lowercase
Three.js-r184 key naming. `VertexAttributeMap` also accepts optional `color`
linear RGBA data; see
the [attribute layout](#vertex-attribute-layout-ssot) section.

### Tangent and interleave helpers

| Symbol | Kind | Purpose |
|:--|:--|:--|
| `computeTangentVec4(positions, normals, uvs, indices?)` | fn | Preflights attribute cardinality, triangle topology, and index range, then returns `Result<Float32Array, AssetError>`. Success is the per-vertex tangent (vec4): face-area-weighted average + Gram-Schmidt orthogonalise + handedness sign packed into `.w`. |
| `meshFromInterleaved(vertices, indices)` | fn | Preflights the 8-float interleaved stride and triangle index topology before slicing or allocating output, then returns `Result<MeshAsset, AssetError>` with the 12-float runtime layout. |
| `PROCEDURAL_FLOATS_PER_VERTEX` | const | `12` -- the runtime interleaved stride: position (3) + normal (3) + uv (2) + tangent (4). |

Both helpers return the existing `AssetError` vocabulary with
`error.code === 'asset-parse-failed'` for malformed input. The error detail
identifies the rejected `field`, observed `value`, and `reason`; no tangent,
mesh, or working buffer is allocated before this preflight completes. The
helpers are stateless, so corrected arrays can be passed to the next call and
produce the normal vec4 or mesh result.

| Preflight | Rejected input |
|:--|:--|
| Attribute cardinality | `positions.length` not divisible by 3, or `normals` / `uvs` not matching the derived vertex count |
| Triangle cardinality | Non-indexed vertex count or indexed index count not divisible by 3 |
| Index range | Any index that is not an integer in `[0, vertexCount)` |

### Vertex attribute layout SSOT

| Symbol | Kind | Purpose |
|:--|:--|:--|
| `deriveVertexBufferLayout(map, opts?)` | fn | Derives a fixed-order `GpuVertexBufferLayoutEntry[]` from a `VertexAttributeMap`. The canonical 14-key order (position / normal / uv / tangent / skinIndex / skinWeight / uv1..uv7 / color) assigns `@location(N)` per key. Absent keys reserve no space; `opts.shaderUvSetCount` enables clamp-to-last alias for UV sets. |
| `deriveVertexLayoutProjection(map)` | fn | Creates the immutable canonical projection (`schemaVersion`, attributes, mask, stride, digest). `color` is fixed at host location 13 and `float32x4`. |
| `packInterleavedVertexAttributes(map, vertexCount)` | fn | Packs attribute arrays using that projection and returns `Result<{ projection, vertices }, VertexAttributePackError>`; closed detail reasons identify storage, cardinality, vertex-count, or non-finite failures. |
| `deriveVertexLayoutProjectionFromMask(mask)` | fn | Reconstructs a wire projection through the same canonical key owner; returns a typed error for empty or unknown mask bits. |
| `buildMeshAttributeMapForUvSets(uvSetCount)` | fn | Synthesise a `VertexAttributeMap` with empty `Float32Array(0)` placeholders for `uv` + `uv1..uvN-1`. Used by the forward record stage to pre-declare UV-set slots before interleaving. |
| `GpuVertexBufferLayoutEntry` | type | `{ shaderLocation: number; offset: number; format: GPUVertexFormat }` -- one GPU vertex buffer layout entry. |

```ts
import { deriveVertexBufferLayout, type GpuVertexBufferLayoutEntry } from '@forgeax/engine-geometry';

// Given a MeshAsset.attributes map, derive the GPU vertex buffer layout
const layout: GpuVertexBufferLayoutEntry[] = deriveVertexBufferLayout(mesh.attributes, {
  shaderUvSetCount: 2, // shader expects uv + uv1; if mesh only has uv, uv1 clamps to uv
});
// layout[n].shaderLocation matches WGSL @location(N) declarations.
```

The canonical key order and per-key `GPUVertexFormat` mapping is the SSOT in
`packages/geometry/src/vertex-attribute-layout.ts` (`ATTRIBUTE_FORMAT_MAP`).
Shader `@location(N)` declarations and naga reflection deep-equal tests keep
them in sync.

## Three.js r184 mental alignment

The 6 factory signatures mirror Three.js `BufferGeometry` constructors
byte-for-byte: parameter order, attribute key lowercasing (`position` / `normal`
/ `uv`), and segment-count defaults. AI users migrating from Three.js can swap
the import path and the return-shape check:

```ts
// Three.js:
//   const geo = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
//   const pos = geo.getAttribute('position');

// forgeax:
import { createBoxGeometry } from '@forgeax/engine-geometry';
const res = createBoxGeometry(1, 1, 1, 2, 2, 2);
if (!res.ok) return;
const pos = res.value.attributes.position; // Float32Array, same data
```

Key differences from Three.js:

| Aspect | Three.js r184 | @forgeax/engine-geometry |
|:--|:--|:--|
| Return shape | mutable `BufferGeometry` instance | `Result<MeshAsset, AssetError>` (immutable POD) |
| Tangent population | `computeTangents()` (separate call) | `meshFromInterleaved` bakes tangent into the interleaved buffer |
| Index buffer | `Uint16Array` by default | `Uint32Array` when vertex count > 65535, `Uint16Array` otherwise |
| Error on degenerate | `console.warn` + best-effort | `Result.err(AssetError)` fail-fast |

## Non-goals

| Not doing | Why |
|:--|:--|
| Loading external mesh formats (glTF, FBX, OBJ) | glTF and FBX are owned by `@forgeax/engine-gltf` / `@forgeax/engine-fbx`; runtime consumption uses `@forgeax/engine-assets-runtime` after the source-plus-Meta sidecar pipeline |
| GPU upload / handle minting | Geometry is pure-function CPU POD; registration and GPU residency are `AssetRegistry` + `GpuResourceStore` in `@forgeax/engine-runtime` |
| Procedural mesh editing (extrude, bevel, CSG) | Out of scope for the leaf geometry package; these are future `@forgeax/engine-geometry-edit` or equivalent |
| Non-procedural mesh data (skinned vertices, morph targets) | Skin data lives on the `MeshAsset` POD after import; this package only populates position / normal / uv |
| `Result.unwrap()` convenience | Caller calls `.unwrap()` from `@forgeax/engine-ecs`; this package only produces `Result` |

## Route map

| Task | Package / skill |
|:--|:--|
| "I want a box / sphere / plane / cylinder / cone / torus from code" | `@forgeax/engine-geometry` (this package) |
| "I want to register the mesh and get a handle" | `@forgeax/engine-runtime` (`renderer.assets.register(meshAsset)`) |
| "I want to spawn an entity with this mesh" | `@forgeax/engine-runtime` (`MeshFilter` + `MeshRenderer` + `MaterialAsset`) -- see `forgeax-engine-material` skill |
| "I want to load a glTF file" | `@forgeax/engine-gltf` importer, then `@forgeax/engine-assets-runtime` (`loadByGuid`) |
| "I want to read the world-space position / forward / up from a spawned entity" | `@forgeax/engine-math` (`mat4.getTranslation` / `getForward` / `getUp`) |

## Knowledge-base references

Cross-vendor reading for contributors:

- [`../../.forgeax-harness/knowledge-base/wiki/typescript-branded-types.md`](../../.forgeax-harness/knowledge-base/wiki/typescript-branded-types.md) -- brand pattern SSOT
- [`../math/README.md`](../math/README.md) -- leaf-package README paradigm (progressive disclosure)
- [`../runtime/README.md`](../runtime/README.md) -- MeshFilter / MeshRenderer / AssetRegistry API
  SSOT
- [`../types/src/index.ts`](../types/src/index.ts) -- `MeshAsset` / `AssetError` / `VertexAttributeMap`
  type definitions

## License

Same as workspace root.
