# @forgeax/engine-geometry

Pure-function procedural mesh geometry factories + the vertex-attribute-layout SSOT for
forgeax-engine. A **leaf** package: depends only on `@forgeax/engine-ecs` (`Result`) +
`@forgeax/engine-types` (`MeshAsset` / `AssetError` / `VertexAttributeMap`), and never
imports the renderer, math, or RHI.

## 30-second self-introduction

- **Surface**: 7 Three.js-r184-aligned procedural factories
  (`createBoxGeometry` / `createCapsuleGeometry` / `createConeGeometry` /
  `createCylinderGeometry` / `createPlaneGeometry` / `createSphereGeometry` /
  `createTorusGeometry`),
  each returning `Result<MeshAsset, AssetError>`; the vertex-attribute-layout
  SSOT (`deriveVertexBufferLayout` / `buildMeshAttributeMapForUvSets` /
  `GpuVertexBufferLayoutEntry`); and the tangent + interleave helpers
  (`computeTangentVec4` / `meshFromInterleaved` /
  `PROCEDURAL_FLOATS_PER_VERTEX`). A single entry-point
  `import { ... } from '@forgeax/engine-geometry'`.
- **Style**: pure functions -- no classes, no mutation, no side effects. Every
  factory returns `Result<MeshAsset, AssetError>` (charter P3 explicit failure).
  Caller owns the returned `MeshAsset`; the package never touches GPU or ECS.
- **Errors**: degenerate parameters (`dim <= 0`, `segments < minimum`, etc.)
  fail-fast with `AssetError({ code: 'asset-parse-failed' })` carrying a
  human-readable `.detail` string. No silent fallback, no `console.warn`,
  no `null` return (charter P3).

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
glTF / FBX mesh, use `@forgeax/engine-assets` (`loadByGuid` / sidecar pipeline)
instead of this package.

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
Three.js-r184 key naming. The `VertexAttributeMap` is the 6-member closed set
`'position' | 'normal' | 'uv' | 'tangent' | 'skinIndex' | 'skinWeight'`; see
the [attribute layout](#vertex-attribute-layout-ssot) section.

### Tangent and interleave helpers

| Symbol | Kind | Purpose |
|:--|:--|:--|
| `computeTangentVec4(positions, normals, uvs, indices?)` | fn | Per-vertex tangent (vec4): face-area-weighted average + Gram-Schmidt orthogonalise + handedness sign packed into `.w` channel. Returns `Float32Array(vertexCount * 4)`. Compatible with MikkTSpace / glTF 2.0. |
| `meshFromInterleaved(vertices, indices)` | fn | Expands the 8-float interleaved buffer to the 12-float runtime layout by appending per-vertex tangent vec4. Returns `MeshAsset`. |
| `PROCEDURAL_FLOATS_PER_VERTEX` | const | `12` -- the runtime interleaved stride: position (3) + normal (3) + uv (2) + tangent (4). |

### Vertex attribute layout SSOT

| Symbol | Kind | Purpose |
|:--|:--|:--|
| `deriveVertexBufferLayout(map, opts?)` | fn | Derives a fixed-order `GpuVertexBufferLayoutEntry[]` from a `VertexAttributeMap`. The canonical 13-key order (position / normal / uv / tangent / skinIndex / skinWeight / uv1..uv7) assigns `@location(N)` per key. Absent keys reserve no space; `opts.shaderUvSetCount` enables clamp-to-last alias for UV sets. |
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
| Loading external mesh formats (glTF, FBX, OBJ) | That is `@forgeax/engine-assets` (`loadByGuid` + sidecar pipeline) |
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
| "I want to load a glTF file" | `@forgeax/engine-assets` (`loadByGuid`) |
| "I want to read the world-space position / forward / up from a spawned entity" | `@forgeax/engine-math` (`mat4.getTranslation` / `getForward` / `getUp`) |

## Knowledge-base references

Cross-vendor reading for contributors:

- `.forgeax-harness/knowledge-base/wiki/typescript-branded-types.md` -- brand pattern SSOT
- `packages/math/README.md` -- leaf-package README paradigm (progressive disclosure)
- `packages/runtime/README.md` -- MeshFilter / MeshRenderer / AssetRegistry API
  SSOT
- `packages/types/src/index.ts` -- `MeshAsset` / `AssetError` / `VertexAttributeMap`
  type definitions

## License

Same as workspace root.