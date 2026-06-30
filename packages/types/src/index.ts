// @forgeax/engine-types — POD types, union aliases, and cross-package primitives SSOT.
//
// Proposition: this package is the single source of truth for shared shapes that
// must NOT diverge across @forgeax/engine-rhi / ecs / naga / image / gltf / console /
// render-graph / shader / future renderer packages.
//
// Scope:
// - POD types & union aliases — Asset / MaterialAsset / RenderQueue / PassKind /
//   ShaderAsset / FontAsset / RenderPipelineAsset / SceneAsset /
//   PackErrorCode / ImageErrorCode / AudioErrorCode / PhysicsErrorCode etc.
// - Structured error classes — AssetError / FontError / TextError / AudioError /
//   PhysicsError (carry .code / .expected / .hint surface).
// - Project-wide Result<T, E> + ok / err factories (tweak-20260612-result-into-types
//   consolidated 5 byte-aligned-by-prose copies into this single module).
// - GPUFlagsConstant aliases for @webgpu/types numeric runtime constants — the
//   global objects (e.g. GPUBufferUsage.MAP_READ) are still consumed directly by
//   upstream callers; only the literal type aliases live here (decision S-6 /
//   research F-2 option (b)).
//
// Shape rules:
// - math-free (no vec / mat / quat dependency).
// - Single-source policy — fields already exported by @webgpu/types are re-exported
//   verbatim as one-line aliases; never duplicated here.
//
// Anchors: requirements §AC AC-01 + MVP-1.5; plan-strategy §2 S-6 + §7.6 propositions
//          4 / 5; research §F-2 (`GPUFlagsConstant = number` alias).

/// <reference types="@webgpu/types" />

// === Handle SSOT barrel re-export (feat-20260517-handle-type-unify M2 / D-2) ====
//
// `./handle` carries the unique double-axis Handle<T extends string, M> brand
// + AssetTagMap + TagOf + 3 factories (toUnique / toShared / unwrapHandle).
// The legacy 1-arg form that lived here at M1 has been physically deleted
// (M2 t10) so the package surface exposes a single Handle shape (charter F1
// single-entry indexability; AC-03 grep gate).

import type { Handle } from './handle';

export * from './handle';

// === Result<T, E> SSOT (tweak-20260612-result-into-types) ======================
//
// Single physical source of `Result<T, E>` + `ok(...)` / `err(...)`. Replaces
// the prior dual copies in packages/rhi/src/errors.ts + packages/ecs/src/result.ts
// (those copies were "byte-for-byte aligned" by prose, not by mechanism).
// AI users import the binary success/failure carrier via `@forgeax/engine-types`
// (or via the rhi/ecs package barrels which re-export this same module).
export * from './result';

// === Sub-asset POD SSOT (feat-20260615-fbx-importer-via-sdk M1 / t9) ===========
//
// Importer-independent pure-data IR types shared across glTF / FBX / future
// format importers. These are pre-kind, pre-guid data carriers — each importer
// writes these Pods from its format-specific JSON POD, and `to-asset-pack`
// promotes them to registry-ready Asset handles.
//
// Design axioms:
// - SSOT (architecture-principles #1): defined once in @forgeax/engine-types,
//   consumed via import by gltf / fbx / future importer packages.
// - Derive, don't duplicate (#2): gltf/fbx drop their local MeshIr/MeshRecord
//   and import MeshPod — no per-package copy.
// - No format prefix (plan-strategy section 8): Pod types are named after the
//   *asset kind* they represent, not the source format. AI users write code
//   that reads MeshPod regardless of whether the source was FBX or glTF.
// - Pre-kind data (charter P4): Pods carry raw geometric/material data without
//   `kind` discriminant fields. The importer bridge layer adds `kind` when
//   converting Pod -> Asset handle.
//
// Pod roster (AC-01..AC-07):
//   MeshPod          — vertices/indices/attributes/submeshes
//   MaterialPod      — PBR parameter values (baseColor/metallic/roughness)
//   ScenePod         — entity hierarchy + mount points
//   TexturePod       — external file path (cross-platform normalized)
//   SkeletonPod      — joint count + inverse bind matrices
//   SkinPod          — skeleton reference + joint paths
//   AnimationClipPod — duration + channels + samplers

// === AC-01: MeshPod — pure geometric data ===

/** Per-submesh descriptor within a MeshPod. */
export interface MeshSubmeshPod {
  /** Vertex count for this submesh (draw count when non-indexed). */
  readonly vertexCount: number;
  /** Index count when indexed; 0 for non-indexed geometry. */
  readonly indexCount: number;
  /** Byte offset into the shared indices buffer (0-based). */
  readonly indexOffset: number;
  /** Material binding index into the parent document's materials array. */
  readonly materialIndex: number | null;
  /** Primitive topology. */
  readonly topology: 'triangle-list' | 'line-list' | 'line-strip' | 'point-list';
}

/** MeshPod: pre-kind geometric data IR shared across importers. */
export interface MeshPod {
  /** Optional debug name from source document. */
  readonly name?: string;
  /** Packed vertex positions (Float32Array, 3 floats per vertex). */
  readonly vertices: Float32Array;
  /** Packed triangle indices (Uint16Array or Uint32Array). Absent when non-indexed. */
  readonly indices?: Uint16Array | Uint32Array;
  /** Per-vertex attributes keyed by semantic (POSITION/NORMAL/TEXCOORD_0/JOINTS_0/WEIGHTS_0). */
  readonly attributes: Record<string, Float32Array | Uint16Array | Uint32Array>;
  /** Per-submesh descriptors (>=1). */
  readonly submeshes: readonly MeshSubmeshPod[];
  /** Source mesh index within the original document (for diagnostic mapping). */
  readonly sourceIndex: number;
}

// === AC-02: MaterialPod — PBR parameter values ===

/** MaterialPod: pre-kind PBR material data IR shared across importers. */
export interface MaterialPod {
  /** Optional debug name from source document. */
  readonly name?: string;
  /** RGBA base color factor (linear space). */
  readonly baseColorFactor: readonly [number, number, number, number];
  /** Metallic factor (0..1). */
  readonly metallicFactor: number;
  /** Roughness factor (0..1). */
  readonly roughnessFactor: number;
  /** Index into the parent document's textures array for base color map. */
  readonly baseColorTextureIndex?: number;
  /** Index for metallic-roughness packed texture. */
  readonly metallicRoughnessTextureIndex?: number;
  /** Index for normal map. */
  readonly normalTextureIndex?: number;
  /** Index for occlusion map. */
  readonly occlusionTextureIndex?: number;
  /** Index for emissive map. */
  readonly emissiveTextureIndex?: number;
}

// === AC-03: ScenePod — entity hierarchy ===

/** A single entity node within a ScenePod hierarchy. */
export interface SceneEntityPod {
  /** Entity name (for Name component attachment). */
  readonly name: string;
  /** Decomposed local transform (TRS). */
  readonly transform: {
    readonly translation: readonly [number, number, number];
    readonly rotation: readonly [number, number, number, number];
    readonly scale: readonly [number, number, number];
  };
  /** Index into the parent document's meshes array. Null when not a mesh node. */
  readonly meshIndex: number | null;
  /** Children entity indices in the flattened entities array. */
  readonly children: readonly number[];
}

/** ScenePod: entity hierarchy IR shared across importers. */
export interface ScenePod {
  /** Optional scene name. */
  readonly name?: string;
  /** Flattened entity list (topological order, parents before children). */
  readonly entities: readonly SceneEntityPod[];
  /** Index of the default/root scene entity. */
  readonly rootEntityIndex: number;
}

// === AC-04: TexturePod — external file path ===

/** TexturePod: external texture reference IR shared across importers. */
export interface TexturePod {
  /** Optional texture name. */
  readonly name?: string;
  /** Filesystem path relative to the source document, with '/' separators. */
  readonly filePath: string;
  /** Source texture index within the original document. */
  readonly sourceIndex: number;
}

// === AC-05: SkeletonPod — joint hierarchy ===

/** SkeletonPod: skeleton joint data IR shared across importers. */
export interface SkeletonPod {
  /** Number of joints. */
  readonly jointCount: number;
  /** Inverse bind matrices, Float32Array of length jointCount * 16. */
  readonly inverseBindMatrices: Float32Array;
  /** Per-joint name path from scene root (parallel to joints array). */
  readonly jointPaths: readonly string[];
}

// === AC-06: SkinPod — vertex skinning data ===

/** Per-vertex joint influence descriptor. */
export interface SkinVertexInfluencePod {
  /** 4 joint indices (Uint16Array), always padded to 4 entries. */
  readonly jointIndices: Uint16Array;
  /** 4 joint weights (Float32Array), always padded to 4 entries. */
  readonly jointWeights: Float32Array;
}

/** SkinPod: vertex skinning data IR shared across importers. */
export interface SkinPod {
  /** GUID-like identifier for the associated SkeletonAsset (resolved at bridge time). */
  readonly skeletonGuid: string;
  /** Joint name paths (same as SkeletonPod.jointPaths for cross-reference). */
  readonly jointPaths: readonly string[];
  /** Number of influenced vertices. */
  readonly vertexCount: number;
  /** Per-vertex joint influences (4 joints per vertex). */
  readonly influences: readonly SkinVertexInfluencePod[];
}

// === AC-07: AnimationClipPod — keyframe animation ===

/** Animation sampler (keyframe data for one property). */
export interface AnimationSamplerPod {
  /** Keyframe timestamps (ascending, seconds). */
  readonly input: Float32Array;
  /** Keyframe values (packed per-element stride). */
  readonly output: Float32Array;
  /** Interpolation mode. */
  readonly interpolation: 'LINEAR' | 'STEP';
}

/** Animation channel (one joint-property pair). */
export interface AnimationChannelPod {
  /** Name path from scene root to target joint. */
  readonly targetPath: readonly string[];
  /** Target property: 'translation' | 'rotation' | 'scale'. */
  readonly property: 'translation' | 'rotation' | 'scale';
  /** Sampler driving this channel. */
  readonly sampler: AnimationSamplerPod;
}

/** AnimationClipPod: keyframe animation clip IR shared across importers. */
export interface AnimationClipPod {
  /** Optional clip name. */
  readonly name?: string;
  /** Clip duration in seconds (max sampler.input[last]). */
  readonly duration: number;
  /** Per-joint-property channels. */
  readonly channels: readonly AnimationChannelPod[];
}

// === Asset system v1 SSOT (feat-20260511-asset-system-v1) ======================
//
// Decision anchors:
// - requirements §G7 + §2 row 8 + AC-09 / AC-15 / AC-21 (4-variant Asset
//   discriminated union, 6-lowercase-key VertexAttributeMap closed set,
//   AssetErrorCode 4-member closed union elevated to TS alias)
// - plan-strategy §2 D-P1 (@forgeax/engine-types single-file SSOT for
//   Asset union + AssetErrorCode; 4-member AssetErrorCode independent from
//   RhiErrorCode, AI users discover through one-line import)
// - plan-strategy §7.2 (lowercase key alignment with Three.js r184
//   BufferGeometry mental migration; D-P5 preserves segments 6 params)
// - plan-strategy §7.3 (AssetError .hint strings per error code, verbatim)
// - charter proposition 1 (single-entry IDE autocomplete via
//   `@forgeax/engine-types`) + proposition 3 (machine-readable union >
//   prose) + proposition 4 (explicit failure - exhaustive switch needs no
//   default fallback) + proposition 5 (consistent abstraction - structurally
//   parallel to RhiError / InspectorError / MetricError 4-field surface)
// - architecture-principles #1 SSOT (4 literals + shape live here once;
//   @forgeax/engine-runtime AssetRegistry / tests / AGENTS.md Error model
//   table all reference this module)

/**
 * Mesh asset POD shape aligned with Three.js r184 BufferGeometry mental
 * model (plan-strategy §7.2 naming convention). `vertices` is the interleaved
 * or primary position buffer; `indices` narrows to `Uint16Array | Uint32Array`
 * per WebGPU spec index format; `attributes` is the VertexAttributeMap
 * lowercase-key closed set.
 *
 * 6-key lowercase closed set (G7 / AC-15):
 * `'position' | 'normal' | 'uv' | 'tangent' | 'skinIndex' | 'skinWeight'`.
 *
 * Designed for M3 GLTF loader single-layer mapping
 * (`POSITION -> position` / `TEXCOORD_0 -> uv` etc.) without runtime rename.
 */
export interface MeshAsset {
  readonly kind: 'mesh';
  readonly vertices: Float32Array;
  /**
   * Index buffer. Optional: vertex-only meshes (point-list / line-list with no
   * shared vertices) omit it, and the engine takes a non-indexed draw path
   * (`pass.draw(vertexCount)` instead of `pass.drawIndexed`). When present the
   * indexed path is byte-for-byte unchanged.
   */
  readonly indices?: Uint16Array | Uint32Array;
  readonly attributes: VertexAttributeMap;
  /**
   * Axis-aligned bounding box in local space: 6 floats [minX, minY, minZ, maxX, maxY, maxZ].
   *
   * Computed by AssetRegistry.register / registerWithGuid from the position attribute
   * after mesh validation passes. When no position attribute or empty vertices, the
   * AABB is an inverted-infinity empty box (the consumer interprets this as
   * always-visible -- no culling). The bare Float32Array keeps engine-types math-free
   * (no Box3 branded type dependency). Consumers narrow to the math-layer Box3 via
   * `as Box3Like` (plan-strategy D-1).
   */
  readonly aabb?: Float32Array;
  /**
   * Submeshes partition the index/vertex range into independent draw calls,
   * each with its own topology (one of the 5 WebGPU primitives:
   * 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip').
   *
   * Every mesh must declare at least one submesh. The engine draws one
   * `drawIndexed` (or `draw` for vertex-only) per submesh entry, and pairs
   * them with `MeshRenderer.materials[]` by index position.
   *
   * Must be non-empty: an empty array triggers a `mesh-asset-submeshes-empty`
   * AssetError at register-time (fail-fast, charter P3 explicit failure).
   */
  readonly submeshes: readonly Submesh[];
}

/**
 * Submesh partitions a mesh's index/vertex range into an independent draw
 * call with its own primitive topology.
 *
 * Every field is required -- there is no default topology; the caller
 * must state the intended primitive type explicitly (charter P3 explicit
 * failure: silent default would mask topology mistakes).
 *
 * Naming aligns with Unity `SubMeshDescriptor` (without firstVertex /
 * baseVertex / bounds which are out of scope per OOS-3/OOS-4).
 *
 * | field | description |
 * |:--|:--|
 * | `indexOffset` | Start offset into the parent mesh's index buffer (in elements, not bytes). For vertex-only (non-indexed) submeshes, set to 0. |
 * | `indexCount`  | Number of indices consumed from the index buffer starting at `indexOffset`. For vertex-only submeshes, set to 0. |
 * | `vertexCount` | Number of vertices spanned by this submesh range (used for the non-indexed draw path and for index-range OOB validation). |
 * | `topology`    | GPU primitive topology for this submesh (one of the 5 WebGPU primitives: 'point-list' \| 'line-list' \| 'line-strip' \| 'triangle-list' \| 'triangle-strip'). |
 */
export interface Submesh {
  readonly indexOffset: number;
  readonly indexCount: number;
  readonly vertexCount: number;
  readonly topology: PrimitiveTopology;
}

/**
 * Texture asset POD shape aligned with `@webgpu/types ^0.1.69`
 * `GPUTextureDescriptor` subset (plan-strategy D-P1; RHI form rule
 * "spec-aligned"). Carries the decoded pixel bytes ready for
 * `GPUQueue.writeTexture` / `copyExternalImageToTexture` upload.
 *
 * `format` is the `GPUTextureFormat` string-literal union; `data` holds the
 * CPU-side decoded pixels (tight-packed, srgb-premultiplied-alpha-false per
 * D-P9). Optional `mipLevelCount` / `sampleCount` default to 1 at upload
 * time; v1 registers only 2D textures (depth / 3D / cube array are future
 * spinoffs).
 *
 * feat-20260515-learn-render-getting-started M3 / T-M3-03 minor-add (Asset
 * closed-union member count unchanged at 5; plan-strategy section 2.5 D Open
 * Q-4 selection (c)):
 *   - `colorSpace: 'srgb' | 'linear'` -- AI-user-semantic SSOT (charter P4
 *     consistent abstraction); `format='*-srgb'` family <-> `colorSpace='srgb'`
 *     enforced by `AssetRegistry.uploadTexture` consistency assertion.
 *   - `mipmap: boolean` -- `true` enables runtime mipmap-generator blit chain
 *     (research F-1 SSOT three-source convergence; plan-strategy section 2.6
 *     D Open Q-5 (a) independent file). `false` ships the single mip level
 *     authored in `data`.
 *
 * Both fields are required (no default value) so consumers always make the
 * decision explicit at register-time (charter P3 explicit failure: silent
 * default would mask sRGB encode mistakes).
 */
export interface TextureAsset {
  readonly kind: 'texture';
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly colorSpace: 'srgb' | 'linear';
  readonly mipmap: boolean;
  readonly mipLevelCount?: number;
  readonly sampleCount?: number;
}

/**
 * Cube texture asset POD shape -- 6-face cubemap (feat-20260520-skylight-ibl-cubemap M1).
 *
 * Plan-strategy D-9: 'cube-texture' arm follows directly after the existing
 * 'texture' arm so AI users encounter the two GPU-uploadable asset kinds
 * adjacent in the discriminated union (charter F1 indexability).
 *
 * `faces` is a readonly array of raw per-face pixel data buffers, one per
 * cubemap face in +X / -X / +Y / -Y / +Z / -Z order (WebGPU convention).
 * `width === height` per cubemap spec (square faces). `format` mirrors
 * `TextureAsset.format` (GPUTextureFormat).
 *
 * Cardinality contract (F-8): exactly two valid shapes, enforced by the
 * AssetRegistry register / upload paths (charter P3 explicit failure):
 *   - `faces.length === 6`: 6-PNG cubemap (vendor path, e.g. learn-opengl
 *     skybox); pixel data is the CPU SSOT and `AssetRegistry.uploadCubemap`
 *     blits each face into the GPU cubemap texture.
 *   - `faces.length === 0`: GPU-side cubemap (equirect-to-cube IBL precompute
 *     path); pixel data lives only on the GPU and is accessed via
 *     `AssetRegistry.getCubemapGpuView` / `getCubemapFaceViews`. The CPU
 *     `faces` slot stays empty because reading back 6 Uint8Arrays per cubemap
 *     would cost ~12 MB per 512px float16 cubemap with no consumer (charter F1
 *     minimal surface).
 *
 * Any other length is invalid and rejected at register time.
 *
 * Unlike TextureAsset, CubeTextureAsset carries no `colorSpace` /
 * `mipmap` / `mipLevelCount` / `sampleCount` fields; cubemap IBL upload is
 * a separate runtime path (plan-strategy D-2 independent upload path).
 */
export interface CubeTextureAsset {
  readonly kind: 'cube-texture';
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  /** Either 0 (GPU-only, IBL precompute path) or 6 (CPU SSOT, vendor PNG path). */
  readonly faces: readonly Uint8Array[];
}

/**
 * Sampler asset POD shape aligned with `@webgpu/types ^0.1.69`
 * `GPUSamplerDescriptor` subset. AI users supply filter + address modes;
 * the RHI layer materialises the GPU-side sampler on upload.
 */
export interface SamplerAsset {
  readonly kind: 'sampler';
  readonly magFilter?: GPUFilterMode;
  readonly minFilter?: GPUFilterMode;
  readonly mipmapFilter?: GPUMipmapFilterMode;
  readonly addressModeU?: GPUAddressMode;
  readonly addressModeV?: GPUAddressMode;
  readonly addressModeW?: GPUAddressMode;
  readonly lodMinClamp?: number;
  readonly lodMaxClamp?: number;
  readonly compare?: GPUCompareFunction;
}

// === MaterialAsset pass-based interface (feat-20260526-material-asset-multipass-renderstate M1 / w7) ===
//
// Decision anchors:
//   - requirements AC-01 (no shadingModel field; single interface replaces
//     the old Unlit/SchemaDriven/Sprite 3-variant discriminated union)
//   - requirements scope #1 (deprecate shadingModel tri-variant, unify to
//     pass-based declaration model)
//   - plan-strategy D-1 (drop shadingModel discriminator; MaterialAsset
//     becomes single interface with passes[] + parent? + paramValues)
//   - plan-strategy D-8 (parent handle enables lazy-resolve inheritance)
//   - AGENTS.md §Change stance "Optimal > compatible" (one-cut migration,
//     no deprecation window / shim / dual-path)
//   - charter P4 (consistent abstraction — single interface replaces
//     three switch arms; AI users write one shape for all material kinds)

/**
 * Material asset — unified pass-based interface (AC-01, AC-02).
 *
 * Replaces the old `shadingModel` tri-variant discriminated union
 * (`'unlit' | 'schema-driven' | 'sprite'`) with a single interface.
 * All material kinds (unlit, PBR, sprite, custom) are expressed through
 * the same shape — the `passes[]` array + `paramValues` record carries
 * the rendering behaviour (charter P4 consistent abstraction).
 *
 * | Field | Required | Default | Purpose |
 * |:--|:--|:--|:--|
 * | `kind` | yes | — | Asset discriminator (`'material'`) |
 * | `passes` | no | `[]` | Array of {@link MaterialPassDescriptor} — rendering passes for this material |
 * | `parent` | no | — | Handle to a parent material for inheritance (lazy resolve, D-8) |
 * | `paramValues` | no | `{}` | Material parameter values — passed through to material uniform binding |
 *
 * When `passes` is omitted, the material inherits the parent's passes list
 * (AC-06). When `passes` is provided, same-`name` passes override the
 * parent's, and new names are appended. `paramValues` is shallow-merged
 * with the parent's (child overrides parent keys).
 *
 * AI-user surface: register via `assetRegistry.register<MaterialAsset>(asset)`
 * → returns `Handle<'MaterialAsset', 'shared'>`.
 */
export interface MaterialAsset {
  readonly kind: 'material';
  /** Array of pass descriptors for this material. Omit to inherit from parent. */
  readonly passes?: readonly MaterialPassDescriptor[];
  /**
   * Parent material GUID for lazy-resolve inheritance (D-8 / D-19). Payload-
   * internal sub-asset refs are GUID identities, not column handles: the
   * AssetRegistry holds no World and cannot mint a handle during the loadByGuid
   * recursion, so it stores the parent's AssetGuid verbatim. The World-holding
   * consumer (render extract / material-walk) resolves the GUID to a handle via
   * loadByGuid -> world.allocSharedRef once at read time.
   */
  readonly parent?: AssetGuid;
  /**
   * Material parameter values — passed through to material uniform binding.
   * Shallow-merged with parent on resolve. Texture-typed entries (detected via
   * the shader paramSchema textureFieldNames) carry an AssetGuid (D-19), not a
   * handle; the consumer resolves them the same way as `parent`.
   */
  readonly paramValues?: Readonly<Record<string, unknown>>;
}

// feat-20260613 fix-issue-4: MATERIAL_PARAM_TYPES_V1 (9-Set) deleted —
// MATERIAL_PARAM_TYPES (14-tuple, declared below) is the single SSOT.
// §Change stance forbids v1/v2 dual-paths; the 9 v1 literals are a strict
// subset of the 14-tuple, so all consumers (buildMaterialAssetValidator,
// scanner.ts, registerMaterialShader) migrate to the 14-tuple in one cut.

// === MaterialParamType v2 (feat-20260613-material-paramschema-driven-binding M1 / w2) ===
//
// Decision anchors:
//   - plan-strategy D-7  paramSchema type set v2 (9 v1 + 5 new = 14 literals)
//   - research finding F-1  the union of all binding types used by the 5 built-in
//     shaders (standard-pbr / pbr-skin / unlit / sprite / shadow-caster) is exactly
//     these 14 entries; CSM (texture_depth_2d) / point shadow (texture_cube_array) /
//     IBL (texture_cube) / sampler_comparison / storage_buffer (skin palette) all
//     already exist downstream
//   - charter P3 explicit failure: closed unions guard exhaustive switching with
//     no default arm; TS verifies completeness
//
// Shape:
//   - `MATERIAL_PARAM_TYPES`  : 14-element readonly tuple, the SSOT whitelist
//   - `MaterialParamType`     : string-literal union derived from the tuple
//   - `NumericParamType`      : 7 numeric literals (run-merged into one UBO entry)
//   - `TextureBindingParamType`: 6 literals — texture* + sampler*
//     (per D-4 each texture* auto-pairs a filtering sampler in derive output;
//      sampler / sampler_comparison are user-declared schema entries)
//   - `StorageBindingParamType`: storage_buffer (independent binding)
//   - `ParamSchemaEntry`       : discriminated union over the three families
//     (Numeric / TextureBinding / StorageBinding) — exhaustive switching
//     on `entry.type` is closed across the 14 literals.

/** 7 numeric WGSL types — std140-packed into one merged UBO entry (D-3). */
export type NumericParamType = 'f32' | 'i32' | 'u32' | 'vec2' | 'vec3' | 'vec4' | 'color';

/** 6 texture-binding-family WGSL types: 4 texture views + 2 sampler kinds. */
export type TextureBindingParamType =
  | 'texture2d'
  | 'texture_cube'
  | 'texture_depth_2d'
  | 'texture_cube_array'
  | 'sampler'
  | 'sampler_comparison';

/** 1 storage-binding type (e.g. skin palette buffer). */
export type StorageBindingParamType = 'storage_buffer';

/**
 * Closed union of WGSL material-parameter type literals (14 members).
 * Every paramSchema entry's `type` field MUST be a member of this union.
 */
export type MaterialParamType =
  | NumericParamType
  | TextureBindingParamType
  | StorageBindingParamType;

/**
 * v2 material parameter type whitelist — 14 ordered literal tuple (D-7).
 * Order is significant only as a stable enumeration source for tests
 * and discoverability; consumers should treat membership as a Set.
 */
export const MATERIAL_PARAM_TYPES = [
  'f32',
  'i32',
  'u32',
  'vec2',
  'vec3',
  'vec4',
  'color',
  'texture2d',
  'texture_cube',
  'texture_depth_2d',
  'texture_cube_array',
  'sampler',
  'sampler_comparison',
  'storage_buffer',
] as const satisfies readonly MaterialParamType[];

// Numeric-family schema entry (run-merged into a single UBO entry by derive).
// `default` is optional; when present, paramValues may omit the key.
//   - scalar numeric (f32 / i32 / u32) defaults to a single number
//   - vector + color types default to a length-N number tuple
export interface NumericParamSchemaEntry {
  readonly name: string;
  readonly type: NumericParamType;
  readonly default?: number | readonly number[];
}

// Texture-binding-family schema entry (texture* / sampler*).
// `default` is kept optional for backward compatibility with existing
// schema fixtures that carry stray defaults; derive ignores it for the
// non-numeric families (D-4 auto-pair rule resolves samplers; textures
// resolve via Handle<TextureAsset>).
export interface TextureBindingParamSchemaEntry {
  readonly name: string;
  readonly type: TextureBindingParamType;
  readonly default?: unknown;
}

// Storage-binding-family schema entry (storage_buffer).
// Always an independent binding (not merged into the UBO run); `default`
// is optional and ignored by derive (backward compatibility shim).
export interface StorageBindingParamSchemaEntry {
  readonly name: string;
  readonly type: StorageBindingParamType;
  readonly default?: unknown;
}

// Re-export derive(schema) and its output shapes alongside the schema
// type union so all downstream consumers (runtime / vite-plugin-shader /
// shader-compiler) reach the SSOT through a single import surface (D-2).
export type { DeriveOutput, UboFieldLayout, UboLayout } from './derive-paramschema.js';
export { derive, findUndeclaredSampledTextures } from './derive-paramschema.js';

/**
 * Single material parameter schema entry — discriminated union over the
 * three families (Numeric / TextureBinding / StorageBinding).
 *
 * `name` is the parameter identifier matching a WGSL binding name.
 * `type` is the discriminator — exhaustive `switch (entry.type)` covers the
 * 14 literals without a `default` arm; TS guards completeness (charter P3).
 */
export type ParamSchemaEntry =
  | NumericParamSchemaEntry
  | TextureBindingParamSchemaEntry
  | StorageBindingParamSchemaEntry;

// === RenderQueue namespace constants (feat-20260526-material-asset-multipass-renderstate M1 / w3) ===
//
// Decision anchors:
//   - requirements AC-04 (5 standard queue values: Background=1000 / Geometry=2000 /
//     AlphaTest=2450 / Transparent=3000 / Overlay=4000)
//   - plan-strategy D-3 (queue values replace three-bucket dispatch)
//   - research F-5 (Utopia queue model; Transparent=3000 gives gap between
//     AlphaTest=2450 and Transparent=3000 for user custom queues)
//   - charter P1 (progressive disclosure: RenderQueue.Geometry autocomplete
//     exposes the value; AI users never need to memorize bare numbers)

/**
 * Standard render queue constants (AC-04). AI users access via IDE autocomplete
 * (`RenderQueue.`) — no bare numbers to memorize (charter P1 progressive disclosure).
 *
 * Queue order (ascending):
 *   Background(1000) -> Geometry(2000) -> AlphaTest(2450) -> Transparent(3000) -> Overlay(4000)
 *
 * The gap between AlphaTest(2450) and Transparent(3000) allows user-inserted
 * custom queues without colliding with either boundary (research F-5).
 */
export const RenderQueue = {
  /** Skybox / backdrop draw, processed first. */
  Background: 1000,
  /** Opaque geometry draw — default queue for solid surfaces. */
  Geometry: 2000,
  /** Alpha-tested geometry (clip/discard in fragment shader) — drawn after opaque,
   *  before transparent to avoid overdraw. */
  AlphaTest: 2450,
  /** Transparent / alpha-blended geometry — drawn back-to-front after opaque pass. */
  Transparent: 3000,
  /** Overlay / UI / debug lines — drawn last. */
  Overlay: 4000,
} as const;

/** Type alias for the 5-member RenderQueue value union (1000 | 2000 | 2450 | 3000 | 4000). */
export type RenderQueue = (typeof RenderQueue)[keyof typeof RenderQueue];

// === MaterialRenderState POD interface (feat-20260526-material-asset-multipass-renderstate M1 / w1) ===
//
// Decision anchors:
//   - requirements AC-03 (all fields optional; engine applies known defaults)
//   - plan-strategy D-2 (MaterialRenderState fields optional + engine static defaults)
//   - research F-3 (current hardcoded values become the defaults)
//   - research F-6 (Three.js taxonomy proves this subset is sufficient for LO 4.x)
//   - charter P1 (all fields optional reduces boilerplate; JSDoc on each field exposes
//     the default so AI users discover via IDE hover without reading prose)

/**
 * Stencil face state sub-interface — mirrors `@webgpu/types.GPUStencilFaceState`
 * field-by-field (spec-aligned per RHI form rules). All fields optional so
 * consumers declare only the stencil behavior they need.
 */
export interface StencilFaceState {
  /** Default: `'never'`. */
  readonly compare?: GPUCompareFunction;
  /** Default: `'keep'`. */
  readonly failOp?: GPUStencilOperation;
  /** Default: `'keep'`. */
  readonly depthFailOp?: GPUStencilOperation;
  /** Default: `'keep'`. */
  readonly passOp?: GPUStencilOperation;
}

/**
 * Material render-state POD interface — all fields optional (AC-03).
 *
 * When a field is `undefined`, the pipeline-builder falls back to the
 * engine default value noted in each field's JSDoc. AI users only override
 * the fields that differ from the defaults (charter P1 progressive disclosure).
 *
 * The defaults are:
 *   - `cullMode='back'` (back-face culling per WebGPU convention)
 *   - `depthCompare='less'` (standard depth testing)
 *   - `depthWriteEnabled=true` (write depth for opaque surfaces)
 *   - `blend` undefined (no blending — opaque pass)
 *   - `stencil` undefined (no stencil operations)
 *   - `stencilReadMask` undefined (WebGPU default 0xFFFFFFFF)
 *   - `stencilWriteMask` undefined (WebGPU default 0xFFFFFFFF)
 *   - `frontFace` undefined (default 'ccw')
 */
export interface MaterialRenderState {
  /** Face culling mode. Default: `'back'` (cull back faces). */
  readonly cullMode?: 'none' | 'front' | 'back';
  /** Depth comparison function. Default: `'less'`. */
  readonly depthCompare?: GPUCompareFunction;
  /** Whether depth writes are enabled. Default: `true`. */
  readonly depthWriteEnabled?: boolean;
  /** Blend state descriptor (spec-aligned with `GPUBlendState`). Default: undefined (no blending). */
  readonly blend?: GPUBlendState;
  /** Stencil face state. Default: undefined (no stencil operations). */
  readonly stencil?: StencilFaceState;
  /**
   * Stencil read mask (mirrors GPUDepthStencilState.stencilReadMask top-level).
   * Default: undefined (WebGPU default 0xFFFFFFFF).
   */
  readonly stencilReadMask?: number;
  /**
   * Stencil write mask (mirrors GPUDepthStencilState.stencilWriteMask top-level).
   * Default: undefined (WebGPU default 0xFFFFFFFF).
   */
  readonly stencilWriteMask?: number;
  /**
   * Front-face winding (mirrors GPUPrimitiveState.frontFace).
   * Default: `'ccw'`.
   */
  readonly frontFace?: 'ccw' | 'cw';
}

// === MaterialPassDescriptor POD interface (feat-20260526-material-asset-multipass-renderstate M1 / w2) ===
//
// Decision anchors:
//   - requirements AC-02 (9 fields: name / shader / vertexEntry / fragmentEntry /
//     defines / tags / renderState / queue / stencilReference)
//   - plan-strategy D-7 (entry point selection lives in pass descriptor, not shader registry)
//   - plan-strategy D-4 (tags are free Record<string, string>)
//   - research F-9 (MaterialShaderEntry stays unchanged; pass descriptor carries
//     entry point + defines + renderState)
//   - charter P1 (only name + shader are required; remaining 6 fields optional with
//     sensible defaults — AI users add only what they need)

/**
 * Single pass descriptor inside a {@link MaterialAsset}'s `passes[]` array (AC-02).
 *
 * Only `name` and `shader` are required — the remaining 7 fields are optional
 * and fall back to engine defaults when omitted (charter P1 progressive disclosure).
 *
 * | Field | Required | Default | Purpose |
 * |:--|:--|:--|:--|
 * | `name` | yes | — | Pass identifier for by-name inheritance override (AC-06) |
 * | `shader` | yes | — | Shader registry entry id (e.g. `'forgeax::default-standard-pbr'`) |
 * | `vertexEntry` | no | `'vs_main'` | Vertex shader entry-point function name |
 * | `fragmentEntry` | no | `'fs_main'` | Fragment shader entry-point function name |
 * | `defines` | no | `{}` | Per-pass preprocessor defines injected before shader compile |
 * | `tags` | no | `{}` | Free key-value tags used by {@link PassSelector} for pass routing |
 * | `renderState` | no | engine defaults | Per-pass GPU pipeline render state overrides |
 * | `queue` | no | `RenderQueue.Geometry` | Sort key for the single dispatch list |
 * | `passKind` | no | `'forward'` | {@link PassKind} tag for HDRP execute-stage routing |
 */
export interface MaterialPassDescriptor {
  /** Pass identifier — used for by-name inheritance override (AC-06). */
  readonly name: string;
  /** Shader registry entry id (e.g. `'forgeax::default-standard-pbr'`). */
  readonly shader: string;
  /** Vertex shader entry-point function name. Default: `'vs_main'`. */
  readonly vertexEntry?: string;
  /** Fragment shader entry-point function name. Default: `'fs_main'`. */
  readonly fragmentEntry?: string;
  /** Per-pass preprocessor defines — each key becomes `#define KEY VALUE` before shader compile. Default: `{}`. */
  readonly defines?: Record<string, string>;
  /** Free key-value tags for pass routing via {@link PassSelector}. Default: `{}`. */
  readonly tags?: Record<string, string>;
  /**
   * Per-pass GPU pipeline render state overrides. Default: engine defaults (D-2).
   *
   * The presence of `renderState.blend` is the SSOT for transparent routing:
   * the runtime derives `MaterialSnapshot.transparent` from
   * `passes[0].renderState?.blend !== undefined`, drives the LDR-split
   * sub-pass + premultiplied-alpha composite + back-to-front sort, and
   * folds the geometry into the transparent bucket. AI users opt into
   * transparency by assigning a {@link MaterialBlendState} on `blend`
   * (recommended preset: `SPRITE_PREMULTIPLIED_ALPHA_BLEND` from
   * `@forgeax/engine-runtime` for sprite atlases / PNGs with
   * premultiplied alpha) — no separate boolean flag exists; omit `blend`
   * for opaque.
   */
  readonly renderState?: MaterialRenderState;
  /** Sort key for the single dispatch list. Default: {@link RenderQueue.Geometry} (2000). */
  readonly queue?: number;
  /**
   * Stencil reference value for draw-call dynamic state (set via
   * RHI `setStencilReference` per draw). Default: `0`.
   */
  readonly stencilReference?: number;
  /**
   * Render-pass kind tag for HDRP multi-stage dispatch routing.
   *
   * Defaults to `'forward'` when omitted (backward-compatible with single-pass
   * materials). HDRP execute filters ShaderPass entries by this tag:
   * opaque material routes `passKind='deferred'` to g-buffer,
   * transparent material routes `passKind='forward'` to cluster-forward.
   *
   * @see {@link PassKind} for the 4-value closed union.
   */
  readonly passKind?: PassKind;
}

// === PassKind as open string + KNOWN_PASS_KINDS (feat-20260615-pipeline-spec-ssot D-10) ===
//
// Decision anchors:
//   - plan-strategy D-10 (PassKind opened from closed union to string; KNOWN_PASS_KINDS
//     is a discoverable documentation constant)
//   - requirements AC-09 (PassKind: open string; unknown passKind -> PipelineSpecError
//     code='unknown-pass-kind')
//   - charter P3 (fail-fast on unknown passKind via PipelineSpecError, not silent route)

/**
 * Render-pass kind -- open string, no longer a closed union.
 *
 * `KNOWN_PASS_KINDS` (below) documents the engine-shipped pass kinds; user-defined
 * pass kinds are supported through {@link ShaderRegistry} registration. An unknown
 * pass kind triggers {@link PipelineSpecError} with code `'unknown-pass-kind'`
 * at pipeline-spec build time (charter P3 explicit failure).
 *
 * @see {@link KNOWN_PASS_KINDS} for the discoverable pass-kind catalogue
 * @see plan-strategy D-10 (PassKind opened from closed union)
 */
export type PassKind = string;

/**
 * Engine-shipped pass kinds -- discoverable constant catalogue (D-10).
 *
 * Consumers iterate or lookup against this set to validate pass kinds before
 * submitting to `getOrBuildPipeline`. An unknown pass kind still triggers a
 * structured `PipelineSpecError` with code `'unknown-pass-kind'` carrying
 * `.detail.expected = KNOWN_PASS_KINDS` and `.detail.actual`.
 */
export const KNOWN_PASS_KINDS: readonly string[] = [
  'forward',
  'deferred',
  'lighting',
  'shadow-caster',
  'post-process',
  'skybox',
] as const;

// === PassSelector type (feat-20260526-material-asset-multipass-renderstate M1 / w4) ===
//
// Decision anchors:
//   - requirements AC-05 (tags + PassSelector matching: all selector keys must
//     exist in pass tags with value in the selector's value list)
//   - plan-strategy D-4 (Tags free Record + PassSelector Record<string, string[]>;
//     enum-based categories rejected — adding a pipeline stage should not require
//     editing the types package)
//   - charter P1 (type signature itself is the match-rule documentation;
//     `Record<string, string[]>` is self-describing)

/**
 * Pass selector — maps tag keys to allowed value lists (AC-05).
 *
 * A pass matches the selector when **every** key in the selector exists in the
 * pass's `tags` and the pass's tag value is in the selector's value list for that key.
 * An empty selector matches every pass (no key constraints).
 *
 * The type signature itself is the API docs (charter P1): each entry maps a
 * tag key (string) to its allowed values (string array).
 *
 * @example Match passes tagged with `RenderType: 'Opaque'` or `RenderType: 'Transparent'`
 * ```ts
 * const selector: PassSelector = { RenderType: ['Opaque', 'Transparent'] };
 * ```
 */
export type PassSelector = Record<string, readonly string[]>;

// === ShaderAsset POD shape (feat-20260528-material-shader-registration-unification M1 / w1) ===
//
// Decision anchors:
//   - requirements AC-01 (ShaderAsset type definition as first-class Asset union member)
//   - plan-strategy D-1 (ShaderAsset with kind: 'shader', joining Asset union)
//   - research Finding 3 (current Asset union has 10 kinds, missing shader)
//   - charter P4 (consistent abstraction: ShaderAsset follows existing *Asset suffix convention)

/**
 * Shader asset POD shape -- material-shader registration SSOT in AssetRegistry.
 *
 * Each material-shader variant owns one ShaderAsset, registered in the
 * AssetRegistry alongside the ShaderRegistry MaterialShaderEntry. The GUID
 * is the primary identity key; `name` is the human-readable identifier
 * (e.g. 'forgeax::default-standard-pbr') that maps to the shader registry
 * entry for material-pass shader selection.
 *
 * | Field | Purpose |
 * |:--|:--|
 * | `kind` | Asset discriminator (`'shader'`) |
 * | `name` | Human-readable shader identifier matching ShaderRegistry name |
 * | `source` | Full composed WGSL source after naga_oil preprocessing |
 * | `paramSchema` | Material parameter schema (ParamSchemaEntry[]), the SSOT for material-shader param validation AND BGL derivation (M3 / D-1 / D-2 — `derive(paramSchema).bglEntries` is the binding-slot layout source) |
 *
 * When registered via `AssetRegistry.register<ShaderAsset>(asset)`, returns
 * `Handle<'ShaderAsset', 'shared'>`. AI users retrieve via
 * `assets.getByGuid<ShaderAsset>(guid)` for runtime shader introspection.
 *
 * @example AI-user consumption path
 * ```ts
 * const shaderAsset = await assets.getByGuid<ShaderAsset>(pbrGuid);
 * for (const param of shaderAsset.paramSchema) {
 *   console.log(param.name, param.type);
 * }
 * ```
 */
export interface ShaderAsset {
  readonly kind: 'shader';
  readonly name: string;
  readonly source: string;
  readonly paramSchema: readonly ParamSchemaEntry[];
}

// === FontAsset POD shape (feat-20260531-world-space-msdf-text-rendering M2 / w5) ===
//
// Decision anchors:
//   - plan-strategy D-6 (FontAsset data shape: atlas Handle<TextureAsset> +
//     sampler Handle<SamplerAsset> + glyphs Record<codepoint, GlyphMetric> +
//     common block + optional notdef fallback; POD, math-free, fields 1:1
//     mirror toolchain wiki §4 BMFont char mapping)
//   - requirements AC-04 (FontAsset enters Asset closed union, 11->12)
//   - AGENTS.md §Component naming (single-semantic components drop the
//     Component suffix; FontAsset is a data asset, not an ECS component)
//
// GlyphMetric fields mirror the BMFont char block layout (toolchain wiki §4):
//   advance  <- xadvance  (horizontal distance to next glyph)
//   bearingX <- xoffset  (horizontal offset from cursor)
//   bearingY <- yoffset  (vertical offset from baseline)
//   size.{w,h} <- width/height (glyph quad size in layout space, before atlas
//     scale)
//   region.{x,y,w,h} <- atlas UV region in pixels (x/y = top-left corner
//     relative to atlas origin)

/**
 * Per-glyph metric layout — 1:1 mirror of BMFont char block fields
 * (toolchain wiki §4). POD, math-free.
 */
export interface GlyphMetric {
  /** Horizontal distance to the next glyph (xadvance). */
  readonly advance: number;
  /** Horizontal offset from cursor (xoffset). */
  readonly bearingX: number;
  /** Vertical offset from baseline (yoffset). */
  readonly bearingY: number;
  /** Glyph quad size in layout space. */
  readonly size: { readonly w: number; readonly h: number };
  /** Atlas UV region in pixels (top-left origin). */
  readonly region: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

/**
 * Font asset POD — atlas texture handle + sampler handle + per-codepoint
 * glyph metrics + common layout block.
 *
 * AI users obtain a FontAsset via `assets.loadByGuid<FontAsset>(guid)` and
 * hand the resulting `Handle<FontAsset>` to `GlyphText.fontHandle`. The atlas
 * texture and sampler are resolved through the handle chain by the glyph
 * layout system; the per-glyph metrics drive the quad-position-and-UV baking
 * (plan-strategy D-6).
 *
 * | Field | Purpose |
 * |:--|:--|
 * | `atlas` | Handle to the baked MSDF atlas `TextureAsset` |
 * | `sampler` | Handle to the `SamplerAsset` for atlas sampling |
 * | `glyphs` | `Record<codepoint, GlyphMetric>` — O(1) codepoint lookup |
 * | `common` | Common layout block (lineHeight / base / distanceRange / pxRange / atlas width/height) |
 * | `notdef` | Optional fallback glyph metric for missing codepoints (TOFU, AC-14) |
 */
export interface FontAsset {
  readonly kind: 'font';
  /**
   * Atlas texture GUID (D-19). Payload-internal sub-asset ref stored as an
   * AssetGuid, not a handle — the loadByGuid recursion mints no handle; the
   * World-holding consumer (glyph-text-layout) resolves it once at read time.
   */
  readonly atlas: AssetGuid;
  /** Sampler GUID (D-19). Same GUID-identity contract as `atlas`. */
  readonly sampler: AssetGuid;
  readonly glyphs: Record<number, GlyphMetric>;
  readonly common: {
    readonly lineHeight: number;
    readonly base: number;
    readonly distanceRange: number;
    readonly pxRange: number;
    readonly atlasWidth: number;
    readonly atlasHeight: number;
  };
  readonly notdef?: GlyphMetric;
}

// === RenderPipelineAsset POD shape =============================================
//
// feat-20260601-customizable-render-pipeline-seam-and-dogfood-rend M1 / w5.
// Asset-layer descriptor that binds a registered render-pipeline logic id to an
// installable Handle (the MaterialAsset { materialShaderId, params } pattern, scaled to
// the pipeline layer). `installPipeline(handle)` resolves this POD off the AssetRegistry,
// looks up `pipelineId` in the pipeline registry, and swaps the per-frame graph.
//
// M2 stage (w10): `config.passCount` is the FIRST real config key. The standard pipeline
// runs with config undefined (default frame byte-identical, AC-01); a custom pipeline can
// size its declared pass chain from `config.passCount` so its topology varies observably
// via `renderer.perFramePassNames` (AC-03 / plan-strategy D-C).
//
// feat-20260608-cluster-lighting M2 / w8: `config.clusterGrid` is the HDRP cluster grid
// dimensions config (default {x:16, y:9, z:24}). `pipelineId` is narrowed to a literal
// union of `'forgeax::urp' | 'forgeax::hdrp' | (string & {})` so TS narrowing on
// `pipelineId === 'forgeax::hdrp'` narrows `config.clusterGrid`.
//
// feat-20260612-hdrp-ssao M4 / w19: `config.ssao` is the SSAO configuration
// (enabled+radius+bias+intensity). Same shared-config pattern as clusterGrid;
// HDRP consumes it, URP ignores it at runtime.
/**
 * Asset-layer descriptor for an installable render pipeline.
 *
 * `pipelineId` references a logic registered via `renderer.registerPipeline(id, impl)`
 * (engine builtins use the `forgeax::` prefix, e.g. `'forgeax::urp'`; user pipelines use
 * `<package>::<id>`). `config` is the per-install tuning the pipeline logic reads at
 * `buildGraph` time; `passCount` is the first real key (a custom pipeline declares that
 * many passes). The URP ignores `config` (its topology is fixed).
 *
 * `config.clusterGrid` is the HDRP cluster grid dimensions (x/y/z each an integer in
 * [1, 64]; default {16, 9, 24}). It is ignored by URP.
 *
 * `config.ssao` enables SSAO (Screen-Space Ambient Occlusion) for the HDRP
 * deferred path. Ignored by URP.
 */
export interface RenderPipelineAsset {
  readonly kind: 'render-pipeline';
  readonly pipelineId: 'forgeax::urp' | 'forgeax::hdrp' | (string & {});
  readonly config?: {
    readonly passCount?: number;
    readonly clusterGrid?: { readonly x: number; readonly y: number; readonly z: number };
    readonly ssao?: {
      readonly enabled: boolean;
      readonly radius?: number | undefined;
      readonly bias?: number | undefined;
      readonly intensity?: number | undefined;
    };
    /**
     * feat-20260621 M4': ordered registered post-process shader ids the built-in
     * pipelines composite over the FINAL swap-chain image, after the fxaa pass
     * and before the debug overlay. Each id must be registered via
     * `renderer.postProcess.register(id, entry)` first. The effects run in array
     * order; each samples the current swap-chain (copy) and writes it back, so a
     * chain composes left-to-right. This is the AUGMENT path: the built-in 9-pass
     * chain (shadow cascades, tonemap, bloom, fxaa) renders unchanged and the
     * effects layer on top — unlike installing a wholly custom pipeline, which
     * REPLACES the built-in graph (and would drop its shadow passes). `undefined`
     * or `[]` adds zero passes (default frame byte-identical).
     *
     * WebGPU backend only: each effect reads the mid-frame swap-chain (copy +
     * non-srgb storage-view write), which the WebGL2 fallback swap-chain does not
     * support (no COPY_SRC, no non-srgb reinterpret view) — same constraint the
     * built-in FXAA pass already carries. On a non-WebGPU device leave this empty.
     */
    readonly postEffects?: readonly string[];
  };
}

/**
 * Asset discriminated union - 13 variants keyed on `.kind`.
 *
 * Variant history:
 *   - feat-20260513-instanced-mesh M1 introduced a 5th `'instanced-buffer-asset'`
 *     variant carrying packed mat4 transforms + a `version` dirty flag.
 *   - feat-20260514-ecs-children-instances-managed-buffer-array M3 (w15)
 *     retired that variant: per-entity instanced transforms are now stored
 *     directly inside the ECS via the `Instances { transforms: 'array<f32>' }`
 *     component (managed by the BufferPool slot column + sidecar count
 *     column). Asset closed-union shrinks 5 -> 4 (evolution major rename
 *     per AGENTS.md `Change stance`); existing exhaustive `switch
 *     (asset.kind)` consumers drop the now-unreachable arm in the same PR.
 *   - feat-20260514-scene-as-world-blueprint w3 added `'scene'` variant
 *     (4 -> 5, minor add per AGENTS.md `Evolution contract`); declarative
 *     SceneEntity list, no overrides at the asset layer.
 *   - feat-20260528-material-shader-registration-unification w1 added `'shader'`
 *     variant (10 -> 11, minor add per AGENTS.md `Evolution contract`);
 *     ShaderAsset with name + source + paramSchema.
 *   - feat-20260531-world-space-msdf-text-rendering w5 added `'font'` variant
 *     (11 -> 12, minor add per AGENTS.md `Evolution contract`);
 *     FontAsset with atlas handle + sampler handle + glyph metrics.
 *   - feat-20260601-customizable-render-pipeline-seam-and-dogfood-rend w5 added
 *     `'render-pipeline'` variant (12 -> 13, minor add per AGENTS.md
 *     `Evolution contract`); RenderPipelineAsset with pipelineId + config.
 *   - feat-20260623-world-space-video-asset M1 added `'video'` variant
 *     (14 -> 15, minor add per AGENTS.md `Evolution contract`);
 *     VideoAsset with `{ url }` descriptor, no width/height/duration.
 *
 * Exhaustive `switch (asset.kind)` type-guards against future additions
 * without default fallback (charter proposition 4 + proposition 3).
 *
 * | kind | variant |
 * |:--|:--|
 * | `'mesh'` | `MeshAsset` |
 * | `'texture'` | `TextureAsset` |
 * | `'cube-texture'` | `CubeTextureAsset` |
 * | `'sampler'` | `SamplerAsset` |
 * | `'material'` | `MaterialAsset` (further narrows on `.passes`) |
 * | `'scene'` | `SceneAsset` (declarative SceneEntity list, no overrides) |
 * | `'shader'` | `ShaderAsset` (material-shader registration SSOT, name + source + paramSchema) |
 * | `'font'` | `FontAsset` (MSDF atlas handle + glyph metrics) |
 * | `'render-pipeline'` | `RenderPipelineAsset` (installable pipeline logic id + config) |
 * | `'video'` | `VideoAsset` (runtime-only `{ url }` descriptor, no width/height/duration) |
 */
export type Asset =
  | MeshAsset
  | TextureAsset
  | CubeTextureAsset
  | SamplerAsset
  | MaterialAsset
  | SceneAsset
  | ShaderAsset
  | SkeletonAsset
  | SkinAsset
  | AnimationClip
  | AudioClipAsset
  | FontAsset
  | RenderPipelineAsset
  // === 1 new variant (feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild) ===
  // Direct atlases[] form (plan-strategy D-7 one-cut); no intermediate single-`atlas` shape.
  | TilesetAsset
  // === 1 new variant (feat-20260623-world-space-video-asset M1) ===
  // runtime-only { url } descriptor; no width/height/duration in payload.
  | VideoAsset;

// === Tileset asset POD shape (feat-20260608 M0 baseline rebuild) =================
//
// Decision anchors:
//   - requirements §AC-01/03/04/05 (TilesetAsset 9 fields; atlases plural composite;
//     M0 TilesetTileEntry single-field shape with M1 adding 5 optional + collider).
//   - plan-strategy §D-5 (M0 baseline rebuild after main reverted feat-20260604).
//   - plan-strategy §D-7 (`atlases: readonly Handle<TextureAsset,managed>[]` one-cut
//     rename; no `atlas` single-form alias or dual-path).
//   - plan-strategy §D-6 (AssetErrorCode count restoration -- M0 reintroduces
//     `tileset-region-index-out-of-range`; M1 adds `tileset-tile-entry-malformed`).
//   - charter F1 (AI users discover the schema via IDE autocomplete on the closed
//     `Asset` union + `Handle<TilesetAsset>` returns from `AssetRegistry.register`).
//   - charter P4 (atlases plural composite mirrors `MaterialAsset.passes[]` shape).

/**
 * Closed `TilesetTileCollider` union -- per-tile collider schema (M1
 * extension; feat-20260608-tilemap-object-layer-rendering M1 / m1-t2).
 *
 * Three discriminant variants (closed enum, charter P3):
 *
 *   - `{ type: 'none' }` -- no collider for this tile.
 *   - `{ type: 'rect', rect: readonly [x, y, w, h] }` -- axis-aligned
 *     rectangle in normalized cell coordinates `[0, 1]^2`. `w > 0`, `h > 0`,
 *     `x + w <= 1`, `y + h <= 1` are enforced by `validateTilesetPayload`
 *     (R-6 first-error path).
 *   - `{ type: 'polygon', points: readonly [x, y][] }` -- convex/concave
 *     polygon in normalized cell coordinates. `points.length >= 3` and
 *     each point lies in `[0, 1]^2`.
 *
 * The engine validates this schema at register-time but does NOT consume
 * it (plan-strategy §D-4 -- schema landed, consumer deferred to a future
 * `feat-tilemap-physics-bridge` closed loop). AI users with a physics
 * sidecar consume the schema directly via `tileset.tiles[i].collider`
 * after `assets.register<TilesetAsset>(...)` resolves the handle.
 *
 * Exhaustive switch:
 * ```ts
 * switch (collider.type) {
 *   case 'none': return null;
 *   case 'rect': return collider.rect;
 *   case 'polygon': return collider.points;
 *   // No default branch -- TS guards completeness (charter P3).
 * }
 * ```
 */
export type TilesetTileCollider =
  | { readonly type: 'none' }
  | { readonly type: 'rect'; readonly rect: readonly [number, number, number, number] }
  | { readonly type: 'polygon'; readonly points: readonly (readonly [number, number])[] };

/**
 * Rectangular sub-region within a tileset atlas (M1 schema extension on
 * top of M0 baseline rebuild).
 *
 * Four required fields define the atlas-space rectangle in pixels:
 * `x` / `y` top-left corner; `width` / `height` extent. `width + x` and
 * `height + y` MUST stay within the parent atlas extent or
 * `validateTilesetPayload` returns
 * `AssetError { code: 'tileset-region-index-out-of-range' }`
 * (charter P3 explicit failure at register-time).
 *
 * Optional `atlasIndex?: number` (M1; default 0) routes the region into
 * `TilesetAsset.atlases[atlasIndex]` for multi-atlas tilesets. Out-of-range
 * `atlasIndex` (`>= atlases.length` or negative) surfaces
 * `AssetError { code: 'tileset-tile-entry-malformed', detail: { field: 'atlasIndex', scope: 'tileset-asset' } }`
 * at register-time (plan-strategy §D-7 three-hop routing; R-6 first-error
 * order places atlasIndex check between region rect bounds and per-tile
 * entry field checks).
 */
export interface TilesetRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly atlasIndex?: number;
}

/**
 * Per-tile entry in `TilesetAsset.tiles[]` (M1 schema extension on top of
 * M0 baseline rebuild).
 *
 * Required `regionIndex` points into the parent `TilesetAsset.regions[]`
 * array. M1 adds five optional fields for the variable-size + custom-pivot
 * object-layer story (plan-strategy §M1):
 *
 *   - `widthCells?: number` -- multi-cell width in `Tilemap.cols/rows`
 *     coordinate units (default 1; range `(0, 64]`). Anchored at the
 *     cell that hosts the non-zero tileId entry; cells inside the
 *     `widthCells x heightCells` footprint must stay 0 in `TileLayer.tiles[]`
 *     (anchor convention, not enforced at register time).
 *   - `heightCells?: number` -- multi-cell height (default 1; range `(0, 64]`).
 *   - `pivotX?: number` -- normalized horizontal pivot in `[0, 1]` (default 0.5).
 *     The pivot is the world-space anchor: `pivot_world_X = (cellX + pivotX) * tileSizeX`.
 *     Quad center is offset by `(0.5 - pivotX) * widthCells * tileSizeX`
 *     (plan-strategy §D-2 first-line geometry; M2 implementation).
 *   - `pivotY?: number` -- normalized vertical pivot in `[0, 1]` (default 0.5).
 *     For asi_world `.tsj` extension: `pivotY = 1.0` means quad bottom
 *     anchors the cell, `pivotY = 0.0` means quad top (per-asset convention,
 *     not Tiled native). The engine uses `effectivePivotY` for Y-sort.
 *   - `collider?: TilesetTileCollider` -- 3-variant closed union schema
 *     (charter P3). Engine validates the schema at register-time but does
 *     NOT consume it (plan-strategy §D-4).
 *
 * All five fields are optional so unit-cell call sites `{ regionIndex: N }`
 * remain backward compatible (charter F1).
 *
 * Out-of-range `regionIndex` (>= regions.length, or negative) surfaces
 * `AssetError { code: 'tileset-region-index-out-of-range' }`. Out-of-range
 * `widthCells / heightCells / pivotX / pivotY / collider` surface
 * `AssetError { code: 'tileset-tile-entry-malformed', detail: { field, scope: 'tile-entry', tileEntryIndex } }`
 * (plan-strategy §D-6 closed 7-variant `.detail.field` enum).
 */
export interface TilesetTileEntry {
  readonly regionIndex: number;
  readonly widthCells?: number;
  readonly heightCells?: number;
  readonly pivotX?: number;
  readonly pivotY?: number;
  readonly collider?: TilesetTileCollider;
}

/**
 * Tileset asset (M0 baseline rebuild on origin/main).
 *
 * Nine fields:
 *   - `kind`         -- discriminator literal `'tileset'`.
 *   - `guid`         -- asset GUID (charter P5 identity SSOT).
 *   - `atlases`      -- one or more managed handles to atlas textures.
 *                       `atlases.length >= 1` enforced at register time.
 *                       M0 reads `atlases[0]` exclusively (single-atlas form);
 *                       M1 adds `regions[].atlasIndex` for multi-atlas routing.
 *   - `tileWidth`/`tileHeight` -- per-cell pixel size (atlas grid stride).
 *   - `columns`/`rows`        -- atlas grid layout (informational metadata; used
 *                               as fallback when `atlasSizes` is absent to infer
 *                               atlas pixel extent as `columns * tileWidth`).
 *   - `atlasSizes`  -- optional per-atlas pixel dimensions. When present,
 *                      `atlasSizes[i]` gives the exact pixel size of
 *                      `atlases[i]` and overrides `columns`/`rows` for UV
 *                      normalisation in the chunk-extract system. Required when
 *                      the tileset contains multiple atlases with different
 *                      pixel sizes (e.g. a terrain + object composite tileset).
 *                      Each entry carries `{ pixelWidth, pixelHeight }`.
 *   - `regions`     -- array of atlas sub-rectangles (TilesetRegion).
 *   - `tiles`       -- per-tile entries (TilesetTileEntry), 1-indexed via tile id
 *                      sentinel where 0 means "empty" in `TileLayer.tiles`.
 *
 * Plural composite `atlases` (not single `atlas`) is the one-cut breaking
 * rename versus the old feat-20260604 form (plan-strategy §D-7 + AGENTS.md
 * §Change stance "optimal > compatible"); no deprecation alias survives.
 *
 * @example Register a tileset and spawn a Tilemap + TileLayer pair:
 * ```ts
 * const atlas = registry.register<TextureAsset>(atlasTexture).unwrap();
 * const tileset = registry.register<TilesetAsset>({
 *   kind: 'tileset',
 *   guid: 'world/object_atlas',
 *   atlases: [atlas],
 *   tileWidth: 16,
 *   tileHeight: 16,
 *   columns: 8,
 *   rows: 8,
 *   regions: [{ x: 0, y: 0, width: 16, height: 16 }],
 *   tiles: [{ regionIndex: 0 }],
 * }).unwrap();
 * ```
 */
export interface TilesetAtlasSize {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export interface TilesetAsset {
  readonly kind: 'tileset';
  readonly guid: string;
  readonly atlases: readonly Handle<'TextureAsset', 'shared'>[];
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly columns: number;
  readonly rows: number;
  /** Per-atlas pixel dimensions. `atlasSizes[i]` overrides `columns`/`rows`
   *  for UV normalisation of regions whose `atlasIndex === i`. Required when
   *  atlases have different pixel sizes. */
  readonly atlasSizes?: readonly TilesetAtlasSize[];
  readonly regions: readonly TilesetRegion[];
  readonly tiles: readonly TilesetTileEntry[];
}

// === AssetRef + AssetEnvelope (feat-20260622-asset-ref-graph-protocol-unification-refs-as-ssot M1 / w1) ===
//
// Decision anchors:
//   - plan-strategy D-1: single envelope type AssetEnvelope = { guid, kind, name?,
//     payload, refs } — ImportedAsset is upgraded to this shape; assetCatalog
//     value type changes from Map<string, Asset> to Map<string, AssetEnvelope>.
//   - plan-strategy D-2: scene refs are importer flat superset (mesh U material U
//     texture U skeleton U skin); texture edges have sourceField=undefined (no
//     per-entity origin).
//   - plan-strategy D-3: sourceField is structured triple { componentName,
//     fieldName, arrayIndex? } — consumers read via property access, not string
//     parse (charter P3).
//   - plan-strategy D-10: edge metadata (AssetRef) does NOT sink into Loader.load
//     refs param — loader still receives GUID string projection.
//   - plan-strategy OOS-1: Asset closed union unchanged; AssetEnvelope wraps it.
//   - plan-strategy OOS-4: AssetErrorCode member set unchanged (21 members).
//   - charter F1: single-entry indexability — refs field name cross-layer
//     consistent (ImportedAsset.refs / AssetEnvelope.refs / pack-index refs).

/**
 * Structured edge metadata carried in an asset envelope's `refs[]`. Each entry
 * records a GUID-level reference plus optional provenance: which scene entity
 * field originated the reference (``sourceField``) and the entity's local id
 * (``sceneEntityId``). Texture edges and other transitive references have no
 * per-entity origin — ``sourceField`` is ``undefined`` for those (D-2).
 *
 * AI users consume ``sourceField`` via property access (``ref.sourceField?.componentName``
 * / ``ref.sourceField?.fieldName`` / ``ref.sourceField?.arrayIndex``), never by
 * parsing a concatenated string (charter P3).
 */
export interface AssetRef {
  readonly guid: string;
  readonly sourceField?: {
    readonly componentName?: string;
    readonly fieldName: string;
    readonly arrayIndex?: number;
  };
  readonly sceneEntityId?: number;
}

/**
 * Self-contained asset envelope — the single shape through which assets flow
 * from import to catalog to recursive load (plan-strategy D-1).
 *
 * ``payload`` carries the closed ``Asset`` union member (mesh / texture / scene /
 * material / etc.). ``refs`` is the authoritative reference graph — every GUID
 * this asset transitively depends on, with optional edge metadata
 * (``sourceField`` / ``sceneEntityId``). ``name`` is the per-asset display name
 * (may be undefined; ``resolveName`` derives the final name via a three-argument
 * XOR that also considers the package path).
 */
export interface AssetEnvelope<P = Asset> {
  readonly guid: string;
  readonly kind: string;
  // Per-GUID stored display name -- the `storedName` argument resolveName feeds
  // to deriveAssetName (the single home for the explicit name, replacing the
  // retired storedNameOf side table). `undefined` = no explicit name (resolveName
  // then applies the multi-asset basename fallback / no-package '' branch).
  readonly name?: string;
  readonly payload: P;
  readonly refs: readonly AssetRef[];
}

// === Package interface (feat-20260618-asset-and-pack-name-fields M1 / w2) ======
//
// Decision anchors:
//   - plan-strategy D-7 (Package interface in @forgeax/engine-types, same layer
//     as Asset union, for multi-package consumer discoverability per charter F1)
//   - architecture-principles #2 (Derive, Don't Duplicate): assetCount is
//     derived from assetGuids.size, never stored independently
//   - plan-strategy D-5 (builtin assets -> null Package, not a synthetic path)
//   - Package does not carry a `name` field — resolved names flow through
//     resolveName (D-6), not stored on Package
//
// AI users discover Package via IDE autocomplete on @forgeax/engine-types;
// the runtime AssetRegistry.packageOf Map carries Package | null per guid.

/**
 * Runtime view of one import-source package -- the grouping unit for
 * the two-segment asset identity (`<packagePath>.<name>`).
 *
 * `path` is the import file path (e.g. `'assets/hero.glb'`).  Multiple
 * assets imported from the same source file share one `Package`.
 *
 * `assetGuids` lists every GUID that belongs to this package.  The
 * runtime keeps it in sync with `registerPackage` insertions.
 *
 * `assetCount` is a derived view (`assetGuids.size`); it is **not**
 * stored as a standalone field (Derive axiom #2).
 */
export interface Package {
  readonly path: string;
  readonly assetGuids: ReadonlySet<string>;
  readonly assetCount: number;
}

// === Scene asset POD shape (feat-20260514-scene-as-world-blueprint w2) ==========
//
// Decision anchors:
//   - requirements §AC-01 (AssetUnion 6 elements; SceneAsset top level only
//     `kind` + `entities`, no overrides field at the asset layer)
//   - requirements §AC-02 (LocalEntityId branded number; cross-brand assignment
//     to / from Entity is a TS compile-time error)
//   - charter proposition 1 (single-entry IDE autocomplete from
//     `@forgeax/engine-types`) + proposition 4 (explicit failure: brand
//     phantom rejects untagged number) + proposition 5 (consistent
//     abstraction, structurally parallel to Handle<T> brand)
//
// The unique-symbol brand stays private to this module so the brand
// identity is anchored exactly here; consumers refer to LocalEntityId
// as opaque number subtypes.

declare const LocalEntityIdBrand: unique symbol;

/**
 * Scene-local entity index brand (u32).
 *
 * Authored as `0..entities.length-1` inside a SceneAsset; runtime storage stays
 * a plain JS number (the phantom `[LocalEntityIdBrand]` is erased at runtime
 * but rejects cross-brand assignment with `Entity` at
 * the TS layer).
 *
 * AI users obtain LocalEntityId values from `SceneEntity.localId` accessors and
 * hand them back to `SceneEntity` manipulation methods; plain
 * `number` is not assignable to `LocalEntityId` by design — see
 * `packages/types/src/__tests__/scene-brand.test-d.ts` for the negative
 * assertions.
 */
export type LocalEntityId = number & { readonly [LocalEntityIdBrand]: void };

/**
 * Open map shape from component name to the per-component value record
 * authored on a `SceneEntity` (feat-20260514 w2).
 *
 * The map is keyed by component-token name (`'Transform' | 'MeshFilter' |
 * 'ChildOf' | ...`) and each per-component record is a free-form
 * `Record<string, unknown>` POD shape; the precise field types live in the
 * ecs `defineComponent(...)` schema (one layer up). This package stays
 * math-free + ecs-free; the layered alignment with the ecs schema vocab is
 * documented in plan-strategy §3.1 types_pkg sub-graph and tested by w3 /
 * w22 at the ecs / runtime layer.
 *
 * Open shape is intentional: components evolve via add-only minor in their
 * own packages; locking this map to a closed union here would force an edit
 * in @forgeax/engine-types every time a new component appears (charter
 * proposition 5 consistent abstraction — registration discipline owned by
 * each component's defineComponent site).
 */
export type ComponentValuesMap = {
  readonly [componentName: string]: Readonly<Record<string, unknown>>;
};

/**
 * Single SceneEntity POD shape (feat-20260514 w2).
 *
 * Carries one `localId` (LocalEntityId brand) plus a partial map of explicit
 * component field values. The partial keying lets layer 1 (explicit) leave
 * any component absent so layer 2 (component-level defaults) and layer 3
 * (TS type defaults) can fill in the residual fields at instantiate time
 * (plan-strategy §default-values 4-layer fallback table; AC-07 / AC-11 /
 * AC-12 sites).
 */
export interface SceneEntity {
  readonly localId: LocalEntityId;
  readonly components: Partial<ComponentValuesMap>;
}

/**
 * One field-level override applied to a mounted scene member at
 * mount-time (feat-20260608-scene-nesting-ecs-fication M1 / w7; AC-01,
 * AC-19).
 *
 * `localId` selects a member entity inside the mounted SceneAsset,
 * counted against the mount's `memberFirst` window. `comp` and `field`
 * name the component and the per-component field whose value is to be
 * overwritten at instantiate time; `value` carries the override payload
 * (typed `unknown` because the per-component schema vocab lives one
 * layer up — runtime fail-fast via 'scene-override-type-mismatch'
 * catches type drift, plan-strategy D-9).
 *
 * Charter mapping: proposition 3 (machine-readable union, MountOverride
 * is a closed POD shape) + proposition 4 (explicit failure: runtime
 * apply path returns Result with structured error code).
 */
export interface MountOverride {
  readonly localId: LocalEntityId;
  readonly comp: string;
  readonly field: string;
  readonly value: unknown;
}

/**
 * One mount instance authored on a parent SceneAsset
 * (feat-20260608-scene-nesting-ecs-fication M1 / w7; AC-01).
 *
 * A mount embeds another SceneAsset (referenced by `source`, an integer
 * index into the parent .pack.json's `refs[]`) into the parent's
 * namespace. The mount reserves a contiguous LocalEntityId window
 * `[memberFirst, memberFirst + memberCount)` for the embedded scene's
 * member entities so the parent SceneAsset's namespace invariant
 * `totalSlots = entities.length + mounts.length + sum(memberCount)`
 * holds (plan-strategy §6.3 + requirements §S-1).
 *
 * Optional fields:
 *   - `parent`: LocalEntityId in the *parent* scene to which the mount
 *     attaches (defaults to the parent scene's outermost root,
 *     requirements-decisions §D-4);
 *   - `components`: per-component value overlay applied to the mount
 *     entity itself (mirrors SceneEntity.components shape; carries the
 *     same Partial<ComponentValuesMap> typing);
 *   - `overrides`: an array of MountOverride records that further
 *     specialise individual member entities at mount-time (AC-19).
 *
 * Charter mapping: proposition 1 (single-entry import surface;
 * SceneInstanceMount sits next to SceneEntity / SceneAsset) +
 * proposition 5 (consistent abstraction: the field set mirrors
 * SceneEntity for AI-user discoverability).
 */
export interface SceneInstanceMount {
  readonly localId: LocalEntityId;
  readonly source: number;
  readonly memberFirst: LocalEntityId;
  readonly memberCount: number;
  readonly parent?: LocalEntityId;
  readonly components?: Partial<ComponentValuesMap>;
  readonly overrides?: readonly MountOverride[];
}

/**
 * Scene asset POD shape (feat-20260514 w2; sixth member of the closed
 * `Asset` union).
 *
 * Three top-level fields — `kind: 'scene'` discriminator,
 * `entities: readonly SceneEntity[]`, and the optional `mounts:
 * readonly SceneInstanceMount[]` (feat-20260608-scene-nesting-
 * ecs-fication M1 / w7; AC-01). Per-instance overrides at the
 * asset layer are still absent (charter proposition 5: ECS write
 * paths and prefab override paths are explicitly disjoint,
 * plan-strategy §3.2 sequence B); the `mounts[]` window is an
 * authoring-time graph edge, not a write path.
 *
 * Back-compat: `mounts` is optional so legacy SceneAsset values
 * remain assignable; missing `mounts` is semantically equivalent to
 * `mounts: []` (plan-strategy §6.3, ajv default `[]`).
 */
export interface SceneAsset {
  readonly kind: 'scene';
  readonly entities: readonly SceneEntity[];
  readonly mounts?: readonly SceneInstanceMount[];
  /**
   * GUIDs of `SkinAsset`s the scene's skinned entities reference (one per
   * SkeletonAsset bound by a `Skin: { skeleton }` component). SkinAssets are
   * not reachable through any `handle<*>` field on a SceneEntity component
   * (`Skin.skeleton` carries the SkeletonAsset GUID; the SkinAsset itself is
   * a sibling identified by matching `skeletonGuid`), so the scene's pack
   * load chain has to surface them explicitly. Without this list the
   * browser-async-pack-fetch path would never load SkinAssets, leaving
   * `postSpawnResolveJoints` unable to populate `Skin.joints[]` and the
   * extract pass fail-fasting on `Skin.joints.length=0` every frame
   * (feat-20260612-skin-palette-per-frame-upload M2 fixup).
   *
   * On disk: refs[] indices, mirror of `mounts[].source`.
   * Post-parseScenePayload: GUID strings (resolved via refs[]).
   * Enumerated in the scene envelope's `refs[]` (the recursion source) so
   * `loadByGuid<SceneAsset>` recursively pulls each SkinAsset before
   * `instantiate`.
   */
  readonly skinGuids?: readonly string[];
}

// === Skeleton / Skin / AnimationClip asset POD shapes (feat-20260523-skin-skeleton-animation M0) ===
//
// Decision anchors:
//   - requirements AC-01 (SkeletonAsset shape: kind, guid, inverseBindMatrices Float32Array, jointCount)
//   - requirements AC-04 (Skin sub-asset shape: kind, guid, skeletonGuid, jointPaths)
//   - requirements AC-07 (AnimationClip shape: kind, guid, duration, channels)
//   - plan-strategy D-1 (3-asset separation: IBM/Skin bindings/AnimationClip curves physically independent)
//   - charter P3 (explicit failure: all shape carry typed fields, no loose Record<string,unknown> payloads)
//
// AnimationChannel / AnimationSampler sub-types are inline here since they are
// exclusively consumed by AnimationClip; no other asset or component references them.

/** Per-joint-path target path description linking a sampler to a scene joint. */
export interface AnimationChannel {
  /** Sequence of Name component values from scene root to this joint (glTF node hierarchy). */
  readonly targetPath: readonly string[];
  /** Target transform property: 'translation' | 'rotation' | 'scale'. */
  readonly property: 'translation' | 'rotation' | 'scale';
  /** Sampler driving this channel. */
  readonly sampler: AnimationSampler;
}

/**
 * Animation sampler — keyframe curve for a single joint-property pair.
 *
 * `input` and `output` are Float32Arrays of equal length
 * (`output.length = input.length * elementCount`) where elementCount is:
 *   - 3 for 'translation' / 'scale' (vec3)
 *   - 4 for 'rotation' (quat)
 *
 * `interpolation` is restricted to LINEAR and STEP per D-1 scope;
 * CUBICSPLINE is deferred to OOS-skin-cubicspline (fail-fast at importer).
 */
export interface AnimationSampler {
  readonly input: Float32Array;
  readonly output: Float32Array;
  readonly interpolation: 'LINEAR' | 'STEP';
}

/**
 * Animation clip asset POD shape.
 *
 * `duration` is max(sampler.input[last]) across all channels — the
 * longest channel defines the clip length. Each channel targets one
 * joint-property pair, resolved at post-spawn time via jointPath lookup.
 */
export interface AnimationClip {
  readonly kind: 'animation-clip';
  readonly duration: number;
  readonly channels: readonly AnimationChannel[];
}

/**
 * Audio clip asset POD shape -- decoded PCM buffer ready for playback
 * (feat-20260527-audio-system M1 / w7; plan-strategy D-6).
 *
 * `buffer` carries the `AudioBuffer` decoded by `decodeAudioData`.
 * The `AudioBuffer` memory is shared across all `AudioClipAsset` handles
 * pointing to the same source -- only one decode per GUID (research
 * Finding "AudioBufferSourceNode one-shot" confirms AudioBuffer is
 * the single heavy resource).
 *
 * Consumers spawn `AudioSource` components with a
 * `Handle<'AudioClipAsset', 'shared'>` referring to this asset;
 * the `audioTickSystem` creates fresh `AudioBufferSourceNode` instances
 * per play edge.
 */
export interface AudioClipAsset {
  readonly kind: 'audio';
  readonly buffer: AudioBuffer;
}

// === VideoAsset POD shape (feat-20260623-world-space-video-asset M1) ==========
//
// Decision anchors:
//   - requirements AC-01 (VideoAsset is Asset closed-union 15th member;
//     kind discriminator 'video'; payload { url: string }, no width/height/duration).
//   - requirements constraint: payload must not inline video bytes, only a URL descriptor.
//   - plan-strategy D-4 (VideoAsset descriptor naming aligns with TextureAsset/AudioClipAsset).
//   - charter F1 (AI users discover the schema via IDE autocomplete on the closed
//     `Asset` union + `Handle<VideoAsset>` returns from `AssetRegistry.register`).
//   - plan-strategy D-5 (resolveTexLike identifies video kind via `payload.kind === 'video'`;
//     video does not masquerade as 'texture').
//
// `refs` is always empty (isolated leaf) — VideoAsset carries no sub-asset
// references (plan-strategy S6.3). The `url` field points to an external video
// file; the runtime resolves it into an HTMLVideoElement via the host-provided
// `VideoElementProvider` World Resource (plan-strategy D-1).

/**
 * Video asset POD shape -- pure `{url}` descriptor.
 *
 * `VideoAsset` is a runtime-only asset kind (OOS-1: no import/cook pipeline).
 * The `url` field points to an external video file (e.g. `*.webm` / `*.mp4`);
 * the engine does NOT decode video bytes -- it delegates to the host-side
 * `HTMLVideoElement` via `VideoElementProvider` (plan-strategy D-1).
 *
 * `width` / `height` / `duration` are deliberately absent from the POD:
 * the runtime reads them from `HTMLVideoElement.videoWidth` /
 * `videoHeight` / `duration` after `loadedmetadata` fires (requirements
 * constraint "payload must not inline video bytes").
 *
 * Consumers reference a VideoAsset via `MaterialAsset.paramValues` texture
 * fields (e.g. `baseColorTexture`), sharing the same `texture2d` slot with
 * static textures (charter P4 consistent abstraction). The extraction layer
 * (render-system-extract `resolveTexLike`) identifies the video kind and
 * routes to the per-frame transient texture pathway instead of the static
 * `GpuResourceStore.ensureResident` cache (plan-strategy D-5).
 */
export interface VideoAsset {
  readonly kind: 'video';
  readonly url: string;
}

/**
 * Skeleton asset POD shape — pure rig data, no mesh attachment.
 *
 * `inverseBindMatrices` is a Float32Array of length jointCount * 16
 * (column-major mat4 per joint). Missing IBM in source glTF is filled
 * with identity mat4 at importer time.
 *
 * `jointCount` is the number of joints (= IBM array length / 16).
 * Keys off the glTF skin's `joints[]` array length; validated against
 * MAX_JOINTS (256) at importer time.
 */
export interface SkeletonAsset {
  readonly kind: 'skeleton';
  readonly inverseBindMatrices: Float32Array;
  readonly jointCount: number;
}

/**
 * Skin sub-asset — the binding between a skeleton and a scene node hierarchy.
 *
 * `skeletonGuid` references a SkeletonAsset by GUID (string form).
 * `jointPaths` is a parallel array to the skeleton's joints; each entry
 * is a Name-component path from scene root to the joint entity, used
 * at post-spawn time to populate Skin.joints: Entity[].
 *
 * Zero-Entity-reference at the asset layer (AC-06): no Entity or
 * LocalEntityId fields — the binding is name-based, resolved at instantiate time.
 */
export interface SkinAsset {
  readonly kind: 'skin';
  readonly skeletonGuid: string;
  readonly jointPaths: readonly string[];
}

/**
 * Vertex attribute map - 6-lowercase-key closed set (G7 / AC-15).
 *
 * Keys align with Three.js r184 `BufferGeometry.attributes` naming (D-P1 +
 * plan-strategy §7.2 mental migration stance). M3 GLTF loader performs a
 * single-layer rename at ingest (`POSITION -> position` / `TEXCOORD_0 -> uv`
 * / `JOINTS_0 -> skinIndex` / `WEIGHTS_0 -> skinWeight`) so the runtime key
 * space remains lowercase.
 *
 * All 6 keys are optional; a mesh with only `position` (static unlit) is
 * valid. Values accept the three common binary shapes:
 * `ArrayBuffer | Float32Array | Uint16Array` (extend only via minor add per
 * the closed-union evolution contract).
 *
 * AC-15 narrowing: consumer sites writing
 * `for (const [key, buffer] of Object.entries(attributes))` observe `key`
 * typed as the 6-member literal union without `as` casts; any typo (e.g.
 * `'POSITION'`) is a TS compile-time error.
 */
export interface VertexAttributeMap {
  position?: ArrayBuffer | Float32Array | Uint16Array;
  normal?: ArrayBuffer | Float32Array | Uint16Array;
  uv?: ArrayBuffer | Float32Array | Uint16Array;
  tangent?: ArrayBuffer | Float32Array | Uint16Array;
  skinIndex?: ArrayBuffer | Float32Array | Uint16Array;
  skinWeight?: ArrayBuffer | Float32Array | Uint16Array;
}

// === Asset error model SSOT (feat-20260511-asset-system-v1 / D-P1 / w3) =========
//
// Decision anchors:
// - requirements §G3 + AC-03 + AC-10 + AC-21 + §1 callout row 9 (4-member closed
//   `AssetErrorCode` independent from `RhiErrorCode`; `AssetError` class with
//   `.code / .expected / .hint / .message` four-field surface structurally
//   parallel to `RhiError` / `InspectorError` / `MetricError`)
// - plan-strategy §2 D-P1 (`@forgeax/engine-types` single-file SSOT for
//   AssetErrorCode; independent closed union aligned with
//   MetricErrorCode / InspectorErrorCode precedent)
// - plan-strategy §7.3 (per-code `.hint` string literals locked verbatim
//   below; any drift updates both this module and the test fixtures)
// - charter proposition 3 (machine-readable union > prose) + proposition 4
//   (explicit failure — `switch (err.code)` exhaustive without `default:`) +
//   proposition 5 (consistent abstraction — structurally parallel to
//   `@forgeax/engine-rhi` `RhiError` surface)
// - architecture-principles #1 SSOT (the 4 literals + class shape live here
//   once; M4 AssetRegistry / M3 Geometry factories / AGENTS.md §Error model
//   row all reference this module)

/**
 * Closed `AssetErrorCode` union — 22 members (D-P1 + feat-20260518 D-1 minor
 * evolution + feat-20260520-skylight-ibl-cubemap 5 members +
 * feat-20260523 mesh-upload-fix 1 member +
 * feat-20260523-shader-template-instance-split M1-T02 1 member +
 * feat-20260526-material-asset-multipass-renderstate M1 1 member +
 * feat-20260603-asset-import-loader-injection M1 2 members +
 * feat-20260604-hdr-equirect-cube-importer-loader M2 1 member +
 * feat-20260608-mesh-multi-section-primitive-multi-material-slot M1 3 members +
 * feat-20260621-asset-registry-robustness-invalidate-inflight-cach M2 1 member;
 * requirements §G3 + AC-03 + AC-21 +
 * feat-20260518 AC-02 + bug-20260523 AC-01).
 * Exhaustive `switch (err.code)` needs no default fallback — TypeScript guards
 * union completeness at compile time (charter F2/P2 machine-readable union >
 * prose + P3 explicit failure).
 *
 * Domain-separated from `RhiErrorCode 'asset-not-registered'` (which is a
 * render-time registry lookup miss, 18-member closed union in
 * `@forgeax/engine-rhi/src/errors.ts`). The two unions cover disjoint
 * lifecycle phases — AI users face only these 22 alternatives on the
 * `engine.assets.loadByGuid(guid)` / `engine.assets.get(handle)` /
 * `engine.assets.register(payload).unwrap()` surface.
 *
 * | code | trigger |
 * |:--|:--|
 * | `'asset-not-found'` | `AssetRegistry.get(handle)` returned no entry (handle never registered or registry was reset); charter P3 explicit failure. |
 * | `'asset-parse-failed'` | decoded bytes are not a valid image (PNG / JPG header corruption on the load path; dimensions <= 0 / segments < 1 on the procedural geometry constructor path — double semantics locked by requirements §9 "constructor path" extension). |
 * | `'asset-format-unsupported'` | URL content-type / magic bytes are neither PNG nor JPG (v1 scope; KTX2 / Basis / GLTF embedded textures deferred to M3+). |
 * | `'asset-fetch-failed'` | `fetch(url)` returned non-2xx, threw, or the URL was otherwise unreachable (404 / network / CORS surface). |
 * | `'asset-invalid-value'` | `register<MaterialAsset>(payload)` paramValues fails the 3-tier validator (type-mismatch / extra-key / missing-required) or `paramSchema[].type` is not in {@link MATERIAL_PARAM_TYPES} — fail-fast at register entry (feat-20260523-shader-template-instance-split M8-T01 + M1; charter P3 explicit failure structured `.code` / `.expected` / `.hint` / `.detail`). |
 * | `'cubemap-handle-missing'` | `IblPipelineCache` / cubemap upload when `Skylight.cubemap` handle is dangling; `.hint` suggests `uploadCubemapFromEquirect()`. |
 * | `'invalid-source-format'` | image importer path when `.hdr` decode needs rgba16float / rgba32float. |
 * | `'load-failed'` | `loadByGuid` when guid entry exists in catalog but file is inaccessible. |
 * | `'device-unsupported'` | GPU capability gate: `device.caps.rgba16floatRenderable` missing. |
 * | `'ibl-precompute-not-dispatched'` | `IblPipelineCache` when counter increments but `queue.submit` hasn't been called. |
 * | `'mesh-vertex-stride-mismatch'` | `register({ kind: 'mesh', ... })` vertices buffer is not evenly divisible by 12 floats per vertex (position vec3 + normal vec3 + uv vec2 + tangent vec4) or `maxIndex+1 !== vertexCount` — fail-fast at register entry (charter P3 structured failure; `.detail` carries `vertexCount` / `floatsPerVertex`). |
| `'material-circular-inheritance'` | material resolve detected a cycle in the parent chain; `.hint` carries the full cycle path (e.g. "A -> B -> A") via `err.detail.cycle`. |
 * | `'loader-not-registered'` | `loadByGuid` dispatched on `asset.kind` but the injected `LoaderRegistry` has no loader for that kind; `.detail.kind` is the missing kind and `.detail.registeredKinds` lists the kinds currently wired (feat-20260603-asset-import-loader-injection M1; charter P3 — AI users read `.detail.registeredKinds` to know what to inject). |
 * | `'asset-not-imported'` | `loadByGuid` found the GUID in the catalog but its DDC is absent and no `ImportTransport` is wired (shipped form); `.hint` points back to build-time pre-import rather than a runtime workaround (feat-20260603-asset-import-loader-injection M4; logic wired in M4 w31). |
 * | `'texture-source-not-imported'` | `loadTextureAsset` resolved a catalog texture row whose `relativeUrl` is a raw source (not a build-time-imported `.bin`); the runtime carries no decoder. This is an `AssetError` (not the `ImageError` `image-decode-failed`) so it is transport-eligible in `loadByGuidProd` -- the studio form lazily imports the `.bin` via the injected `ImportTransport`, the shipped form fails fast with `asset-not-imported`. A genuinely corrupt imported `.bin` still surfaces as `image-decode-failed` and is never routed through transport (feat-20260604-hdr-equirect-cube-importer-loader M2 / D-1). |
 */
export type AssetErrorCode =
  | 'asset-not-found'
  | 'asset-parse-failed'
  | 'asset-format-unsupported'
  | 'asset-fetch-failed'
  | 'asset-invalid-value'
  | 'cubemap-handle-missing'
  | 'invalid-source-format'
  | 'load-failed'
  | 'device-unsupported'
  | 'ibl-precompute-not-dispatched'
  | 'mesh-vertex-stride-mismatch'
  // === 1 new code (feat-20260523-shader-template-instance-split M1-T02) ===
  | 'material-shader-ref-broken'
  // === 1 new code (feat-20260526-material-asset-multipass-renderstate M1 / w6) ===
  | 'material-circular-inheritance'
  // === 2 new codes (feat-20260603-asset-import-loader-injection M1 / w1) ===
  | 'loader-not-registered'
  | 'asset-not-imported'
  // === 1 new code (feat-20260604-hdr-equirect-cube-importer-loader M2 / w4) ===
  | 'texture-source-not-imported'
  // === 3 new codes (feat-20260608-mesh-multi-section-primitive-multi-material-slot M1 / w2) ===
  | 'mesh-renderer-material-count-mismatch'
  | 'mesh-asset-submeshes-empty'
  | 'mesh-submesh-index-range-out-of-bounds'
  // === 1 new code (feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild) ===
  // Tileset region rectangle out of atlas extent OR tile entry regionIndex out of
  // regions array bounds (single closed code per plan-strategy §D-6 first-error
  // ordering). 19 -> 20 baseline-restored.
  | 'tileset-region-index-out-of-range'
  // === 1 new code (feat-20260608-tilemap-object-layer-rendering M1 schema extension) ===
  // Tile entry optional field (widthCells / heightCells / pivotX / pivotY /
  // collider) or top-level atlases / region.atlasIndex schema invariant
  // breached at register time. `.detail.field` carries the closed 7-variant
  // enum + `.scope?` is 'tile-entry' | 'tileset-asset' (plan-strategy §D-6;
  // charter P3 closed enum + AI-grep affordance). 20 -> 21 M1 net add.
  | 'tileset-tile-entry-malformed'
  // === 1 new code (feat-20260621-asset-registry-robustness-invalidate-inflight-cach M2 / w4) ===
  | 'asset-invalidated';

/**
 * Structured asset error -- four-field surface (`.code` / `.expected` /
 * `.hint` / `.message`) structurally parallel to `@forgeax/engine-rhi`
 * `RhiError` + `@forgeax/engine-remote` `InspectorError` + `MetricError`
 * (charter proposition 5 consistent abstraction; AGENTS.md "Errors are
 * structured. Return Result, never throw for expected failures.").
 *
 * AI users consume the structured triple via property access:
 * `switch (err.code) { case 'asset-fetch-failed': ... err.hint ... }`
 * -- never by parsing `.message` (charter proposition 4 explicit failure
 * red line).
 *
 * The `.message` field is auto-composed for human stack traces and carries
 * the same content as `.code` + `.expected` + `.hint`; AI users prefer
 * field access on the structured triple.
 *
 * @example AI-user exhaustive switch on the 22 members (no default fallback)
 * ```ts
 * import { AssetError, type AssetErrorCode } from '@forgeax/engine-types';
 *
 * function recover(code: AssetErrorCode): string {
 *   switch (code) {
 *     case 'asset-not-found':          return 'ensure handle was registered before get()';
 *     case 'asset-parse-failed':       return 'check file integrity or geometry dimensions';
 *     case 'asset-format-unsupported': return 'convert to PNG or JPG';
 *     case 'asset-fetch-failed':       return 'check url path or dev server';
 *     case 'asset-invalid-value':      return 'read err.hint / err.detail for the case-specific fix';
 *   }
 * }
 * ```
 */
export class AssetError extends Error {
  readonly code: AssetErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: Readonly<AssetErrorDetail>;

  constructor(args: {
    code: AssetErrorCode;
    expected: string;
    hint: string;
    detail?: Readonly<AssetErrorDetail>;
  }) {
    super(`[AssetError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'AssetError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    if (args.detail !== undefined) {
      this.detail = args.detail;
    }
  }
}

/**
 * Per-code `.hint` string literals (plan-strategy §7.3 lock-in). Exported
 * so M3 Geometry factories / M4 AssetRegistry / tests consume the same
 * SSOT — any drift here updates both producer call sites and the
 * AGENTS.md §Error model table.
 *
 * The shape is a `Record<AssetErrorCode, string>` so future additions to
 * the closed union are a compile-time error here as well (reinforces
 * charter proposition 4 explicit failure).
 */
export const ASSET_ERROR_HINTS: Readonly<Record<AssetErrorCode, string>> = {
  'asset-fetch-failed':
    'check url path; verify dev server is running; in tests use data: URL fixture (data:image/png;base64,...)',
  'asset-parse-failed':
    'check file bytes are not corrupted; for procedural geometry: verify all dimensions > 0 and segments >= 1',
  'asset-format-unsupported':
    'v1 supports png/jpg only; convert .bmp/.webp etc. via image tooling; gltf/glb supported via @forgeax/engine-gltf importer (forgeax-engine-remote-gltf import <gltf-or-glb>)',
  'asset-not-found':
    'handle id not in registry; verify register() was called before get(); inspect() returns all live handles',
  'asset-invalid-value':
    'a register-time value failed validation; read err.hint for the case-specific fix (e.g. clamp a MaterialAsset param to [0,1], or give a strip-topology MeshAsset an index buffer) and err.detail for the offending field/value',
  'cubemap-handle-missing':
    'await engine.assets.uploadCubemapFromEquirect(...) before spawning Skylight; cubemap handle must be resolved',
  'invalid-source-format':
    'decode .hdr via @forgeax/engine-image first; supported formats are rgba16float and rgba32float',
  'load-failed':
    'source asset could not be loaded; check GUID validity and file accessibility in the pack-index catalog',
  'device-unsupported':
    'GPU device lacks required capability; check device.caps for rgba16float renderable feature',
  'ibl-precompute-not-dispatched':
    'check IblPipelineCache.runIblPrecompute is called inside uploadCubemapFromEquirect; counters must not increment before queue.submit (plan D-7 / N-3 AC-20 invariant)',
  'mesh-vertex-stride-mismatch':
    'use meshFromInterleaved (packages/runtime/src/geometry/box.ts) or expand vertices buffer to canonical 12F layout (position vec3 + normal vec3 + uv vec2 + tangent vec4)',
  // === 1 new hint (feat-20260523-shader-template-instance-split M1-T02) ===
  'material-shader-ref-broken':
    'the materialShader identifier (path or GUID) resolves to no registered shader; check ShaderRegistry for path identifiers or AssetRegistry for GUID sub-assets',
  // === 1 new hint (feat-20260526-material-asset-multipass-renderstate M1 / w6) ===
  'material-circular-inheritance':
    'circular parent chain detected; inspect parent handles — use err.detail.cycle to see the full path (e.g. "A -> B -> A")',
  // === 2 new hints (feat-20260603-asset-import-loader-injection M1 / w1) ===
  'loader-not-registered':
    'no loader registered for this asset kind; register it via engine.assets.loaders.register(loader) (the loader carries its own kind); err.detail.registeredKinds lists the kinds currently wired',
  'asset-not-imported':
    'GUID is in the catalog but its DDC artefact is missing and no ImportTransport is wired (shipped form never falls back to a runtime import); add the asset to the build-time pre-import step instead of importing at runtime',
  // === 1 new hint (feat-20260604-hdr-equirect-cube-importer-loader M2 / w4) ===
  'texture-source-not-imported':
    'texture source not imported yet; wire createDevImportTransport() in the studio form for dev lazy-import, or pre-import via the build-time pipeline',
  // === 3 new hints (feat-20260608-mesh-multi-section-primitive-multi-material-slot M1 / w2) ===
  'mesh-renderer-material-count-mismatch':
    'materials.length must equal submeshes.length; got materials=N, submeshes=M, meshAssetGuid=...; ensure MeshRenderer.materials arrays are equal-length to MeshAsset.submeshes arrays',
  'mesh-asset-submeshes-empty':
    'MeshAsset.submeshes must have at least one entry; every mesh must declare at least one submesh; check MeshAsset registration payload for empty submeshes array',
  'mesh-submesh-index-range-out-of-bounds':
    'submesh indexOffset + indexCount exceeds the parent mesh index buffer length; check submesh index range bounds against MeshAsset.indices and MeshAsset.vertices; err.detail carries submeshIndex, indexOffset, indexCount, indexBufferLength, and meshAssetGuid',
  // === 1 new hint (feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild) ===
  'tileset-region-index-out-of-range':
    'a TilesetAsset.regions[] rectangle escapes the atlas extent OR a TilesetAsset.tiles[].regionIndex points past TilesetAsset.regions.length; check regions[i] (x + width <= atlasWidth, y + height <= atlasHeight) and tiles[i].regionIndex in [0, regions.length); err.detail carries tilesetGuid, tileId, regionIndex, regionCount',
  // === 1 new hint (feat-20260608-tilemap-object-layer-rendering M1 schema extension) ===
  'tileset-tile-entry-malformed':
    'a TilesetTileEntry optional field is out of range (widthCells / heightCells in (0, 64], pivotX / pivotY in [0, 1], collider rect/polygon in normalized [0,1]^2 with rect.length === 4 and polygon.points.length >= 3) OR a top-level field is out of range (atlases.length >= 1, region.atlasIndex in [0, atlases.length)); engine fail-fast at register-time. read err.detail.field (closed enum) + err.detail.scope (tile-entry | tileset-asset) + err.detail.tileEntryIndex to locate the offending entry; switch (err.detail.field) covers the 7 variants exhaustively without default',
  // === 1 new hint (feat-20260621-asset-registry-robustness-invalidate-inflight-cach M2 / w4) ===
  'asset-invalidated':
    'The asset was invalidated during load; call loadByGuid(guid) again to retry with a fresh fetch',
};

// === Font error model SSOT (feat-20260531-world-space-msdf-text-rendering M2 / w6) ===
//
// Decision anchors:
//   - plan-strategy D-11 (two closed unions: FontErrorCode = build/load phase,
//     TextErrorCode = runtime layout phase; structured .code/.expected/.hint/.detail;
//     TOFU is rendering behaviour not an error — AC-14)
//   - requirements AC-15 (non-TTF -> FontErrorCode 'unsupported-font-format')
//   - requirements AC-16 (both unions in types/src/index.ts; exhaustive
//     switch(err.code) without default compiles)
//   - requirements AC-20 (font concurrency > 8 -> TextErrorCode
//     'font-concurrency-exceeded')
//   - charter P3 (explicit failure: structured error > silent behaviour,
//     D-8 rejects silent LRU eviction for concurrency violation)
//
// Domain separation: FontErrorCode covers build-time bake failures and
// load-time atlas/sampler resolution; TextErrorCode covers runtime glyph
// layout and text rendering failures.

/**
 * Closed `FontErrorCode` union — build-time bake + load-time resolution
 * errors (plan-strategy D-11).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'unsupported-font-format'` | bake receives non-TTF input (OTF / WOFF2); `.expected: 'ttf'` (AC-15) |
 * | `'font-atlas-missing'` | loadByGuid font handle has missing/empty atlas texture GUID |
 * | `'font-atlas-corrupted'` | sidecar JSON parse failed or glyph metrics shape invalid |
 * | `'bake-failed'` | @zappar/msdf-generator call threw (wasm unavailable / internal error) |
 */
export type FontErrorCode =
  | 'unsupported-font-format'
  | 'font-atlas-missing'
  | 'font-atlas-corrupted'
  | 'bake-failed';

/**
 * Closed `TextErrorCode` union — runtime glyph layout and text rendering
 * errors (plan-strategy D-11).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'font-concurrency-exceeded'` | > 8 distinct FontAsset handles active in one frame; `.expected: 8` (AC-20) |
 * | `'font-atlas-missing'` | glyph layout system resolved fontHandle but atlas texture is not yet uploaded |
 * | `'glyph-layout-failed'` | layout computation encountered unexpected state (empty common block, etc.) |
 */
export type TextErrorCode =
  | 'font-concurrency-exceeded'
  | 'font-atlas-missing'
  | 'glyph-layout-failed';

/**
 * Structured font error — four-field surface (`.code` / `.expected` /
 * `.hint` / `.message`) in the style of {@link AssetError}.
 *
 * AI users consume via property access:
 * `switch (err.code) { case 'unsupported-font-format': ... err.expected ... }`
 * — never by parsing `.message`.
 */
export class FontError extends Error {
  readonly code: FontErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(args: {
    code: FontErrorCode;
    expected: string;
    hint: string;
    detail?: Readonly<Record<string, unknown>>;
  }) {
    super(`[FontError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'FontError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    if (args.detail !== undefined) {
      this.detail = args.detail;
    }
  }
}

/**
 * Structured text error — four-field surface (`.code` / `.expected` /
 * `.hint` / `.message`) in the style of {@link AssetError}.
 *
 * AI users consume via property access:
 * `switch (err.code) { case 'font-concurrency-exceeded': ... err.hint ... }`
 * — never by parsing `.message`.
 */
export class TextError extends Error {
  readonly code: TextErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(args: {
    code: TextErrorCode;
    expected: string;
    hint: string;
    detail?: Readonly<Record<string, unknown>>;
  }) {
    super(`[TextError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'TextError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    if (args.detail !== undefined) {
      this.detail = args.detail;
    }
  }
}

// === AssetErrorDetail discriminated union (feat-20260523-shader-template-instance-split M1-T02) ===
//
// Introduced to type-narrow the AssetError.detail field for the new
// 'material-shader-ref-broken' variant. Existing AssetErrorCode members
// keep their Record<string, unknown> detail shapes; the union is
// backward-compatible because the detail field on AssetError is optional.

/**
 * Detail for `material-shader-ref-broken` — materialShader identifier
 * (path or GUID) could not be resolved to a registered shader.
 */
export interface AssetMaterialShaderRefBrokenDetail {
  readonly code: 'material-shader-ref-broken';
  readonly materialAssetGuid: string;
  readonly missingShaderId: string;
  readonly materialShaderPath?: string;
}

/**
 * Detail for `tileset-region-index-out-of-range` (feat-20260608 M0 baseline rebuild).
 *
 * Carries the offending tileset GUID + tile-entry index + the rejected
 * `regionIndex` + the live `regionCount` so AI consumers can pinpoint
 * the malformed payload field via property access (charter P3 / P4).
 *
 * Surfaced by `validateTilesetPayload` along two paths:
 *   - region rectangle escapes the parent atlas extent
 *     (regionIndex == the offending rectangle index).
 *   - `tiles[i].regionIndex` >= `regions.length` (or negative)
 *     (tileId encodes which entry; regionIndex carries the rejected value).
 */
export interface AssetTilesetRegionIndexOutOfRangeDetail {
  readonly code: 'tileset-region-index-out-of-range';
  readonly tilesetGuid: string;
  readonly tileId: number;
  readonly regionIndex: number;
  readonly regionCount: number;
}

/**
 * Detail for `tileset-tile-entry-malformed` (feat-20260608 M1 schema
 * extension; plan-strategy §D-6).
 *
 * Closed 7-variant `.field` enum locks the AI-grep affordance: switch
 * (detail.field) over the union compiles without default (charter P3).
 *
 *   - `widthCells` -- `tiles[i].widthCells` out of `(0, 64]`.
 *   - `heightCells` -- `tiles[i].heightCells` out of `(0, 64]`.
 *   - `pivotX` -- `tiles[i].pivotX` out of `[0, 1]`.
 *   - `pivotY` -- `tiles[i].pivotY` out of `[0, 1]`.
 *   - `collider` -- `tiles[i].collider` schema invariant (rect.length !==
 *     4 / rect dimension out of `[0, 1]^2` / polygon.points.length < 3 /
 *     any point out of `[0, 1]^2` / type discriminator outside the closed
 *     3-variant enum).
 *   - `atlases` -- top-level `atlases.length < 1` (empty atlas list).
 *   - `atlasIndex` -- `regions[i].atlasIndex` outside `[0, atlases.length)`.
 *
 * `.scope?` is `'tile-entry'` when the violation is in `tiles[i].*` (in
 * which case `.tileEntryIndex` carries the offending `tiles[]` index) and
 * `'tileset-asset'` when the violation is at the top level (atlases /
 * region atlasIndex).
 */
export interface AssetTilesetTileEntryMalformedDetail {
  readonly code: 'tileset-tile-entry-malformed';
  readonly field:
    | 'widthCells'
    | 'heightCells'
    | 'pivotX'
    | 'pivotY'
    | 'collider'
    | 'atlases'
    | 'atlasIndex';
  readonly scope?: 'tileset-asset' | 'tile-entry';
  readonly tileEntryIndex?: number;
  readonly tilesetGuid: string;
  readonly expected?: string;
  readonly hint?: string;
}

/**
 * Discriminated detail union for AssetError, narrowed per AssetErrorCode.
 *
 * Variants:
 * - `material-shader-ref-broken` -- materialShader identifier (path or GUID)
 *   could not be resolved to a registered shader; carries materialAssetGuid +
 *   missingShaderId.
 * - `asset-invalid-value` -- a register-time value failed validation;
 *   carries `{ field: string; got: unknown }`.
 * - `mesh-renderer-material-count-mismatch` -- materials.length !=
 *   submeshes.length; carries `{ expectedCount, actualCount, meshAssetGuid }`.
 * - `mesh-asset-submeshes-empty` -- MeshAsset.submeshes is empty array;
 *   carries `{ meshAssetGuid }`.
 * - `mesh-submesh-index-range-out-of-bounds` -- submesh index range exceeds
 *   parent mesh index buffer; carries `{ submeshIndex, indexOffset,
 *   indexCount, indexBufferLength, meshAssetGuid }`.
 */
export type AssetErrorDetail =
  | AssetMaterialShaderRefBrokenDetail
  | AssetTilesetRegionIndexOutOfRangeDetail
  | AssetTilesetTileEntryMalformedDetail
  | { readonly field: string; readonly got: unknown }
  | { readonly field: string; readonly value: unknown; readonly reason: string }
  | { readonly expectedCount: number; readonly actualCount: number; readonly meshAssetGuid: string }
  | { readonly meshAssetGuid: string }
  | {
      readonly submeshIndex: number;
      readonly indexOffset: number;
      readonly indexCount: number;
      readonly indexBufferLength: number;
      readonly meshAssetGuid: string;
    }
  // Pre-existing detail shapes used by AssetRegistry / loaders / pipeline-builder
  // (added in M5 / w27 alongside the count-mismatch tightening so the union
  // accommodates every current call site without losing structural narrowing).
  | { readonly sourcePath: string }
  | { readonly kind: string; readonly registeredKinds?: readonly string[] }
  | { readonly key: string; readonly legalPattern: string }
  | { readonly passCount: number }
  | {
      readonly passIndex: number;
      readonly shaderKey: string;
      readonly cause: string;
    }
  | { readonly paramName: string; readonly expectedType: string; readonly got: unknown }
  | { readonly paramName: string; readonly got: unknown }
  | { readonly missingParams: readonly string[] }
  | { readonly cycle: string }
  | {
      readonly localId: number;
      readonly component: string;
      readonly field: string;
      readonly index: number;
      readonly refsLength: number;
    }
  | { readonly vertexCount: number; readonly floatsPerVertex: number }
  // feat-20260622 verify r1: sub-asset load-failure breadcrumb in structured
  // form. The recursive loader composes the same provenance into the `.hint`
  // string; this variant additionally exposes it for property access so AI
  // users locate the broken edge without parsing the hint (charter P3,
  // requirements section error-self-recovery). `sourceField`/`sceneEntityId`
  // mirror the originating AssetRef edge; both undefined for transitive
  // (texture) edges with no per-entity origin (D-2).
  | {
      readonly referencedByGuid: string;
      readonly referencedByKind: string;
      readonly subAssetGuid: string;
      readonly sceneEntityId?: number;
      readonly sourceField?: {
        readonly componentName?: string;
        readonly fieldName: string;
        readonly arrayIndex?: number;
      };
    };

// === Image importer error model SSOT (feat-20260515-learn-render-getting-started M2 T-M2-04) ===
//
// Decision anchors:
// - requirements AC-12 (ImageErrorCode 4-member independent closed union; not
//   merged into AssetErrorCode) + AC-26 (ImageMeta + DecodedImage POD types
//   exported from @forgeax/engine-types so producer (image importer) +
//   consumer (runtime AssetRegistry.uploadTexture) share one schema)
// - plan-strategy section 2.3 D-12 (image importer error closed union 4
//   members independent from AssetErrorCode 4 members; structurally
//   parallel to GltfErrorCode 7 / ShaderErrorCode 7 same-shape errors)
// - plan-strategy section 2.5 D Open Q-4 selected (c) (TextureAsset.format
//   <-> colorSpace consistency assertion; conflict surfaces via
//   image-format-unsupported.detail.formatColorSpaceConflict optional sub-shape)
// - plan-strategy section 3.3 error path 1 (sidecar three-way fallback path
//   (a) image-meta-missing) + error path 2 (format-unsupported with conflict)
// - charter proposition 3 (machine-readable union > prose) + proposition 4
//   (explicit failure: switch (err.code) exhaustive without default; tsc
//   guards completeness) + proposition 5 (consistent abstraction:
//   structurally parallel to AssetError / RhiError / ShaderError four-field
//   surface)
// - architecture-principles #1 SSOT (4 literals + 4 detail shapes + 5-field
//   ImageMeta + 6-field DecodedImage live here once; @forgeax/engine-image
//   errors.ts class implementation references this module; AGENTS.md
//   Error model row references this module)

/**
 * Closed `ImageErrorCode` union -- 4 members (plan-strategy section 2.3 D-12;
 * requirements AC-12). Exhaustive `switch (err.code)` needs no default
 * fallback -- TypeScript guards union completeness at compile time
 * (charter proposition 4 explicit failure + proposition 3 machine-readable
 * union > prose).
 *
 * Independent from the 4-member `AssetErrorCode`; image importer errors
 * cover the disk-to-memory translation phase exclusively (charter P5
 * producer / consumer split). The runtime `AssetRegistry.uploadTexture`
 * surface returns `Result<void, ImageError | RhiError>` because it bridges
 * image importer errors (consistency assertion fail-fast) and the GPU
 * upload path (RHI errors).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'image-decode-failed'` | UPNG / jpeg-js threw on the byte stream (corrupt PNG / JPG; charter proposition 4 explicit failure). |
 * | `'image-format-unsupported'` | mime not in `['image/png', 'image/jpeg']`; OR uploadTexture entry detected `format='*-srgb' <-> colorSpace='linear'` mismatch (plan-strategy section 2.5 D Open Q-4 (c)). |
 * | `'image-dimension-out-of-bounds'` | width or height exceeds device caps `maxTextureDimension2D` (or hard 16k cap when caps absent). |
 * | `'image-meta-missing'` | source file exists but `<source>.meta.json` sidecar absent in same directory (path (a) of three-way fallback per AC-17). |
 */
export type ImageErrorCode =
  | 'image-decode-failed'
  | 'image-format-unsupported'
  | 'image-dimension-out-of-bounds'
  | 'image-meta-missing'
  | 'image-hdr-decode-failed'
  // feat-20260521-sprite-atlas-animation M1 T-02 — vite-plugin-image atlas
  // hook fail-fast SSOT (plan-strategy section 2 D-2; add-only minor per
  // AGENTS.md section Error model evolution contract; research F-7
  // candidate B). The three members cover the AC-10 (a/b/c) build-time
  // invariants — empty glob match (a), single image larger than the atlas
  // cap (b), and a region-pack safety net when shelfPack regions overflow
  // the atlas footprint (c). All three reuse ImageErrorImpl + IMAGE_ERROR_*
  // SSOT tables (no new error class, no new error union — charter P4
  // consistent abstraction; AI users keep one switch (err.code) shape).
  | 'atlas-empty-input'
  | 'atlas-size-exceeded'
  | 'atlas-region-mismatch';

/**
 * Discriminated detail union for `ImageError` -- narrowed per `ImageError.code`
 * (plan-strategy section 2.3 D-12 + section 2.5 D Open Q-4 (c)).
 *
 * AI users access `err.detail.<field>` directly after `switch (err.code)`
 * narrows the variant -- never by parsing `.message` (charter proposition 4
 * explicit failure red line).
 *
 * The detail shapes:
 * - `image-decode-failed -> { reason, path? }` -- `reason` carries the
 *   underlying decoder error message; `path` may be empty for in-memory
 *   parseImage calls (the file-system entry decodeImageFromFile fills it in).
 * - `image-format-unsupported -> { actualMime, path?, formatColorSpaceConflict? }`
 *   -- `actualMime` is the rejected mime; optional
 *   `formatColorSpaceConflict` carries `{ format, colorSpace, expected }`
 *   when uploadTexture surfaced a `format <-> colorSpace` mismatch
 *   (plan-strategy section 2.5 D Open Q-4 (c) extension).
 * - `image-dimension-out-of-bounds -> { requested: {width,height}, limit }`
 *   -- numeric verdict, no parsing required.
 * - `image-meta-missing -> { sourcePath, expectedSidecarPath }` --
 *   AI users surface both paths in stderr / IDE jump-to-source.
 */
export type ImageErrorDetail =
  | {
      readonly code: 'image-decode-failed';
      readonly reason: string;
      readonly path?: string;
    }
  | {
      readonly code: 'image-format-unsupported';
      readonly actualMime: string;
      readonly path?: string;
      readonly formatColorSpaceConflict?: {
        readonly format: string;
        readonly colorSpace: 'srgb' | 'linear';
        readonly expected: 'srgb' | 'linear';
      };
    }
  | {
      readonly code: 'image-dimension-out-of-bounds';
      readonly requested: { readonly width: number; readonly height: number };
      readonly limit: number;
    }
  | {
      readonly code: 'image-meta-missing';
      readonly sourcePath: string;
      readonly expectedSidecarPath: string;
    }
  | {
      readonly code: 'image-hdr-decode-failed';
      readonly reason: string;
      readonly path?: string;
    }
  // feat-20260521-sprite-atlas-animation M1 T-02 — atlas hook fail-fast
  // detail SSOT (1:1 with requirements section AC-10 a/b/c).
  //
  // `atlas-empty-input -> { receivedCount }` — fast-glob produced zero
  //   matches; AI users read `.detail.receivedCount` and inspect the
  //   `atlas.input` glob string against the on-disk layout.
  // `atlas-size-exceeded -> { name, width, height, maxAtlasSize }` — a
  //   single source PNG cannot fit inside the cap; AI users compare
  //   `.detail.width` * `.detail.height` against `.detail.maxAtlasSize`^2
  //   and either downscale the source or split the atlas (the hint string
  //   in IMAGE_ERROR_HINTS spells the copy-pasteable recovery commands).
  // `atlas-region-mismatch -> { name, regionsTotalPixels, atlasPixels }` —
  //   shelfPack returned a region map whose summed area exceeds the atlas
  //   footprint; algorithm safety net (plan-strategy section 2 D-4 future
  //   MaxRects swap keeps this invariant), so AI users normally never see
  //   this code outside of a packer regression.
  | {
      readonly code: 'atlas-empty-input';
      readonly receivedCount: number;
    }
  | {
      readonly code: 'atlas-size-exceeded';
      readonly name: string;
      readonly width: number;
      readonly height: number;
      readonly maxAtlasSize: number;
    }
  | {
      readonly code: 'atlas-region-mismatch';
      readonly name: string;
      readonly regionsTotalPixels: number;
      readonly atlasPixels: number;
    };

/**
 * Structural shape of a forgeax image error (M2 T-M2-04). Four-field surface
 * (`.code` / `.expected` / `.hint` / `.detail`) structurally parallel to
 * `@forgeax/engine-rhi` `RhiError` + `@forgeax/engine-types` `AssetError` +
 * `MetricError` (charter proposition 5 consistent abstraction; AGENTS.md
 * "Errors are structured. Return Result, never throw for expected failures").
 *
 * AI users perform a single `switch (err.code)` over the 4 members and pick
 * up `err.detail.<per-code-field>` with full IDE autocomplete (charter
 * proposition 3 machine-readable union > prose; AI-user review F-1
 * affordance).
 *
 * The interface intentionally extends `Error` so a runtime `ImageError`
 * **class** (defined in `@forgeax/engine-image/errors`) satisfies the
 * contract without re-declaring inherited `name` / `message` slots.
 */
export interface ImageError extends Error {
  readonly code: ImageErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ImageErrorDetail;
}

/**
 * Per-code `.hint` string literals SSOT (plan-strategy section 2.3 / Tier 2
 * documentation). `Record<ImageErrorCode, string>` ensures compile-time
 * completeness; any future minor add to `ImageErrorCode` raises a TS error
 * on this map until the matching hint is supplied (charter proposition 4
 * explicit failure -- producer/consumer + reviewer all see the missing arm).
 *
 * Each hint embeds an executable command so AI users self-recover by
 * copy-pasting the hint into the shell (plan-strategy Tier 2 "hint must
 * carry forgeax-engine-remote-image import <path>" or similar; the image
 * plugin bin lands in feat-future-console-plugin-image — until then the
 * hint references the in-package importer surface).
 */
export const IMAGE_ERROR_HINTS: Readonly<Record<ImageErrorCode, string>> = {
  'image-decode-failed':
    'check file integrity; re-export from DCC tool (Photoshop / GIMP / Aseprite); dimensions > 0 + valid PNG / JPG header bytes',
  'image-format-unsupported':
    'v1 supports PNG / JPG only; convert with: cwebp / magick convert <input> <output>.png; check importSettings.colorSpace consistency with format family if formatColorSpaceConflict present',
  'image-dimension-out-of-bounds':
    'downscale source under device caps (typical maxTextureDimension2D = 8192 / 16384); use mipmap chain instead of larger source if lod is the goal',
  'image-meta-missing': 'run: forgeax-engine-remote-asset import <path>',
  'image-hdr-decode-failed':
    'check .hdr file integrity; verify Radiance RGBE header magic (#?RADIANCE) and FORMAT=32-bit_rle_rgbe header field; ensure file was not truncated',
  // feat-20260521-sprite-atlas-animation M1 T-02 — atlas hook hint strings
  // (plan-strategy section 2 D-2). Each hint embeds an executable recovery
  // path so AI users self-repair by copy-pasting the hint into the shell
  // or into the build config (charter P3 explicit failure + AGENTS.md
  // Error model "hint must carry executable recovery").
  'atlas-empty-input':
    'verify forgeax-engine-remote-asset atlas --input <glob> --name <prefix> --output <dir> matches at least 1 PNG on disk; run `ls <glob>` to inspect the resolved file set; add the missing sprite source or fix the glob pattern',
  'atlas-size-exceeded':
    'downscale the source PNG so width * height <= maxAtlasSize^2 (default 4096); or split sprites across multiple atlas runs (forgeax-engine-remote-asset atlas --input <subset-glob> --name <other-prefix> --output <dir>); or raise the cap via --max-atlas-size 8192 if device caps allow it',
  'atlas-region-mismatch':
    'shelfPack returned regions exceeding atlas footprint — packer safety net; file a forgeax-engine bug; rerun forgeax-engine-remote-asset atlas with a smaller input set or lower --max-atlas-size as temporary recovery',
};

/**
 * Image color-space discriminator (plan-strategy section 2.5 D Open Q-4 (c)).
 *
 * `'srgb'` -- baseColor / albedo authored in sRGB display space; uploaded
 * with `format='*-srgb'` so hardware applies the gamma decode automatically
 * (research F-3 spec guarantee for mipmap blits).
 *
 * `'linear'` -- normal / metallic / roughness / data textures authored in
 * linear color space; uploaded with `format='*-unorm'` (no gamma transform).
 */
export type ImageColorSpace = 'srgb' | 'linear';

/**
 * Image importer settings POD (plan-strategy section 2.2 D-4 image disk
 * schema; AC-26). 5-field free-form object persisted into the `*.meta.json`
 * `importSettings` field; the GUID lives at the top of the POD so consumers
 * (importer + runtime + console asset import) share one schema (charter
 * proposition 5 consistent abstraction).
 *
 * Fields:
 * - `guid` -- string-form RFC 4122 dash-form UUID identifying the single
 *   image sub-asset (image disk schema is currently single-sub-asset by
 *   design; cubemap face / array layer reserved for future feat).
 * - `colorSpace` -- `'srgb' | 'linear'` (drives uploadTexture format
 *   selection; plan-strategy section 2.5).
 * - `mipmap` -- `'auto' | 'none'` (`'auto'` enables runtime mipmap-generator
 *   blit chain; `'none'` ships a single mip level).
 * - `addressMode` -- WGPU address mode for sampler (passed through to
 *   uploadTexture's sampler descriptor).
 * - `filterMode` -- magFilter / minFilter selector.
 *
 * The shape stays free-form `Record<string, unknown>` compatible at the
 * `*.meta.json` `importSettings` slot (research F-9 -- meta.schema.json
 * does not lock importSettings sub-shape; minor add of new fields is
 * non-breaking; plan-strategy R5 risk-free).
 */
export interface ImageMeta {
  readonly guid: string;
  readonly colorSpace: ImageColorSpace;
  readonly mipmap: 'auto' | 'none';
  readonly addressMode: 'repeat' | 'clamp-to-edge' | 'mirror-repeat';
  readonly filterMode: 'nearest' | 'linear';
}

/**
 * Decoded image POD (plan-strategy section 2.2 + section 3.3; AC-26).
 * Producer: `@forgeax/engine-image` parseImage / decodeImageFromFile.
 * Consumer: `@forgeax/engine-runtime` AssetRegistry.uploadTexture (M3).
 *
 * Six-field tight-packed shape:
 * - `bytes` -- decoded pixel buffer (RGBA tight-packed; 4 bytes per pixel).
 *   Producer guarantees `bytes.length === width * height * 4`.
 * - `width` / `height` -- pixel dimensions (must satisfy device caps
 *   `maxTextureDimension2D` floor; surfaced as `image-dimension-out-of-bounds`
 *   when exceeded).
 * - `mime` -- discriminator over the supported set (`'image/jpeg' | 'image/png'`);
 *   keeps the runtime side from sniffing magic bytes.
 * - `colorSpace` -- carried over from `ImageMeta.colorSpace`; uploadTexture
 *   asserts `format <-> colorSpace` consistency at the GPU upload entry
 *   (plan-strategy section 2.5 D Open Q-4 (c)).
 * - `mipmap` -- boolean derived from `ImageMeta.mipmap === 'auto'`; the
 *   runtime mipmap-generator skips the blit chain when false.
 *
 * Math-free POD; no Float32Array / branded handle on this shape (charter
 * proposition 5 consistent abstraction with TextureAsset POD).
 */
export interface DecodedImage {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly mime: 'image/jpeg' | 'image/png';
  readonly colorSpace: ImageColorSpace;
  readonly mipmap: boolean;
}

// === AssetGuid — disk-layer GUID brand type (feat-20260513-guid-asset-package-system) ===========
//
// Type-only declaration. Implementation (parse / format / equals / random) lives in
// @forgeax/engine-pack/guid. The brand field is a phantom string literal that prevents
// accidental assignment from plain Uint8Array or string at compile time.

/** 16-byte UUID brand for disk-layer asset identification. RFC 4122 UUIDv7 wire form. */
export type AssetGuid = Uint8Array & { readonly __guidBrand: 'AssetGuid' };

// === PackErrorCode / PackErrorDetail — disk-layer error SSOT (feat-20260513-guid-asset-package-system w15) ===
//
// Decision anchors:
// - requirements §6.1 (13-member closed union literal set SSOT; widened from
//   the original 8 by feat-20260523-shader-template-instance-split (+1) and
//   feat-20260608-scene-nesting-ecs-fication M1 / w8 (+4))
// - requirements §6.2 AC-05/07 (per-code discriminated detail)
// - plan-strategy §D-5 (PackError 4-field surface + check-pack-error-detail-narrowed.mjs guard)
// - AGENTS.md §Error model (structurally parallel to AssetErrorCode / InspectorErrorCode)

/**
 * Closed PackErrorCode union — 15 members.
 * Used exclusively by the @forgeax/engine-pack scanner fail-fast chain.
 *
 * | code | trigger |
 * |:--|:--|
 * | `'pack-malformed-meta'` | .meta.json fails ajv schema validation |
 * | `'pack-malformed-pack'` | .pack.json fails ajv schema validation |
 * | `'pack-guid-malformed'` | a GUID field is not a valid 36-char RFC 4122 dash-form string |
 * | `'pack-orphan-meta'` | .meta.json exists but the corresponding source file does not |
 * | `'pack-meta-missing'` | source file exists but no .meta.json (strict mode) |
 * | `'pack-guid-collision'` | two .pack.json files declare the same GUID |
 * | `'pack-cyclic-reference'` | asset refs[] (incl. mount.source) form a cycle |
 * | `'pack-subasset-index-out-of-range'` | subAsset.sourceIndex >= source count |
 * | `'payload-schema-mismatch'` | material payload fails materialShader / paramSchema schema |
 * | `'pack-mount-localid-overlap'` | mount memberFirst windows overlap or collide with entities[] |
 * | `'pack-mount-count-mismatch'` | mount memberCount disagrees with referenced child SceneAsset |
 * | `'pack-mount-override-localid-out-of-range'` | override.localId outside the mount's member window |
 * | `'pack-mount-override-unknown-field'` | override.comp / override.field unknown to the schema vocab |
 * | `'pack-unknown-path'` | @name references a name not declared in package.json#forgeax.assets.paths |
 * | `'pack-malformed-path-ref'` | source starts with @ but does not match @<name>/<rest> format, or resolves to a path outside the declared directory |
 *
 * Membership history: 8 -> 9 added 'payload-schema-mismatch' (feat-20260523
 * shader-template-instance-split); 9 -> 13 adds the four mount-* codes
 * (feat-20260608-scene-nesting-ecs-fication M1 / w8, plan-strategy D-8 literals
 * locked); 13 -> 15 adds 'pack-unknown-path' + 'pack-malformed-path-ref'
 * (feat-20260625-asset-meta-source-mount-prefix M1 / w1).
 */
export type PackErrorCode =
  | 'pack-malformed-meta'
  | 'pack-malformed-pack'
  | 'pack-guid-malformed'
  | 'pack-orphan-meta'
  | 'pack-meta-missing'
  | 'pack-guid-collision'
  | 'pack-cyclic-reference'
  | 'pack-subasset-index-out-of-range'
  // === 1 new code (feat-20260523-shader-template-instance-split M1-T02) ===
  | 'payload-schema-mismatch'
  // === 4 new codes (feat-20260608-scene-nesting-ecs-fication M1 / w8;
  // plan-strategy D-8 literals locked) ===
  | 'pack-mount-localid-overlap'
  | 'pack-mount-count-mismatch'
  | 'pack-mount-override-localid-out-of-range'
  | 'pack-mount-override-unknown-field'
  // === 2 new codes (feat-20260625-asset-meta-source-mount-prefix M1 / w1) ===
  | 'pack-unknown-path'
  | 'pack-malformed-path-ref';

/**
 * Discriminated detail union for PackError — narrowed per PackError.code.
 * AI users access `err.detail.<field>` directly after switch (err.code) narrows
 * the variant. Variants without an own `code` field are narrowed exclusively by
 * the top-level `PackError.code` discriminant (the legacy 7 variants below);
 * variants that carry a `code` field (`payload-schema-mismatch`, the evolved
 * `pack-cyclic-reference`, and the four mount-* additions) double-narrow via
 * `Extract<PackErrorDetail, { code: ... }>` at the type layer (R10).
 *
 * Structurally parallel to RhiErrorDetail / MetricErrorDetail.
 */
export type PackErrorDetail =
  | {
      /** Absolute or relative path to the malformed .meta.json file. */
      readonly path: string;
      /** ajv validation errors produced by validateMeta(). */
      readonly ajvErrors: readonly { readonly instancePath: string; readonly message: string }[];
    }
  | {
      /** Absolute or relative path to the malformed .pack.json file. */
      readonly path: string;
      /** ajv validation errors produced by validatePack(). */
      readonly ajvErrors: readonly { readonly instancePath: string; readonly message: string }[];
      /**
       * Optional human-readable reason category. Set to a fixed literal for
       * the runtime instantiate-path SceneEntity field-name typo route:
       * `'unknown component field'` (requirements §AC-08(b)). Absent on
       * scanner-path ajv-validation failures (where the structural
       * ajvErrors[].message string already carries the diagnostic).
       */
      readonly reason?: string;
    }
  | {
      /** The raw string value that failed UUID validation. */
      readonly raw: string;
      /** Human-readable reason (e.g. 'expected 36-char RFC 4122 dash-form UUID'). */
      readonly reason: string;
    }
  | {
      /** Path of the .meta.json that has no corresponding source file. */
      readonly metaPath: string;
      /** Path that was expected to exist as a source file. */
      readonly expectedFile: string;
    }
  | {
      /** Path of the source file that has no accompanying .meta.json. */
      readonly filePath: string;
    }
  | {
      /** The two .pack.json paths that both declare the same GUID (tuple, always length 2). */
      readonly paths: readonly [string, string];
      /** The colliding GUID dash-form string. */
      readonly guid: string;
    }
  // === Evolved variant (feat-20260608-scene-nesting-ecs-fication M1 / w8;
  // plan-strategy R10): pack-cyclic-reference now carries `code` + `kind` so
  // the build-time scanner (kind: 'mount-asset', cycle: GUID list) and the
  // runtime ChildOf detector (kind: 'childof', cycle: LocalEntityId list) stay
  // narrowable from a single error code. ===
  | {
      readonly code: 'pack-cyclic-reference';
      /**
       * Cycle origin tag: 'childof' for runtime ChildOf relationship cycles
       * (LocalEntityId stringified), 'mount-asset' for build-time
       * SceneAsset.mounts[].source GUID cycles (D-1).
       */
      readonly kind: 'childof' | 'mount-asset';
      /** Cycle path as ordered identifier strings; first === last. */
      readonly cycle: readonly string[];
    }
  | {
      /** Path of the .meta.json declaring the out-of-range sourceIndex. */
      readonly metaPath: string;
      /** The declared sourceIndex value. */
      readonly sourceIndex: number;
      /** The maximum valid sourceIndex (exclusive upper bound = source count). */
      readonly max: number;
    }
  // === 1 new variant (feat-20260523-shader-template-instance-split M1-T02) ===
  | {
      /** Discriminated code for material payload schema mismatch. */
      readonly code: 'payload-schema-mismatch';
      /** GUID of the offending material asset. */
      readonly guid: string;
      /** ajv validation errors for the material payload. */
      readonly errors: readonly { readonly instancePath: string; readonly message: string }[];
    }
  // === 4 new variants (feat-20260608-scene-nesting-ecs-fication M1 / w8;
  // plan-strategy D-8 literals locked; AC-04 / AC-05 / AC-06 / AC-07) ===
  | {
      readonly code: 'pack-mount-localid-overlap';
      /** Overlapping LocalEntityId values (sorted ascending). */
      readonly overlapping: readonly number[];
      /**
       * Source labels for the conflicting windows. Each entry is a
       * human-readable origin string (`mount[<localId>]`,
       * `entities[<localId>]`, etc.) of length matching `overlapping[]`.
       */
      readonly sources: readonly string[];
    }
  | {
      readonly code: 'pack-mount-count-mismatch';
      /** localId of the offending mount within its parent SceneAsset. */
      readonly mountLocalId: number;
      /** memberCount declared on the mount. */
      readonly declared: number;
      /** Actual entities[].length resolved from the referenced child SceneAsset. */
      readonly actual: number;
    }
  | {
      readonly code: 'pack-mount-override-localid-out-of-range';
      /** override.localId that fell outside the mount's member window. */
      readonly overrideLocalId: number;
      /** localId of the parent mount. */
      readonly mountLocalId: number;
      /** memberCount of the parent mount (window upper bound, exclusive). */
      readonly memberCount: number;
    }
  | {
      readonly code: 'pack-mount-override-unknown-field';
      /** Component name on which the override was authored. */
      readonly comp: string;
      /** Unknown field name. */
      readonly field: string;
      /** localId of the parent mount carrying the override. */
      readonly mountLocalId: number;
    }
  // === 2 new variants (feat-20260625-asset-meta-source-mount-prefix M1 / w1) ===
  | {
      readonly code: 'pack-unknown-path';
      /** The @name that was not found in package.json#forgeax.assets.paths. */
      readonly pathName: string;
      /** All known path names declared in package.json#forgeax.assets.paths. */
      readonly knownNames: readonly string[];
    }
  | {
      readonly code: 'pack-malformed-path-ref';
      /**
       * Which malformation occurred, so an AI user can branch on a property
       * instead of parsing the human-facing .hint:
       * - 'format': source starts with @ but does not match @<name>/<rest>
       * - 'escape': rest segment resolves outside the declared path directory
       */
      readonly reason: 'format' | 'escape';
      /** The raw source string as written in the .meta.json. */
      readonly rawSource: string;
      /** The expected format description for self-correction. */
      readonly expectedFormat: string;
    };

/**
 * Per-code .hint string literals SSOT.
 * Record<PackErrorCode, string> ensures compile-time completeness.
 */
export const PACK_ERROR_HINTS: Readonly<Record<PackErrorCode, string>> = {
  'pack-malformed-meta':
    'check guid is a valid RFC 4122 UUID; validate with: ajv validate -s schema/meta.schema.json -d <file>',
  'pack-malformed-pack':
    'check all asset guid and refs[] fields are 36-char dash-form UUIDs; validate with pack.schema.json',
  'pack-guid-malformed':
    'use AssetGuid.random() or a UUIDv7 generator; all GUID fields must be 36-char RFC 4122 dash-form',
  'pack-orphan-meta': 'remove the orphan .meta.json or add the missing source file next to it',
  'pack-meta-missing':
    'run forgeax-engine-remote-asset scan --roots <dir> to list source files without .meta.json',
  'pack-guid-collision':
    'run forgeax-engine-remote-asset verify to list all GUID collisions; each GUID must be globally unique',
  'pack-cyclic-reference':
    'run forgeax-engine-remote-asset verify to print the cycle path; break the cycle by removing a refs[] entry',
  'pack-subasset-index-out-of-range':
    'check subAssets[].sourceIndex does not exceed the actual sub-image count in the source file',
  // === 1 new hint (feat-20260523-shader-template-instance-split M1-T02) ===
  'payload-schema-mismatch':
    'material asset payload failed schema validation; check paramSchema entries all use valid types from MATERIAL_PARAM_TYPES and materialShader is a non-empty string',
  // === 4 new hints (feat-20260608-scene-nesting-ecs-fication M1 / w8;
  // plan-strategy D-8) ===
  'pack-mount-localid-overlap':
    'check parent SceneAsset.mounts[].memberFirst windows do not overlap with each other or with entities[].localId; rebuild mount sidecar after the child SceneAsset reimport',
  'pack-mount-count-mismatch':
    'mount.memberCount must equal the referenced child SceneAsset totalSlots (entities.length + sum(mounts[].memberCount) + mounts.length); rebuild mount sidecar via forgeax-engine-remote-asset verify <dir> after the child SceneAsset reimport',
  'pack-mount-override-localid-out-of-range':
    'override.localId must be in [0, mount.memberCount); shrink the override or extend memberCount to match the child SceneAsset',
  'pack-mount-override-unknown-field':
    'override.comp / override.field must match a defined component schema; check defineComponent registry or rebuild mount sidecar after the child SceneAsset reimport',
  // === 2 new hints (feat-20260625-asset-meta-source-mount-prefix M1 / w1) ===
  'pack-unknown-path':
    'the @name in source is not declared in package.json#forgeax.assets.paths; add it there or use a known name from the list in error.detail.knownNames',
  'pack-malformed-path-ref':
    'source must be @<name>/<rest> where name is a key in package.json#forgeax.assets.paths; the resolved path must not escape the declared directory',
};

// === AudioErrorCode / AudioError / AudioErrorDetail -- audio error SSOT (feat-20260527-audio-system M1 / w4) ===
//
// Decision anchors:
// - requirements S-8 (5-member independent closed union: context-creation-failed /
//   decode-failed / context-suspended / invalid-clip-handle / bus-not-found)
// - requirements AC-13 (AudioErrorCode closed union switch exhaustiveness)
// - plan-strategy D-7 (AudioErrorCode SSOT in engine-types, parallel to
//   ImageErrorCode / GltfErrorCode / AssetErrorCode)
// - plan-strategy section 8 AI User Affordance (structured 4-field surface:
//   .code / .expected / .hint / .detail)
// - charter P3 (explicit failure: switch (err.code) exhaustive without default;
//   .hint provides concrete recovery action)
// - charter P4 (consistent abstraction: structurally parallel to AssetError,
//   ImageError, GltfError same 4-field shape)
// - architecture-principles #1 SSOT (the 5 literals + class shape + hints table
//   live here once; engine-audio package references this module)

/**
 * Closed `AudioErrorCode` union -- 5 members (plan-strategy D-7;
 * requirements S-8). Exhaustive `switch (err.code)` needs no default
 * fallback -- TypeScript guards union completeness at compile time
 * (charter P3 explicit failure).
 *
 * Domain-separated from `AssetErrorCode` (runtime registry surface, 12 members)
 * and `GltfErrorCode` (importer surface, 13 members). AI users face these 5
 * alternatives at the audio engine surface (`@forgeax/engine-audio`
 * AudioError + `@forgeax/engine-audio-webaudio` backend).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'context-creation-failed'` | `new AudioContext()` threw or returned null (privacy browser / no audio device) |
 * | `'decode-failed'` | `decodeAudioData(arrayBuffer)` rejected (corrupt file / unsupported codec) |
 * | `'context-suspended'` | `play()` called while AudioContext.state is `'suspended'` and gesture listener failed to resume |
 * | `'invalid-clip-handle'` | AudioSource.clip handle is dangling or refers to an unregistered asset |
 * | `'bus-not-found'` | AudioSource.bus refers to a string literal outside the `'sfx' | 'music'` closed set |
 */
export type AudioErrorCode =
  | 'context-creation-failed'
  | 'decode-failed'
  | 'context-suspended'
  | 'invalid-clip-handle'
  | 'bus-not-found';

/**
 * Per-code `AudioError` detail shapes -- discriminated payloads narrowed
 * by `AudioError.code` so AI users writing `switch (err.code)` get
 * control-flow-tightened access to the relevant detail fields
 * (charter P3 explicit failure).
 */

/** `context-creation-failed` payload: carries the original error reason. */
export interface AudioCtxCreationFailedDetail {
  readonly code: 'context-creation-failed';
  readonly reason: string;
}

/** `decode-failed` payload: carries the original decode error reason. */
export interface AudioDecodeFailedDetail {
  readonly code: 'decode-failed';
  readonly reason: string;
}

/** `context-suspended` payload: empty marker detail (no extra fields). */
export interface AudioCtxSuspendedDetail {
  readonly code: 'context-suspended';
}

/** `invalid-clip-handle` payload: carries the dangling handle identifier. */
export interface AudioInvalidClipHandleDetail {
  readonly code: 'invalid-clip-handle';
  readonly clipHandleId: number;
}

/** `bus-not-found` payload: carries the invalid bus name attempted. */
export interface AudioBusNotFoundDetail {
  readonly code: 'bus-not-found';
  readonly attemptedBus: string;
}

/**
 * Discriminated detail union for `AudioError`, narrowed per `AudioError.code`.
 * AI users obtain the concrete detail shape via `switch (err.code)` without
 * needing a fallback `as` cast (charter P3).
 */
export type AudioErrorDetail =
  | AudioCtxCreationFailedDetail
  | AudioDecodeFailedDetail
  | AudioCtxSuspendedDetail
  | AudioInvalidClipHandleDetail
  | AudioBusNotFoundDetail;

/**
 * Structured audio error -- four-field surface (`.code` / `.expected` /
 * `.hint` / `.detail`) structurally parallel to `@forgeax/engine-types`
 * `AssetError` + `ImageError` + `GltfError` same-shape errors
 * (charter P4 consistent abstraction; AGENTS.md "Errors are structured.
 * Return Result, never throw for expected failures.").
 *
 * AI users consume the structured triple via property access:
 * `switch (err.code) { case 'decode-failed': ... err.hint ... }`
 * -- never by parsing `.message` (charter P3 explicit failure red line).
 *
 * The `.message` field is auto-composed for human stack traces and carries
 * the same content as `.code` + `.expected` + `.hint`; AI users prefer
 * field access on the structured triple.
 *
 * @example AI-user exhaustive switch on the 5 members (no default fallback)
 * ```ts
 * import { AudioError, type AudioErrorCode } from '@forgeax/engine-types';
 *
 * function recover(code: AudioErrorCode): string {
 *   switch (code) {
 *     case 'context-creation-failed': return 'check browser supports AudioContext';
 *     case 'decode-failed':          return 'ensure audio file is a valid wav/mp3/ogg/flac';
 *     case 'context-suspended':      return 'call play after user gesture to trigger resume';
 *     case 'invalid-clip-handle':    return 'verify clip was registered via AssetRegistry';
 *     case 'bus-not-found':          return 'use sfx or music bus literal';
 *   }
 * }
 * ```
 */
export class AudioError extends Error {
  readonly code: AudioErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: AudioErrorDetail;

  constructor(args: {
    code: AudioErrorCode;
    expected: string;
    hint: string;
    detail?: AudioErrorDetail;
  }) {
    super(`[AudioError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'AudioError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    if (args.detail !== undefined) {
      this.detail = args.detail;
    }
  }
}

/**
 * Per-code `.hint` string literals SSOT (plan-strategy D-7 lock-in).
 * Exported so engine-audio error helpers and tests consume the same SSOT
 * -- any drift here updates both producer call sites and the AGENTS.md
 * Error model table.
 *
 * The shape is a `Record<AudioErrorCode, string>` so future additions to
 * the closed union are a compile-time error here as well (reinforces
 * charter P3 explicit failure). Each hint embeds an executable recovery
 * action so AI users self-repair (charter P3).
 */
export const AUDIO_ERROR_HINTS: Readonly<Record<AudioErrorCode, string>> = {
  'context-creation-failed':
    'check browser supports AudioContext; verify no privacy extension blocks audio; try reloading the page after user gesture',
  'decode-failed':
    'ensure audio file is a valid wav/mp3/ogg/flac at the GUID path; check file integrity (truncated or empty bytes)',
  'context-suspended':
    'call play after a user gesture (click/tap/keydown) to trigger AudioContext.resume(); if in iframe check sandbox attribute',
  'invalid-clip-handle':
    'verify clip was registered via AssetRegistry.register() before spawning AudioSource; inspect active handles via assetRegistry.inspect()',
  'bus-not-found':
    "use 'sfx' or 'music' bus literal; custom bus names are not supported in v1 (OOS-2)",
};

// === PhysicsErrorCode / PhysicsError / PhysicsErrorDetail -- physics error SSOT (feat-20260528-rapier-physics-2d-3d M1 / t6; extended feat-20260617-kinematic M1) ===
//
// Decision anchors:
//   - requirements AC-11 (PhysicsErrorCode closed union registration + AGENTS.md update)
//   - plan-strategy D-5 (PhysicsErrorCode 9 members / PhysicsError 4-field surface / PhysicsErrorDetail discriminated)
//   - charter P3 (explicit failure: exhaustive switch without default; .hint provides recovery)
//   - charter P4 (consistent abstraction: structurally parallel to AssetError / AudioError / GltfError)
//   - architecture-principles #1 SSOT (the 9 literals + class + hints table live here once;
//     engine-physics package re-exports from here)

/**
 * Closed `PhysicsErrorCode` union -- 9 members (plan-strategy D-5;
 * requirements AC-11). Exhaustive `switch (err.code)` needs no default
 * fallback -- TypeScript guards union completeness at compile time
 * (charter P3 explicit failure).
 *
 * Domain-separated from `AssetErrorCode` (runtime registry, 13 members)
 * and `AudioErrorCode` (audio engine, 5 members). AI users face these 9
 * alternatives at the physics engine surface.
 *
 * | code | trigger |
 * |:--|:--|
 * | `'wasm-load-failed'` | dynamic import() of Rapier WASM rejected (network / file not found). |
 * | `'wasm-simd-unsupported'` | WebAssembly.validate returned false for SIMD test module; compat fallback also unavailable. |
 * | `'step-failed'` | Rapier World.step threw a WASM trap (invalid body parameters / NaN values). |
 * | `'invalid-body-config'` | mass <= 0 for dynamic bodies, or other validation failure. |
 * | `'body-not-found'` | entity handle resolved to no Rapier rigid body (no RigidBody spawned or handle was freed). |
 * | `'collider-not-found'` | entity handle resolved to no Rapier collider (no Collider spawned or handle was freed). |
 * | `'backend-not-registered'` | PhysicsWorld resource missing from World; use createApp(canvas, { plugins: [physicsPlugin('rapier-3d')] }) or manual registration. |
 * | `'teleport-invalid-body-type'` | teleport() called on a static or kinematic body (only dynamic allowed). |
 * | `'controller-requires-kinematic'` | moveAndSlide() called on a non-kinematic body. |
 */
export type PhysicsErrorCode =
  | 'wasm-load-failed'
  | 'wasm-simd-unsupported'
  | 'step-failed'
  | 'invalid-body-config'
  | 'body-not-found'
  | 'collider-not-found'
  | 'backend-not-registered'
  | 'teleport-invalid-body-type'
  | 'controller-requires-kinematic';

/**
 * Per-code `PhysicsError` detail shapes -- discriminated payloads narrowed
 * by `PhysicsError.code` so AI users writing `switch (err.code)` get
 * control-flow-tightened access to the relevant detail fields (charter P3).
 */

/** `wasm-load-failed` payload: carries the original error reason. */
export interface PhysicsWasmLoadFailedDetail {
  readonly code: 'wasm-load-failed';
  readonly reason: string;
}

/** `wasm-simd-unsupported` payload: carries the detection failure reason. */
export interface PhysicsWasmSimdUnsupportedDetail {
  readonly code: 'wasm-simd-unsupported';
  readonly reason: string;
}

/** `step-failed` payload: carries the WASM trap reason. */
export interface PhysicsStepFailedDetail {
  readonly code: 'step-failed';
  readonly reason: string;
}

/** `invalid-body-config` payload: carries the violating field + value. */
export interface PhysicsInvalidBodyConfigDetail {
  readonly code: 'invalid-body-config';
  readonly field: string;
  readonly value: unknown;
}

/** `body-not-found` payload: carries the entity that was not found. */
export interface PhysicsBodyNotFoundDetail {
  readonly code: 'body-not-found';
  readonly entity: number;
}

/** `collider-not-found` payload: carries the entity that was not found. */
export interface PhysicsColliderNotFoundDetail {
  readonly code: 'collider-not-found';
  readonly entity: number;
}

/** `backend-not-registered` payload: carries the attempted backend name. */
export interface PhysicsBackendNotRegisteredDetail {
  readonly code: 'backend-not-registered';
  readonly attemptedBackend: string;
}

/** `teleport-invalid-body-type` payload: carries the entity + disallowed body type. */
export interface PhysicsTeleportInvalidBodyTypeDetail {
  readonly code: 'teleport-invalid-body-type';
  readonly entity: number;
  readonly bodyType: string;
}

/** `controller-requires-kinematic` payload: carries the entity + actual body type. */
export interface PhysicsControllerRequiresKinematicDetail {
  readonly code: 'controller-requires-kinematic';
  readonly entity: number;
  readonly bodyType: string;
}

/**
 * Discriminated detail union for `PhysicsError`, narrowed per `PhysicsError.code`.
 * AI users obtain the concrete detail shape via `switch (err.code)` without
 * needing a fallback `as` cast (charter P3).
 */
export type PhysicsErrorDetail =
  | PhysicsWasmLoadFailedDetail
  | PhysicsWasmSimdUnsupportedDetail
  | PhysicsStepFailedDetail
  | PhysicsInvalidBodyConfigDetail
  | PhysicsBodyNotFoundDetail
  | PhysicsColliderNotFoundDetail
  | PhysicsBackendNotRegisteredDetail
  | PhysicsTeleportInvalidBodyTypeDetail
  | PhysicsControllerRequiresKinematicDetail;

/**
 * Structured physics error -- four-field surface (`.code` / `.expected` /
 * `.hint` / `.detail`) structurally parallel to `@forgeax/engine-types`
 * `AssetError` + `AudioError` + `GltfError` (charter P4 consistent abstraction).
 *
 * AI users consume the structured triple via property access:
 * `switch (err.code) { case 'wasm-load-failed': ... err.hint ... }`
 * -- never by parsing `.message` (charter P3 explicit failure red line).
 *
 * @example AI-user exhaustive switch on the 9 members (no default fallback)
 * ```ts
 * import { PhysicsError, type PhysicsErrorCode } from '@forgeax/engine-types';
 *
 * function recover(code: PhysicsErrorCode): string {
 *   switch (code) {
 *     case 'wasm-load-failed':            return 'check network and @dimforge/rapier3d-compat';
 *     case 'wasm-simd-unsupported':       return 'check browser supports WASM SIMD';
 *     case 'step-failed':                 return 'check for NaN values in transforms';
 *     case 'invalid-body-config':         return 'ensure mass > 0 for dynamic bodies';
 *     case 'body-not-found':              return 'ensure RigidBody was spawned before use';
 *     case 'collider-not-found':          return 'ensure Collider was spawned before use';
 *     case 'backend-not-registered':      return 'use createApp(canvas, { plugins: [physicsPlugin(...)] })';
 *     case 'teleport-invalid-body-type':   return 'only dynamic bodies can be teleported';
 *     case 'controller-requires-kinematic': return 'set RigidBody.type to kinematic';
 *   }
 * }
 * ```
 */
export class PhysicsError extends Error {
  readonly code: PhysicsErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: PhysicsErrorDetail;

  constructor(args: {
    code: PhysicsErrorCode;
    expected: string;
    hint: string;
    detail?: PhysicsErrorDetail;
  }) {
    super(`[PhysicsError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'PhysicsError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    if (args.detail !== undefined) {
      this.detail = args.detail;
    }
  }
}

/**
 * Per-code `.hint` string literals SSOT (plan-strategy D-5 lock-in).
 * Exported so engine-physics error helpers and tests consume the same SSOT.
 *
 * The shape is a `Record<PhysicsErrorCode, string>` so future additions to
 * the closed union are a compile-time error here as well (reinforces
 * charter P3 explicit failure).
 */
export const PHYSICS_ERROR_HINTS: Readonly<Record<PhysicsErrorCode, string>> = {
  'wasm-load-failed':
    'dynamic import() of Rapier WASM rejected; check network, file path, and that @dimforge/rapier3d-compat is installed',
  'wasm-simd-unsupported':
    'WebAssembly.validate returned false for the SIMD test module; ensure browser supports WASM SIMD (Chrome 91+, Firefox 89+, Safari 16.4+)',
  'step-failed':
    'Rapier World.step threw a WASM trap; check for invalid body parameters or NaN values in transforms',
  'invalid-body-config':
    'check mass > 0 for dynamic bodies and valid shape parameters; see PhysicsError.detail.field',
  'body-not-found':
    'the entity handle did not resolve to a Rapier rigid body; ensure RigidBody was spawned before calling physics APIs',
  'collider-not-found':
    'the entity handle did not resolve to a Rapier collider; ensure Collider was spawned before calling physics APIs',
  'backend-not-registered':
    "PhysicsWorld resource not found; use createApp(canvas, { plugins: [physicsPlugin('rapier-3d')] }) or manually register a backend",
  'teleport-invalid-body-type':
    'teleport is only valid for dynamic bodies; static and kinematic bodies have their position managed differently',
  'controller-requires-kinematic':
    "moveAndSlide requires a kinematic RigidBody; set the entity's RigidBody.type to 'kinematic'",
};

// === RuntimeErrorCode - runtime-layer error code SSOT (feat-20260523-skin-skeleton-animation M0) ===
//
// Closed union of runtime-layer error code literals. Defined here as the
// single source of truth for code-string discovery (charter F1: AI users
// grep '@forgeax/engine-types' for all error code families). The error
// classes that carry these codes live in @forgeax/engine-runtime.
//
// Decision anchors:
//   - requirements AC-29 (RuntimeErrorCode +6: skin-joint-count-exceeded /
//     skin-joint-despawned / skin-joint-path-unresolved /
//     skin-instances-coexist-forbidden / vertex-storage-buffer-unavailable /
//     skin-palette-overflow)
//   - plan-strategy D-12 (kebab-case + closed union)
//   - charter P3 (explicit failure: exhaustive switch without default)

/** Closed union of runtime-layer error codes. */
export type RuntimeErrorCode =
  | 'shadow-invalid-config'
  | 'skin-joint-count-exceeded'
  | 'skin-joint-despawned'
  | 'skin-joint-path-unresolved'
  | 'skin-instances-coexist-forbidden'
  | 'vertex-storage-buffer-unavailable'
  | 'skin-palette-overflow'
  | 'material-resolved-empty-passes'
  | 'skybox-cubemap-not-ready'
  | 'mesh-ssbo-capacity-exceeded'
  | 'mesh-ssbo-ceiling-reached'
  | 'hdrp-caps-insufficient'
  | 'hdrp-light-budget-exceeded'
  | 'hdrp-index-list-overflow';

// === GPUFlagsConstant namespace numeric aliases (5 *Flags + 8 Size/Index/Offset/SampleMask) ===
//
// One-to-one with the W3C CR §3.6 `unsigned long` definitions; runtime values are
// surfaced by the global objects (GPUBufferUsage / GPUColorWrite / GPUMapMode /
// GPUShaderStage / GPUTextureUsage).

/** GPU buffer usage bit flags (OR combination of GPUBufferUsage.MAP_READ / COPY_SRC / ...). */
export type BufferUsageFlags = GPUBufferUsageFlags;

/** GPU color write mask bit flags (GPUColorWrite.RED / GREEN / BLUE / ALPHA / ALL). */
export type ColorWriteFlags = GPUColorWriteFlags;

/** GPU buffer map mode bit flags (GPUMapMode.READ / WRITE). */
export type MapModeFlags = GPUMapModeFlags;

/** GPU shader stage bit flags (GPUShaderStage.VERTEX / FRAGMENT / COMPUTE). */
export type ShaderStageFlags = GPUShaderStageFlags;

/** GPU texture usage bit flags (GPUTextureUsage.COPY_SRC / COPY_DST / TEXTURE_BINDING / ...). */
export type TextureUsageFlags = GPUTextureUsageFlags;

/** GPU 32-bit unsigned size. */
export type Size32 = GPUSize32;

/** GPU 64-bit unsigned size. */
export type Size64 = GPUSize64;

/** GPU 32-bit unsigned index. */
export type Index32 = GPUIndex32;

/** GPU 32-bit signed offset. */
export type SignedOffset32 = GPUSignedOffset32;

/** GPU integer coordinate (used for texture / viewport extents). */
export type IntegerCoordinate = GPUIntegerCoordinate;

/** GPU sample mask bit pattern. */
export type SampleMask = GPUSampleMask;

/** GPU buffer dynamic offset. */
export type BufferDynamicOffset = GPUBufferDynamicOffset;

/** GPU stencil value (reference / read mask / write mask). */
export type StencilValue = GPUStencilValue;

// === String literal enum re-exports (already exported by @webgpu/types; we only alias) ===

/** GPU texture format enum (e.g. 'rgba8unorm' / 'depth24plus' / ...). */
export type TextureFormat = GPUTextureFormat;

/** GPU texture dimension ('1d' / '2d' / '3d'). */
export type TextureDimension = GPUTextureDimension;

/** GPU texture view dimension ('1d' / '2d' / '2d-array' / 'cube' / 'cube-array' / '3d'). */
export type TextureViewDimension = GPUTextureViewDimension;

/** GPU compare function ('never' / 'less' / 'equal' / 'less-equal' / 'greater' / 'not-equal' / 'greater-equal' / 'always'). */
export type CompareFunction = GPUCompareFunction;

/** GPU filter mode ('nearest' / 'linear'). */
export type FilterMode = GPUFilterMode;

/** GPU address mode ('clamp-to-edge' / 'repeat' / 'mirror-repeat'). */
export type AddressMode = GPUAddressMode;

/** GPU vertex format enum ('float32' / 'float32x2' / ... 32 variants in total). */
export type VertexFormat = GPUVertexFormat;

/** GPU vertex step mode ('vertex' / 'instance'). */
export type VertexStepMode = GPUVertexStepMode;

/** GPU index format ('uint16' / 'uint32'). */
export type IndexFormat = GPUIndexFormat;

/** GPU primitive topology ('point-list' / 'line-list' / 'line-strip' / 'triangle-list' / 'triangle-strip'). */
export type PrimitiveTopology = GPUPrimitiveTopology;

/** GPU triangle cull mode ('none' / 'front' / 'back'). */
export type CullMode = GPUCullMode;

/** GPU triangle front-face winding ('ccw' / 'cw'). */
export type FrontFace = GPUFrontFace;

/** GPU stencil operation ('keep' / 'zero' / 'replace' / 'invert' / 'increment-clamp' / 'decrement-clamp' / 'increment-wrap' / 'decrement-wrap'). */
export type StencilOperation = GPUStencilOperation;

/** GPU blend factor ('zero' / 'one' / 'src' / 'one-minus-src' / ...). */
export type BlendFactor = GPUBlendFactor;

/** GPU blend operation ('add' / 'subtract' / 'reverse-subtract' / 'min' / 'max'). */
export type BlendOperation = GPUBlendOperation;

/** GPU load op ('load' / 'clear'). */
export type LoadOp = GPULoadOp;

/** GPU store op ('store' / 'discard'). */
export type StoreOp = GPUStoreOp;

// === Shader pipeline trio SSOT (feat-20260508-shader-pipeline-mvp) =================
//
// Decision anchors:
// - plan-strategy §S-7 + §S-9 (fully-explicit reflection + ShaderError 5-field top level)
// - requirements §AC-04 (manifest 4 fields) + MVP-2.6 (manifest schema TS SSOT)
// - research Finding 2 (reflection JSON field-mapping oracle, 9 boundary cases)
// - charter proposition 4 (explicit failure) + proposition 5 (consistent abstraction:
//   dev-time and runtime errors share one shape)

/**
 * Single shader manifest entry — trio + 4-field manifest SSOT (AC-04).
 *
 * | Field | Shape | Notes |
 * |:--|:--|:--|
 * | `hash` | `string` | content-addressable fingerprint (the on-disk key written by the plugin's `generateBundle`) |
 * | `wgsl` | `string` | WGSL source: relative path or inline literal (the plugin chooses; schema does not constrain) |
 * | `glsl` | `string \| undefined` | GLSL placeholder (empty string or undefined within M1 scope; reserved for the non-WebGL fallback path) |
 * | `bindings` | `string` | `BindGroupLayoutDescriptor[]` serialized as a JSON string (output derived from reflection) |
 *
 * Written by `@forgeax/engine-shader-compiler`, persisted by `@forgeax/engine-vite-plugin-shader`,
 * loaded and consumed by `@forgeax/engine-shader` — the schema's single source of truth lives
 * in this package across all three sides (charter proposition 5: consistent abstraction).
 */
export interface ManifestEntry {
  readonly hash: string;
  readonly wgsl: string;
  readonly glsl: string | undefined;
  readonly bindings: string;
}

/**
 * Shader compile-time error-code closed union — 7 members
 * (feat-20260512-naga-oil-composition-hmr M3 T-09 extension; D-R7 / S-7 /
 * OQ-2 legacy 4 + D-08 new 3 for naga_oil composition).
 *
 * Symmetric in shape with `@forgeax/engine-rhi`'s `RhiErrorCode` closed union
 * (AGENTS.md error model); exhaustive `switch` needs no default fallback —
 * TypeScript guards union completeness at compile time (charter proposition 4
 * explicit failure / proposition 3 machine-readable union > prose).
 *
 * Evolution: minor-add (requirements §AC-08). The 4 legacy positions remain
 * byte-for-byte at the top (AGENTS.md `Evolution contract`: members can be
 * added only — no rename / delete / reorder). The 3 new members appear at the
 * bottom:
 * - `shader-import-not-found`  — naga_oil `ImportNotFound` variant surfaces
 *   when `#import <moduleId>::<symbol>` cannot bind to any module registered
 *   through `options.imports` (plan-strategy D-08 + D-12 offset passthrough).
 * - `shader-circular-import` — TS-layer DFS (T-11 `detectCycle`) catches
 *   `a -> b -> a` style import cycles before calling into the wasm composer
 *   (plan-strategy D-03 path A + D-04 cycle first/last repetition form).
 * - `shader-define-conflict` — TS-layer pre-scan (T-12 `scanDefineConflicts`)
 *   rejects the same `#define NAME` appearing in >=2 modules (plan-strategy
 *   D-07; prevents naga_oil HashMap silent override from research R-07).
 *
 * | code | Trigger |
 * |:--|:--|
 * | `'shader-compile-failed'` | naga `parse_str` / `Validator` failed; also the fallback for any non-ImportNotFound naga_oil ComposerError variant (plan-strategy D-05 non-boolean #define value goes here, never a new 8th member). |
 * | `'compiler-init-failed'` | wasm load / `init()` failed (cold start / missing wasm artifact). |
 * | `'manifest-malformed'` | manifest.json schema validation failed (4 fields missing or JSON unparseable). |
 * | `'shader-not-found'` | `ShaderRegistry.get(hash)` hash miss. |
 * | `'shader-import-not-found'` | `#import <moduleId>` target absent from `options.imports` (or lacks `#define_import_path` header). `err.detail.importPath` + `err.detail.fromModuleId` narrow after the switch. |
 * | `'shader-circular-import'` | import dependency graph contains a cycle; `err.detail.cycle` carries the full chain with first/last repeated (D-04). |
 * | `'shader-define-conflict'` | same `#define NAME` declared in multiple modules; `err.detail.sites[]` lists each offending moduleId. |
 */
export type ShaderErrorCode =
  | 'shader-compile-failed'
  | 'compiler-init-failed'
  | 'manifest-malformed'
  | 'shader-not-found'
  | 'shader-import-not-found'
  | 'shader-circular-import'
  | 'shader-define-conflict'
  // === 5 new material-* codes (feat-20260523-shader-template-instance-split M1-T02) ===
  | 'material-schema-mismatch'
  | 'material-shader-not-found'
  | 'material-param-type-mismatch'
  | 'material-param-unknown'
  | 'material-param-missing-required'
  // === build-time superset gate (feat-20260613-material-paramschema-driven-binding M2 / w9) ===
  | 'material-shader-binding-mismatch';

// === Shader error detail discriminated union (feat-20260512 M3 T-09 / D-08) =====
//
// Decision anchors:
// - plan-strategy §2 D-08 (3 new typed variants keyed on `code`, structurally
//   parallel to `RhiErrorDetail` in `packages/rhi/src/errors.ts` lines
//   165-189; 4 legacy members stay as prose detail for backwards compat).
// - plan-strategy §2 D-04 (cycle first/last repetition form: ['a','b','a']).
// - plan-strategy §2 D-12 (ImportNotFound offset passthrough when naga_oil
//   carries a source position on the inner variant).
// - requirements §AC-08 (AGENTS.md §Error model ShaderErrorDetail row 3
//   variants) + §AC-15 (property access over string parsing).
// - charter proposition 3 (machine-readable union > prose) + proposition 4
//   (explicit failure — narrow via `switch (err.detail.code)` after the
//   `switch (err.code)` tier).
// - architecture-principles #1 SSOT (3 typed variants live here once;
//   producer site `packages/shader-compiler/src/error-mapper.ts` constructs
//   them verbatim; AGENTS.md §Error model table references this module).

/**
 * Detail for the `shader-import-not-found` path (D-08 + D-12).
 *
 * `importPath` mirrors the bare `#import` target string (`'forgeax_pbr::brdf'`).
 * `fromModuleId` identifies the entry module that issued the unresolved
 * import; when the caller omitted `options.id`, this carries the
 * `<anonymous-entry-<hash8>>` placeholder (plan-strategy D-11). Optional
 * `offset` passes through the naga_oil inner-variant byte offset when present
 * (D-12); AI users surface this in error logs for IDE jump-to-source.
 */
export interface ShaderImportNotFoundDetail {
  readonly code: 'shader-import-not-found';
  readonly importPath: string;
  readonly fromModuleId: string;
  readonly offset?: number;
}

/**
 * Detail for the `shader-circular-import` path (D-08 + D-04).
 *
 * `cycle` lists the full import chain with the first and last element
 * repeated so consumers can visualise the loop at a glance
 * (`['a','b','c','a']`). The array is `readonly` so copy-out sites cannot
 * mutate the structure post-emit (charter proposition 4 explicit failure).
 */
export interface ShaderCircularImportDetail {
  readonly code: 'shader-circular-import';
  readonly cycle: readonly string[];
}

/**
 * Detail for the `shader-define-conflict` path (D-08 + D-07).
 *
 * `defineName` names the offending `#define NAME` literal; `sites` lists each
 * moduleId that declared it so the AI user can navigate to every duplicate
 * without re-scanning the source set (charter proposition 3 machine-readable
 * > prose).
 */
export interface ShaderDefineConflictDetail {
  readonly code: 'shader-define-conflict';
  readonly defineName: string;
  readonly sites: readonly { readonly moduleId: string }[];
}

/**
 * Detail for the `shader-compile-failed` path
 * (feat-small-20260513-dx-docs-types-cleanup D-9 / requirements §3.1.7 (A)).
 *
 * `compilerMessages` forwards the full 6 fields of `GPUCompilationMessage`
 * from `@webgpu/types ^0.1.69` (`message` / `type` / `lineNum` / `linePos` /
 * `offset` / `length`); the array is `readonly` so copy-out sites cannot
 * mutate the structure post-emit (charter proposition 4 explicit failure).
 * Optional `reason` carries a prose supplement when the wasm side surfaces a
 * higher-level summary alongside the raw compiler frame.
 *
 * @see RhiShaderCompileDetail in @forgeax/engine-rhi for the RhiError parallel
 * (R-7 namespace separation: `ShaderError.detail` vs `RhiError.detail` cover
 * disjoint lifecycle phases — compile-time vs async runtime dispatch — and
 * AI users distinguish them by import path).
 */
export interface ShaderCompileFailedDetail {
  readonly code: 'shader-compile-failed';
  readonly compilerMessages: readonly GPUCompilationMessage[];
  readonly reason?: string;
}

/**
 * Detail for the `compiler-init-failed` path
 * (feat-small-20260513-dx-docs-types-cleanup D-9 / requirements §3.1.7 (A)).
 *
 * Constructed by `@forgeax/engine-naga` when the wasm cold start fails
 * (`ensureReady()` rejects, the artefact is missing, or `init()` itself
 * throws). The `code` literal narrows `.detail` after the top-level
 * `switch (err.code)`; optional `reason` carries the wasm-side error message
 * when available (charter proposition 3 machine-readable union > prose).
 */
export interface ShaderInitFailedDetail {
  readonly code: 'compiler-init-failed';
  readonly reason?: string;
}

/**
 * Detail for the `manifest-malformed` path
 * (feat-small-20260513-dx-docs-types-cleanup D-9 / requirements §3.1.7 (A)).
 *
 * Constructed by `@forgeax/engine-naga` / `@forgeax/engine-shader-compiler`
 * when the shader manifest fails the 4-field schema (`{hash, wgsl, glsl,
 * bindings}`) or the JSON itself is unparseable. Optional `reason` carries
 * the schema validator or `JSON.parse` error message when available
 * (charter proposition 4 explicit failure: typed `.reason` access never
 * requires parsing `.message`).
 */
export interface ShaderManifestMalformedDetail {
  readonly code: 'manifest-malformed';
  readonly reason?: string;
}

// === 5 new material-* ShaderErrorDetail variants (feat-20260523-shader-template-instance-split M1-T02) ===
//
// Decision anchors:
// - plan-strategy D-NewErrorCodes-Anchor (5 ShaderErrorCode + 5 detail variants in types SSOT)
// - plan-strategy F-6 round 2 (material-schema-mismatch.mismatchKind is 4-element union:
//   schema-extra | shader-extra | type-mismatch | bg-overflow)
// - requirements AC-12 (each new error code has structured detail)

/**
 * Detail for `material-schema-mismatch` — paramSchema vs BGL mismatch at build-time.
 *
 * `mismatchKind` narrows on the 4-way mismatch category (F-6 round 2):
 * - 'schema-extra': paramSchema declares a name not in BGL
 * - 'shader-extra': BGL has a binding not in paramSchema
 * - 'type-mismatch': param type differs from BGL entry type
 * - 'bg-overflow': binding group count exceeds maxBindGroups (4) — AC-07
 *
 * Optional `expectedParam` / `actualBinding` carry the specific mismatch detail
 * for schema-extra / shader-extra / type-mismatch variants. `actualCount` /
 * `maxAllowed` populated for bg-overflow.
 */
export interface MaterialSchemaMismatchDetail {
  readonly code: 'material-schema-mismatch';
  readonly mismatchKind: 'schema-extra' | 'shader-extra' | 'type-mismatch' | 'bg-overflow';
  readonly materialShaderPath: string;
  readonly expectedParam?: string;
  readonly actualBinding?: number;
  readonly actualCount?: number;
  readonly maxAllowed?: number;
}

/**
 * Detail for `material-shader-not-found` — ShaderRegistry lookup miss.
 */
export interface MaterialShaderNotFoundDetail {
  readonly code: 'material-shader-not-found';
  readonly identifier: string;
}

/**
 * Detail for `material-param-type-mismatch` — paramValues value does not match
 * paramSchema expected type at runtime register.
 */
export interface MaterialParamTypeMismatchDetail {
  readonly code: 'material-param-type-mismatch';
  readonly paramName: string;
  readonly expectedType: string;
  readonly actualValue: unknown;
}

/**
 * Detail for `material-param-unknown` — paramValues contains a key not in
 * paramSchema.
 */
export interface MaterialParamUnknownDetail {
  readonly code: 'material-param-unknown';
  readonly paramName: string;
}

/**
 * Detail for `material-param-missing-required` — paramValues missing a key
 * that paramSchema declares without a default.
 */
export interface MaterialParamMissingRequiredDetail {
  readonly code: 'material-param-missing-required';
  readonly paramName: string;
}

/**
 * Detail for `material-shader-binding-mismatch` — vite-plugin-shader build-time
 * single-direction superset gate (feat-20260613-material-paramschema-driven-
 * binding M2 / D-9 / D-10).
 *
 * The actual reflected BGL must contain every binding emitted by
 * derive(schema); otherwise the build fails with this code. Extra bindings on
 * the actual side are tolerated (engine-injection placeholders such as shadow
 * / IBL / lightmap bind groups land at register-time).
 *
 * `expected` is the BGL entry derive(schema) emitted (the binding number +
 * resource layout the shader source must declare). `actual` is the entry the
 * reflector found at the same binding number, or `undefined` when the binding
 * is absent altogether. `expectedParam` names the paramSchema entry that
 * produced `expected` so AI users can grep the sidecar quickly. `mismatchKind`
 * narrows the failure category for AI-side branching.
 */
export interface MaterialShaderBindingMismatchDetail {
  readonly code: 'material-shader-binding-mismatch';
  readonly mismatchKind: 'binding-missing' | 'binding-type-mismatch';
  readonly materialShaderPath: string;
  readonly expected: BindGroupLayoutEntry;
  readonly actual?: BindGroupLayoutEntry;
  readonly expectedParam: string;
}

/**
 * Discriminated union of the 6 typed `.detail` variants keyed on `code`
 * (D-08 legacy 3 variants + feat-small-20260513-dx-docs-types-cleanup D-9
 * minor-add 3 variants; parallel to `RhiErrorDetail` lines 165-189 of
 * `packages/rhi/src/errors.ts`).
 *
 * AI users narrow to the per-code shape after the top-level
 * `switch (err.code)` via the nested `if (err.detail?.code === '<literal>')`
 * guard — `err.detail.compilerMessages` / `err.detail.importPath` /
 * `err.detail.reason` etc. are then typed property accesses with full IDE
 * autocomplete (charter proposition 3 machine-readable union > prose +
 * proposition 4 explicit failure).
 *
 * The 7th member `'shader-not-found'` has no typed detail variant — the naga
 * `shaderNotFound` factory leaves `.detail` undefined because the surface
 * carries no per-instance payload (the `hash` is already embedded in
 * `.message` / `.expected`; OOS-11 deferring a typed variant).
 *
 * Listed in the same order as the corresponding `ShaderErrorCode` members so
 * a reviewer can grep the two unions vertically for drift
 * (T-09 acceptance check ties `ShaderErrorDetail` grep hit to this layout).
 */
export type ShaderErrorDetail =
  | ShaderImportNotFoundDetail
  | ShaderCircularImportDetail
  | ShaderDefineConflictDetail
  | ShaderCompileFailedDetail
  | ShaderInitFailedDetail
  | ShaderManifestMalformedDetail
  // === 5 new material-* detail variants (feat-20260523-shader-template-instance-split M1-T02) ===
  | MaterialSchemaMismatchDetail
  | MaterialShaderNotFoundDetail
  | MaterialParamTypeMismatchDetail
  | MaterialParamUnknownDetail
  | MaterialParamMissingRequiredDetail
  // === build-time superset gate (feat-20260613-material-paramschema-driven-binding M2 / w9) ===
  | MaterialShaderBindingMismatchDetail;

/**
 * Bind group layout descriptor — shape-aligned with
 * `Pick<GPUBindGroupLayoutDescriptor, 'entries' | 'label'>` (S-9 / AC-04).
 *
 * **Shape rules**:
 * - `entries` is narrowed here to a concrete `readonly BindGroupLayoutEntry[]` (the
 *   spec uses `Iterable<...>`; reflection-derived output is always an array shape).
 * - All optional fields are uniformly `?: T | undefined` (guarded by
 *   exactOptionalPropertyTypes).
 * - Field names match `@webgpu/types` exactly, character for character (spec-alignment rule).
 *
 * **Fully-explicit reflection JSON constraint** (plan-strategy §S-9 / D-R9):
 * the `bindings` JSON emitted by `@forgeax/engine-shader-compiler` must populate every default
 * field defined in W3C spec §5 (e.g. `hasDynamicOffset: false` / `minBindingSize: 0`);
 * `visibility` is output as the `GPUShaderStage` integer bitmask (VERTEX=0x1 /
 * FRAGMENT=0x2 / COMPUTE=0x4 OR-ed together) — string-array form is **forbidden**.
 * This type only describes the schema shape; full explicitness is enforced on the
 * producer side.
 */
export interface BindGroupLayoutDescriptor {
  readonly label?: string | undefined;
  readonly entries: readonly BindGroupLayoutEntry[];
}

/**
 * Single bind group layout entry — shape-aligned with
 * `@webgpu/types.GPUBindGroupLayoutEntry`.
 *
 * `binding` / `visibility` are required; the four resource layouts (buffer / sampler /
 * texture / storageTexture) form the "exactly one set" constraint per W3C spec §5
 * (`externalTexture` is out of scope for the forgeax MVP and is not surfaced here yet).
 */
export interface BindGroupLayoutEntry {
  readonly binding: GPUIndex32;
  readonly visibility: GPUShaderStageFlags;
  readonly buffer?: GPUBufferBindingLayout | undefined;
  readonly sampler?: GPUSamplerBindingLayout | undefined;
  readonly texture?: GPUTextureBindingLayout | undefined;
  readonly storageTexture?: GPUStorageTextureBindingLayout | undefined;
}

// === RemoteHandle (feat-20260629-inspector-two-layer-model M4 / w17) ========
//
// Decision anchors:
// - plan-strategy secondary D-6: RemoteHandle defined in @forgeax/engine-types
//   (neutral package, no temporal coupling to @forgeax/engine-remote)
// - requirements AC-11: app.remote typed as RemoteHandle | undefined,
//   exposed on the createApp return value for host inspection
//
// Shape:
//   port  — number, the listen port (determined by the server on startup)
//   close — Promise<void>, tear down the server (Surface Plugin pattern
//           from startServer's returned ConsoleHandle)

/**
 * Handle for a running remote eval server (feat-20260629-inspector-two-layer-model M4).
 *
 * AI users access `app.remote.port` for WS connection / status, and call
 * `await app.remote.close()` to tear down. The field is `undefined` when the
 * server is not started (production build or headless without opt-in).
 *
 * @see {@link startServer} in @forgeax/engine-remote for the producer side
 */
export interface RemoteHandle {
  /** Server listen port (number). Non-zero when the server is running. */
  readonly port: number;
  /** Tear down the server. Returns a Promise that resolves once the WS
   *  server has closed all connections. */
  close(): Promise<void>;
}

// === Remote error model SSOT (feat-20260629-inspector-two-layer-model) ====
//
// Decision anchors:
// - requirements §10.1 + §10.2 + AC-05 (`RemoteErrorCode` 4-member
//   closed union + 4-field `RemoteError` shape independent from RhiError /
//   ShaderError)
// - plan-strategy §2 D-5 (rename InspectorErrorCode -> RemoteErrorCode,
//   delete inspector-write-denied, delete script-timeout, rename
//   console-* -> server-*)
// - charter proposition 3 (machine-readable union > prose) +
//   proposition 4 (explicit failure — `switch (err.code)` is exhaustive
//   without default fallback) + proposition 5 (consistent abstraction —
//   structurally aligned with @forgeax/engine-rhi's RhiError surface)
// - architecture-principles #1 SSOT (the 4 string literals + 4-field
//   structural shape live here once; @forgeax/engine-remote's runtime `RemoteError`
//   class implements this interface; consumers import the type
//   alias without dragging the runtime class through static deps —
//   parallel to the existing ShaderErrorCode pattern)

/**
 * Closed `RemoteErrorCode` union — 4 members (feat-20260629-inspector-two-layer-model
 * D-5; requirements AC-05). Exhaustive `switch` needs no default
 * fallback — TypeScript guards union completeness at compile time
 * (charter proposition 4 explicit failure + proposition 3 machine-readable
 * union > prose).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'script-syntax-error'` | Script body is not parseable JavaScript (SyntaxError from eval). |
 * | `'script-runtime-error'` | Script threw a non-syntax exception during execution (e.g. ReferenceError / TypeError). |
 * | `'server-startup-failed'` | The remote eval server failed to come up: WebSocketServer raised 'error' (EADDRINUSE / other listen failure), dynamic-import resolution failed, or the target package lacks the `startServer` factory. |
 * | `'server-not-running'` | CLI client's `new WebSocket('ws://localhost:<port>/inspector')` failed to connect (server not started; `app.remote` not wired in the demo). |
 *
 * **Independence from `RhiError | ShaderError` union** — `RemoteErrorCode`
 * is **not** merged into the GPU / asset error union (charter proposition 5 +
 * architecture-principles #1 SSOT). Engine-side errors stream is OOS-1
 * (errors.subscribe v2 spinoff); remote callers only face these 4
 * alternatives.
 */
export type RemoteErrorCode =
  | 'script-syntax-error'
  | 'script-runtime-error'
  | 'server-startup-failed'
  | 'server-not-running';

/**
 * Structural shape of a forgeax remote error (feat-20260629-inspector-two-layer-model
 * D-5). Four-field surface mirroring `@forgeax/engine-rhi` `RhiError`
 * (charter proposition 5 consistent abstraction; AGENTS.md "Errors are
 * structured"):
 *
 * - `.code`      closed union member (L1 key signal; switch-able).
 * - `.expected`  expected-state description (L2 detail).
 * - `.hint`      actionable recovery guidance (L2 detail).
 * - `.message`   auto-composed string for human stack traces (AI users
 *                prefer property access on `.code` / `.expected` / `.hint`).
 * - `.name`      Error name marker (`'RemoteError'`) for cross-realm
 *                dispatch under JSON-RPC transport.
 *
 * This interface intentionally extends `Error` so a runtime `RemoteError`
 * **class** (defined in `@forgeax/engine-remote/errors`) satisfies the contract
 * without re-declaring the inherited `name` / `message` slots.
 *
 * AI users consume the structured triple via property access — never by
 * parsing `.message` (charter proposition 4 explicit failure red line).
 */
export interface RemoteError extends Error {
  readonly code: RemoteErrorCode;
  readonly expected: string;
  readonly hint: string;
  /**
   * Optional discriminated detail payload (feat-20260517 D-7). Per-code
   * variant carries structured provenance that would otherwise pollute the
   * single-line `.hint` copy. AI users narrow via `switch (err.code)`; the
   * `.detail` slot is `undefined` for codes whose discriminator has no
   * payload (charter P4 explicit failure: signal absence by type).
   */
  readonly detail?: RemoteErrorDetail;
}

/**
 * Discriminated detail union for {@link RemoteError} (feat-20260517 D-7).
 * Each variant pairs a {@link RemoteErrorCode} member with the
 * structured payload AI users need to act on the error without grepping
 * prose. Variants without payload are intentionally absent — the
 * `RemoteError.detail` slot is `undefined` for those codes.
 *
 * The `server-startup-failed` variant captures the historical narrative
 * tokens (`removedAt` + `docAnchor`) that previously lived inside the
 * `.hint` copy; AC-13 binary-form hint phrasing stays terse and
 * executable, while AI users that need provenance read it via
 * `err.detail.removedAt` / `err.detail.docAnchor` after a code-narrow.
 */
export type RemoteErrorDetail = ServerStartupFailedDetail;

/**
 * `server-startup-failed` discriminator variant. Carries the legacy
 * inspect-routing context plus historical narrative tokens.
 *
 * - `legacyInspectTarget`: when populated, the offending CLI subcommand
 *   chain matched the deleted `inspect <legacyInspectTarget>` built-in form
 *   and the `did you mean 'forgeax-engine-remote-ecs <legacyInspectTarget>'?`
 *   hint copy is the canonical recovery path (AC-12).
 * - `removedAt`: ISO date of the breaking change that deleted the inline
 *   `inspect <target>` built-in subcommand (the day the loop landed).
 * - `docAnchor`: relative anchor into AGENTS.md `#breaking-changes` row
 *   (so AI users that consume `.detail` JSON-RPC payloads can navigate
 *   straight to the row without parsing prose).
 */
export interface ServerStartupFailedDetail {
  readonly code: 'server-startup-failed';
  readonly legacyInspectTarget?: string;
  readonly removedAt: string;
  readonly docAnchor: string;
}

/**
 * SSOT for the legacy-inspect routing hint template (feat-20260517 AC-12).
 * Producers (the CLI plugin-fallthrough path + any downstream tooling that
 * formats `server-startup-failed` for human consumption) should compose
 * the hint via this helper so the `did you mean` copy stays byte-identical
 * across producers.
 *
 * The phrasing is single-line + executable so AI users can grep the
 * stderr block, copy the suggested binary form, and re-run; charter P3
 * machine-readable hint > prose.
 */
export function legacyInspectHint(legacyInspectTarget: string): string {
  return `did you mean 'forgeax-engine-remote-ecs ${legacyInspectTarget}'?`;
}
// === Metric registry error model SSOT (feat-20260512-threejs-pixel-parity-bench) ===
//
// Decision anchors:
// - requirements §3.5 + AC-04 + AC-05 + AC-11 (`MetricErrorCode` 4-member closed
//   union elevated to TS alias; B-1 regression-prevention callout — exhaustive
//   `switch (err.code)` without `default:` must compile under tsc strict)
// - plan-strategy §2 D-P3 (MetricErrorCode TS alias goes first in the topology;
//   M1 T-001 ships only the 4 legacy members verbatim from AGENTS.md Error
//   model table)
// - research Finding 9 (`MetricErrorCode` currently has zero TS alias = direct
//   B-1 regression risk; §6 g9 checklist item 1: introduce
//   `export type MetricErrorCode = ...` in `packages/types/src/index.ts`,
//   structurally parallel to ShaderErrorCode / RemoteErrorCode)
// - charter proposition 3 (machine-readable union > prose) + proposition 4
//   (explicit failure — closed-union exhaustive switch needs no default fallback;
//   tsc strict mode guards completeness) + proposition 5 (consistent abstraction —
//   structurally aligned with @forgeax/engine-rhi RhiError and RemoteError)
// - architecture-principles #1 SSOT (the 4 string literals live here once;
//   `scripts/check-metrics-declared.mjs` / `scripts/metrics/run-all.mjs` /
//   `scripts/metrics/run-fps.mjs` are .mjs producer sites that emit the same
//   literals at throw points; parallel to ShaderErrorCode pattern)

/**
 * Closed `MetricErrorCode` union — 4 members (M1 T-001 elevation of the
 * pre-existing 4 `.mjs` producer literals to a TS alias; research Finding 9
 * §6 g9 checklist item 1). Exhaustive `switch` needs no default fallback —
 * TypeScript guards union completeness at compile time (charter proposition 4
 * explicit failure + proposition 3 machine-readable union > prose).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'metric-not-declared'` | a workspace member lacks `package.json#forgeax.metrics` or the declaration is not a plain object; emitted by `scripts/check-metrics-declared.mjs` + `scripts/metrics/run-all.mjs`. |
 * | `'metric-kind-unknown'` | `forgeax.metrics` contains a key not in the closed `MetricKind` union (`bundle-size` / `fps` / `bench` / `gate` / `spike-report`); typo guard via ajv `additionalProperties: false`. |
 * | `'metric-status-not-ok'` | dispatcher (bundle-size / bench / gate / fps / spike-report) returned `status !== 'ok'`; the offending `report/<package>/<kind>.json` carries the value-vs-threshold detail. |
 * | `'metric-schema-malformed'` | `forgeax-metrics.schema.json` failed to parse / compile as JSON Schema 2020-12; precondition failure surfaced by both `check-metrics-declared.mjs` and `run-all.mjs`. |
 *
 * **B-1 regression prevention** (requirements AC-05 + AC-11): an alias without
 * a TS consumer site cannot be exhaustively switched; M1 T-002 adds type-level
 * tests against this alias, and M2 evaluator + M2 runner CLI add the two
 * non-test exhaustive `switch (err.code)` consumer sites (D-P9 plan-strategy
 * decision).
 *
 * Per-feat extension to 6 members (M1 T-002, D-P3): `'pixel-parity-threshold-exceeded'`
 * + `'pixel-parity-capture-failed'` extend the alias at the bottom; AGENTS.md
 * Error model table flips from `(4)` to `(6)` in lockstep. The two new members
 * encode the double-gate of the pixel-parity bench (research Finding 10 +
 * plan-strategy D-P2): Layer A per-pixel YIQ tolerance ` perPixelThreshold` is
 * pixelmatch-internal and never raises on its own; Layer B aggregate cap
 * `threshold` raises `'pixel-parity-threshold-exceeded'`; any capture-side
 * failure (chromium launch / vite preview / readPixels / size mismatch /
 * pixelmatch internal throw) collapses into `'pixel-parity-capture-failed'`
 * with a `.detail.stage` discriminator (charter proposition 5 consistent
 * abstraction — pixelmatch internal exception does NOT get a third member;
 * see D-P3 decision rationale).
 */
export type MetricErrorCode =
  | 'metric-not-declared'
  | 'metric-kind-unknown'
  | 'metric-status-not-ok'
  | 'metric-schema-malformed'
  | 'pixel-parity-threshold-exceeded'
  | 'pixel-parity-capture-failed';

/**
 * Per-code detail shape for the four legacy `MetricErrorCode` members
 * (`'metric-not-declared'` / `'metric-kind-unknown'` / `'metric-status-not-ok'`
 * / `'metric-schema-malformed'`).
 *
 * The four legacy `.mjs` producer sites (`scripts/check-metrics-declared.mjs`,
 * `scripts/metrics/run-all.mjs`, `scripts/metrics/run-fps.mjs`) emit textual
 * `[reason] / [hint]` lines and never carry a structured payload — they live
 * in CI-only scripts and exit 1 directly. The `.detail` slot is therefore left
 * `undefined` so AI consumers do not waste a narrowing step looking for a
 * non-existent payload (charter proposition 4 explicit failure: signal absence
 * by type).
 */
export interface MetricLegacyDetail {
  readonly stage?: undefined;
}

/**
 * Detail shape exclusive to the `'pixel-parity-threshold-exceeded'` path
 * (M1 T-002 / D-P11). Carries the full numeric verdict so AI users can
 * surface the value-vs-threshold delta in stderr / sticky-comment renderings
 * without parsing `.message`.
 *
 * | Field | Meaning |
 * |:--|:--|
 * | `diffPixelCount` | Aggregate count from `pixelmatch(left, right, ...)` (Layer B reading). |
 * | `diffPercent` | `diffPixelCount / (width * height)` rendered as a 0..1 float for sticky-comment formatting. |
 * | `maxChannelDelta` | Maximum per-channel uint8 delta across all differing pixels (0..255). Helps disambiguate "many tiny diffs" from "few big diffs". |
 * | `threshold` | The declared Layer B integer cap (`package.json#forgeax.metrics.bench.pixelDiff.threshold`). |
 * | `perPixelThreshold` | The Layer A `pixelmatch` per-pixel YIQ float threshold actually used; equals the declared value or the `0.1` fallback (D-P2 default semantics). |
 *
 * The exhaustive discriminator is `code === 'pixel-parity-threshold-exceeded'`
 * — AI users access `.detail.diffPixelCount` directly after the type guard
 * with full IDE autocomplete (charter proposition 3 machine-readable union >
 * prose; AI-user review F-1 IDE autocomplete affordance).
 */
export interface ParityThresholdDetail {
  readonly diffPixelCount: number;
  readonly diffPercent: number;
  readonly maxChannelDelta: number;
  readonly threshold: number;
  readonly perPixelThreshold: number;
}

/**
 * Detail shape exclusive to the `'pixel-parity-capture-failed'` path (M1 T-002
 * / D-P11). Carries a discriminator `.stage` that pinpoints which step of the
 * capture pipeline collapsed (charter proposition 5 consistent abstraction:
 * pixelmatch-internal throw becomes `.stage='diff'` rather than a third
 * `MetricErrorCode` member — plan-strategy D-P3 decision).
 *
 * | `.stage` | trigger |
 * |:--|:--|
 * | `'chromium-launch'` | `chromium.launch({...})` threw (research Finding 6: `--enable-unsafe-webgpu` flag still rejected on the host). |
 * | `'vite-preview'` | spawned vite preview never reached `wait-on tcp 30s` (research Finding 4 cleanup pattern). |
 * | `'pixel-readback'` | `gl.readPixels(...)` or `commandEncoder.copyTextureToBuffer(...)` failed, or `window.__captureLeft/Right` was missing. |
 * | `'size-mismatch'` | left and right `Uint8Array.length` differ; `leftSize` / `rightSize` carry the actual byte counts. |
 * | `'diff'` | `pixelmatch(left, right, ...)` itself threw (charter proposition 4 explicit failure: no silent catch; EC-06). |
 *
 * Optional `leftSize` / `rightSize` are populated for the `'size-mismatch'`
 * stage; they are absent for the other stages because the failure happened
 * before any byte count was known.
 */
export interface ParityCaptureDetail {
  readonly stage: 'chromium-launch' | 'vite-preview' | 'pixel-readback' | 'size-mismatch' | 'diff';
  readonly leftSize?: number;
  readonly rightSize?: number;
  /**
   * Optional human-readable cause string for the failure (typically the
   * caught `Error.message` text or an inferred reason). Aligned with ECMA
   * 2022 `Error.cause` naming convention so IDE hover invokes the same mental
   * model. Filled by `scripts/bench/pixel-parity.mjs` at every stage that
   * surfaces a non-empty message; absent when the failure is purely
   * structural (e.g. `'size-mismatch'` where `leftSize` / `rightSize` carry
   * the diagnostic payload instead).
   */
  readonly cause?: string;
}

/**
 * Discriminated union of `.detail` shapes per `MetricErrorCode` member
 * (D-P11; structurally parallel to `@forgeax/engine-rhi` `RhiErrorDetail`
 * lines 165-189 of `packages/rhi/src/errors.ts`).
 *
 * The dispatch happens through `MetricError`'s `.code` discriminator: per-code
 * interfaces narrow `.detail` automatically when the consumer writes
 * `if (err.code === 'pixel-parity-threshold-exceeded') { ...err.detail.diffPixelCount... }`.
 *
 * Listed in the same order as `MetricErrorCode` so a reviewer can grep the two
 * unions vertically for drift (M1 T-002 acceptance check ties `MetricErrorDetail`
 * grep hit to this layout).
 */
export type MetricErrorDetail = MetricLegacyDetail | ParityThresholdDetail | ParityCaptureDetail;

/**
 * Structural shape of a forgeax metric error (feat-20260512 T-002).
 *
 * Three-field surface (`.code` / `.expected` / `.hint`) plus per-code-narrowed
 * `.detail`, structurally aligned with `@forgeax/engine-rhi` `RhiError` and
 * `InspectorError` (charter proposition 5 consistent abstraction; AGENTS.md
 * "Errors are structured. Return Result, never throw for expected failures").
 *
 * `MetricError` is a TypeScript discriminated union of 6 per-code interfaces;
 * each variant narrows `.detail` to the corresponding `MetricErrorDetail`
 * branch. AI users perform a single `switch (err.code)` and pick up
 * `.detail.diffPixelCount` (threshold-exceeded path) or `.detail.stage`
 * (capture-failed path) with full IDE autocomplete (AI-user review F-1
 * affordance; D-P11).
 *
 * - `.code`      closed union member (L1 key signal; switch-able).
 * - `.expected`  expected-state description (L2 detail; mirrors the `[reason]`
 *                line emitted by `failStructured(...)` in the three `.mjs`
 *                producer sites).
 * - `.hint`      actionable recovery guidance (L2 detail; mirrors the `[hint]`
 *                line in `failStructured(...)`).
 * - `.detail`    path-specific structured payload narrowed per `.code`.
 *
 * AI users consume the structured triple via property access — never by
 * parsing `.message` (charter proposition 4 explicit failure red line).
 */
export type MetricError =
  | (MetricErrorBase & {
      readonly code: 'metric-not-declared';
      readonly detail?: MetricLegacyDetail | undefined;
    })
  | (MetricErrorBase & {
      readonly code: 'metric-kind-unknown';
      readonly detail?: MetricLegacyDetail | undefined;
    })
  | (MetricErrorBase & {
      readonly code: 'metric-status-not-ok';
      readonly detail?: MetricLegacyDetail | undefined;
    })
  | (MetricErrorBase & {
      readonly code: 'metric-schema-malformed';
      readonly detail?: MetricLegacyDetail | undefined;
    })
  | (MetricErrorBase & {
      readonly code: 'pixel-parity-threshold-exceeded';
      readonly detail: ParityThresholdDetail;
    })
  | (MetricErrorBase & {
      readonly code: 'pixel-parity-capture-failed';
      readonly detail: ParityCaptureDetail;
    });

/**
 * Common base of every `MetricError` variant (D-P11 internal helper —
 * never instantiated on its own, only intersected into the per-code
 * branches of `MetricError`).
 */
interface MetricErrorBase {
  readonly code: MetricErrorCode;
  readonly expected: string;
  readonly hint: string;
}

// === Pack-index catalog entry POD (feat-20260517-vite-plugin-image-build-time-cook D-2) ===
//
// PackIndexEntry is the in-memory shape of one row in `pack-index.json` (build
// path) and `/__pack/index` JSON response (dev path). It is the SSOT contract
// between the build-time catalog builder (`@forgeax/engine-vite-plugin-pack`)
// and the runtime asset loader (`@forgeax/engine-runtime` `parseAssetPayload`).
//
// Decision anchors:
//   - plan-strategy D-2 (5-field metadata sub-structure: width / height /
//     format / colorSpace / mipmap, mirrors TextureAsset POD field names so
//     `metadata.colorSpace` greps to the same surface across catalog / POD /
//     sidecar).
//   - plan-strategy D-5 (sidecar `mipmap: 'auto' | 'none'` is mapped to the
//     `boolean` form by the catalog builder; runtime is unaware of the
//     string token).
//   - charter P1 (progressive disclosure -- core 4 fields stay flat,
//     image-only metadata sinks into a sub-structure that texture-arm
//     consumers narrow into).
//   - charter P4 (consistent abstraction -- `metadata` field-by-field
//     mirrors `TextureAsset` POD field names; `width` / `height` / `format`
//     / `colorSpace` / `mipmap` align byte-for-byte).
//
// Backward compatibility (D-2 'minor' evolution):
//   - `metadata` is `?: ImageMetadata | undefined` -- legacy 4-field entries
//     emitted by older builds (or future non-texture kinds: 'mesh' / 'scene' /
//     'material') stay valid; runtime consumers narrow on `entry.metadata !==
//     undefined` before accessing fields.
//   - The interface stays open over `kind` (string) so future 'audio' /
//     'video' arms can join without re-typing PackIndexEntry; the texture
//     arm narrows via `entry.kind === 'texture'` + `entry.metadata`
//     existence in `parseAssetPayload`.

/**
 * Metadata sub-structure carried by `PackIndexEntry` rows of `kind: 'texture'`.
 *
 * Five fields mirror `TextureAsset` POD field names (`width` / `height` /
 * `format` / `colorSpace` / `mipmap`) so AI users can grep one identifier and
 * see the same surface in catalog rows, sidecar `*.meta.json`
 * `importSettings`, and the runtime `TextureAsset` POD (charter P4 consistent
 * abstraction).
 *
 * `width` / `height` are optional because dev-mode catalog rows folded from a
 * `*.meta.json` sidecar may lack pixel dimensions until `parseImage`
 * decodes the JPG bytes; build-mode (import) rows always have them filled
 * because the import step has already run `parseImage` to produce the RGBA
 * bytes.
 *
 * `format` is `GPUTextureFormat` to align with the `TextureAsset.format`
 * field (math-free, spec-aligned with `@webgpu/types ^0.1.70`).
 *
 * `colorSpace` and `mipmap` are required because the sidecar
 * `importSettings` always carries them (D-5: `'auto'` / `'none'` string
 * tokens are mapped to `true` / `false` at the catalog builder; runtime never
 * sees the string form).
 */
export interface ImageMetadata {
  readonly kind: 'texture';
  readonly width?: number;
  readonly height?: number;
  readonly format: GPUTextureFormat;
  readonly colorSpace: 'srgb' | 'linear';
  readonly mipmap: boolean;
}

/**
 * Metadata sub-structure carried by `PackIndexEntry` rows of
 * `kind: 'cube-texture'` (plan-strategy D-12 + section 4 OQ-5).
 *
 * Fields mirror `CubeTextureAsset` POD field names: `kind` discriminates
 * from `ImageMetadata`, `width` / `height` / `format` / `colorSpace`
 * align with the same surface across catalog rows, sidecar, and POD
 * (charter P4 consistent abstraction).
 *
 * `mipLevels` is fixed at `1` per plan-strategy D-12 (cubemap faces at
 * upload-time resolution; IBL prefilter mip chain is a GPU-side pass,
 * not a catalog concern).
 *
 * `metadata` is optional for cube-texture rows per plan-strategy D-12
 * (scanner may defer metadata folding); runtime consumers narrow on
 * `entry.metadata !== undefined` before accessing fields.
 */
export interface CubeTextureMetadata {
  readonly kind: 'cube-texture';
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly colorSpace: 'linear';
  readonly mipLevels: 1;
}

/**
 * One row in the pack-index catalog (`pack-index.json` for build path,
 * `/__pack/index` JSON response for dev path).
 *
 * Core fields (4) stay flat for AI users to grep one identifier:
 *   - `guid`: UUIDv5/v7 lowercase string (asset identity SSOT)
 *   - `relativeUrl`: dev path `<rel-path-from-cwd-to-source-jpg>`; build path
 *     `assets/<guid>-[hash].bin` (imported RGBA artefact name; see D-2 selected
 *     scheme `name: '<guid-lowercase>'` + Rollup `output.assetFileNames`
 *     default template).
 *   - `kind`: closed-string discriminator (`'texture'` / `'mesh'` / `'scene'`
 *     / `'material'` / future arms); narrowed by runtime `parseAssetPayload`
 *     via exhaustive switch.
 *   - `sourcePath`: relative path to the on-disk source artefact for
 *     debugging + grep (dev: source JPG path; build: same source JPG path
 *     even though `relativeUrl` points to the import artefact).
 *
 * Optional 5th field:
 *   - `metadata`: `ImageMetadata | undefined` -- present when `kind ===
 *     'texture'`; absent for non-texture kinds (legacy `.pack.json` entries
 *     emit 4-field rows). Runtime consumers narrow with `entry.metadata !==
 *     undefined` before consumption (D-2 backward-compat strategy).
 */
export interface PackIndexEntry {
  readonly guid: string;
  readonly relativeUrl: string;
  readonly kind: string;
  readonly sourcePath: string;
  /** Optional display name from .pack.json assets[].name or derived basename (D-6 add-only). */
  readonly name?: string;
  readonly metadata?: ImageMetadata | CubeTextureMetadata | undefined;
}

// === InspectEntry / InspectSnapshot (feat-20260618-asset-and-pack-name-fields M1 / w3) ===
//
// Decision anchors:
//   - plan-strategy D-9 (InspectEntry.name: string via resolveName, non-optional
//     with empty string as legal value; relocated from runtime private to types
//     for single-entry discoverability per charter F1)
//   - requirements AC-12 (inspector assets root carries resolved name per entry)
//
// These types were originally private interfaces in asset-registry.ts.
// They are promoted to @forgeax/engine-types so console + future inspector
// consumers import them from a single entry point (charter F1).

/** One row in the inspector's `assets[]` snapshot (JSON-RPC over WS). */
export interface InspectEntry {
  readonly guid: string;
  /** Asset kind discriminant string (e.g. `'mesh'`, `'texture'`, `'scene'`). */
  readonly kind: string;
  /** Display name resolved by resolveName (empty string is legal). */
  readonly name: string;
}

/** Snapshot returned by `AssetRegistry.inspect()` -- the inspector root. */
export interface InspectSnapshot {
  readonly assets: ReadonlyArray<InspectEntry>;
}

// === Loader contract SSOT (feat-20260603-asset-import-loader-injection M1 / w3) ===
//
// Decision anchors:
//   - plan-strategy D-1 (runtime LoaderRegistry dispatches on `asset.kind`;
//     host injects loaders via `wireDefaultLoaders`, mirroring Console
//     `wireDefaultInspectors`) + D-2 (contract SSOT lives here in
//     `@forgeax/engine-types`, math-free, so `@forgeax/engine-runtime` only
//     depends on the interface, never reverse-imports a concrete loader)
//   - requirements core principle (third DIP instance after RHI / Console)
//   - charter P3 (structured failure) + P4 (consistent abstraction)
//
// A `Loader` is the runtime-side half of the import/load split: it turns an
// already-imported internal artefact (a `.pack.json` payload, or fetched
// bytes for texture / font) into an in-memory `Asset` POD. It stays pure of
// the registry's bookkeeping — `registerWithGuid` is the AssetRegistry's job,
// never the loader's (plan-strategy D-2).
//
// Two dispatch shapes share this one contract (the asymmetry is intentional,
// matching the two pre-existing AssetRegistry load paths the M1 refactor
// converges; research Finding 1 + Finding 2):
//   (a) inline pack-payload kinds (mesh / scene / cube-texture / material /
//       skeleton / skin / animation-clip) parse synchronously and return
//       `Asset | undefined` (`undefined` = parse rejected, the caller maps it
//       to a structured `AssetError`).
//   (b) upstream-branch kinds (texture / font) fetch + decode asynchronously
//       and return a `Promise<LoaderAsyncResult>` carrying either the produced
//       `Asset` POD or a structured error.

/**
 * Result envelope returned by the async branch of {@link Loader.load}
 * (texture / font). Mirrors the `Result<T, E>` shape used across the engine
 * (`.ok` discriminant) but is declared math-free here so
 * `@forgeax/engine-types` need not import `@forgeax/engine-rhi`. The error is
 * left as `unknown` so the runtime can surface its own
 * `AssetError | ImageError | RhiError` union without leaking those classes
 * into the types package (charter P4 — the runtime narrows; types stays
 * dependency-free).
 */
export type LoaderAsyncResult<P = Asset> =
  | { readonly ok: true; readonly value: P }
  | { readonly ok: false; readonly error: unknown };

/**
 * Output of {@link Loader.load}. The synchronous arm returns `Asset` (parse
 * succeeded) or `undefined` (parse rejected); the asynchronous arm returns a
 * `Promise<LoaderAsyncResult>`.
 */
export type LoaderOutput<P = Asset> =
  | P
  | undefined
  | { readonly ok: false; readonly error: ParseErrorDetail }
  | Promise<LoaderAsyncResult<P>>;

/**
 * Capabilities the host wires into a {@link Loader} at load time. A loader
 * receives this context so it never reaches back into AssetRegistry
 * internals (pipeline isolation, architecture-principles #4).
 *
 * Exactly three capabilities (plan-strategy D-3 rationale):
 *   - `fetchBinary(url)` — fetch raw bytes for the artefact (texture import
 *     `.bin`, `.hdr`, source image, font pack JSON).
 *   - `resolveRef(guid)` — recursively resolve a referenced sub-asset GUID to
 *     its registered handle id (font atlas / sampler). Returns the raw handle
 *     number so the loader can stamp it into the produced POD; the runtime
 *     performs the recursive `loadByGuid` + registration underneath.
 *   - `device` — opaque GPU device slot, present for future GPU-touching
 *     loaders; current loaders register CPU PODs only and never touch it
 *     (research Finding 3 — texture GPU upload is decoupled from load time via
 *     the pull-model `GpuResourceStore`). Typed `unknown` so types stays
 *     RHI-free.
 *
 * F21 (feat-20260621): the error-contextualization callback has been removed.
 */
export interface ParseErrorDetail {
  readonly localId: number;
  readonly component: string;
  readonly field: string;
  readonly index: number;
  readonly refsLength: number;
}

export interface LoadContext {
  fetchBinary(
    url: string,
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: unknown }
  >;
  resolveRef(
    guid: string,
  ): Promise<
    { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: unknown }
  >;
  /**
   * feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
   * derive(paramSchema).textureFieldNames for the given material-shader id,
   * built from the registered shader's paramSchema. Used by materialLoader
   * to know which paramValues fields carry refs[] indices vs scalar values
   * (replacing the deleted hardcoded texture-field allowlist Set per AC-03).
   *
   * Returns `undefined` when the shader is not yet registered (the cross-
   * worktree shader-late-register path of plan R-4): the loader then falls
   * back to a graceful "try every int paramValue as a refs index" walk that
   * may misclassify scalar f32 fields whose value happens to land in
   * [0, refs.length); the extract layer (M4 / w23) catches mis-typed
   * handles via paramSchema validation and falls back to MISSING_TEXTURE_HANDLE.
   */
  getMaterialShaderTextureFieldNames?(shaderId: string): ReadonlySet<string> | undefined;
  readonly device: unknown;
}

/**
 * Runtime-side loader injected into the `LoaderRegistry`. One loader per
 * `asset.kind`; the registry dispatches `loadByGuid` on the kind.
 *
 * `load` is pure of registry bookkeeping (no `registerWithGuid`); it only
 * produces the `Asset` POD (or a structured error / `undefined`). See the
 * module comment above for the sync vs async dispatch asymmetry.
 */
export interface Loader<P = Asset> {
  readonly kind: string;
  load(
    payload: Record<string, unknown>,
    refs: readonly string[] | undefined,
    ctx: LoadContext,
  ): LoaderOutput<P>;
}

// === Import contract SSOT (feat-20260603-asset-import-loader-injection M2 / w12) ===
//
// Decision anchors:
//   - requirements AC-07 (Importer dispatched by `meta.importer` string key) +
//     AC-08 (`importer-not-registered` fail-fast) + AC-09 (GUID import-stable
//     iron law: `guid-mismatch` / `import-produced-no-assets`) + AC-10
//     (`ImportErrorCode` strictly 5 members, exhaustive switch without default)
//   - plan-strategy D-6 (error model add-only: `ImportErrorCode` is an
//     independent closed union, not folded into `AssetErrorCode`) + D-1
//     (`ImporterRegistry` register/get/fail-fast mirrors LoaderRegistry) + D-4
//     (import runner skips the reserved `importer: 'shader'` key)
//   - research Finding 8 (`ImportTransport` interface slot; HTTP adapter is
//     OOS-2, landed in M4) + Finding 9 (`PackError` four-field shape is the
//     structural template)
//   - charter P3 (structured failure: `.code` / `.expected` / `.hint` /
//     `.detail`; AI users consume via property access, never `.message`
//     parsing) + P4 (consistent abstraction, structurally parallel to
//     `PackError` / `AssetError`)
//
// The import side is the build-time half of the import/load split. An
// `Importer` turns an external source (a `.gltf` / `.png` / `.ttf` on disk)
// plus its `*.meta.json` GUID declarations into in-memory `ImportedAsset[]`
// (internal `Asset` PODs stamped with the meta-declared GUIDs). The import
// runner then materializes those into the DDC (`.pack.json` / `.bin`). The
// `Importer` itself stays pure of disk write + GUID minting — it consumes the
// meta-declared GUIDs (GUID import-stable iron law) and emits PODs only.

/**
 * Closed `ImportErrorCode` union — strictly 5 members (requirements AC-10).
 * Used exclusively by the build-time `@forgeax/engine-import` runner +
 * `ImporterRegistry` fail-fast chain. Domain-separated from the runtime
 * `AssetErrorCode` (the `loadByGuid` / `get` surface) and the disk-scanner
 * `PackErrorCode` — disjoint lifecycle phases. Counts evolve; see
 * AGENTS.md §Error model for the live roster.
 *
 * Exhaustive `switch (err.code)` needs no `default:` — TypeScript guards
 * union completeness at compile time (charter P2 machine-readable union >
 * prose + P3 explicit failure).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'importer-not-registered'` | the import runner read `meta.importer` but the injected `ImporterRegistry` has no importer for that key; `.detail.importer` is the missing key and `.detail.registeredImporters` lists the keys currently wired (charter P3 — AI users read `.detail.registeredImporters` to know what to inject). |
 * | `'source-read-failed'` | the source file referenced by `meta.source` could not be read (missing / unreadable); `.detail.source` is the path and `.detail.reason` the underlying error string. |
 * | `'import-produced-no-assets'` | the importer returned an empty `ImportedAsset[]`, or omitted a GUID that `meta.subAssets[]` declared (the produced GUID set is not a superset of the declared set); `.detail.missingGuids` lists the declared GUIDs the importer failed to produce. |
 * | `'guid-mismatch'` | the importer produced a GUID that `meta.subAssets[]` never declared (violates the GUID import-stable iron law); `.detail.unexpectedGuids` lists the produced GUIDs absent from the declared set. |
 * | `'import-internal-error'` | the importer failed at runtime. Two sub-cases ride `.detail` (NOT a new code — closed union stays 5, feat-20260629 D-5): a build-time module-LOAD failure (e.g. the host importer module / native addon could not be imported) surfaces `.detail.loadError`; a conversion THROW (the loaded importer threw while converting the source) surfaces `.detail.reason`. AI users branch on the `.detail` shape after narrowing `err.code === 'import-internal-error'`. |
 */
export type ImportErrorCode =
  | 'importer-not-registered'
  | 'source-read-failed'
  | 'import-produced-no-assets'
  | 'guid-mismatch'
  | 'import-internal-error';

/**
 * Discriminated detail union for {@link ImportError} — narrowed per
 * `ImportError.code`. AI users access `err.detail.<field>` directly after
 * `switch (err.code)` narrows the variant. Structurally parallel to
 * `PackErrorDetail` (the `code` field is intentionally absent from each
 * variant; identify via the top-level `ImportError.code`).
 */
export type ImportErrorDetail =
  | {
      /** The `meta.importer` key with no registered importer. */
      readonly importer: string;
      /** The importer keys currently wired into the registry (insertion order). */
      readonly registeredImporters: readonly string[];
    }
  | {
      /** The `meta.source` path that could not be read. */
      readonly source: string;
      /** The underlying read error message. */
      readonly reason: string;
    }
  | {
      /** Declared sub-asset GUIDs the importer failed to produce (empty when the importer produced nothing at all). */
      readonly missingGuids: readonly string[];
    }
  | {
      /** Produced GUIDs absent from the `meta.subAssets[]` declared set. */
      readonly unexpectedGuids: readonly string[];
    }
  | {
      /** The original thrown error message (importer loaded but its conversion threw). */
      readonly reason: string;
    }
  | {
      /**
       * The module-load failure message (feat-20260629 D-5): the importer
       * module / native addon could not be loaded at build time (e.g.
       * module-not-found, native-addon-not-built). Distinguishes a LOAD
       * failure from a conversion THROW (`reason`) under the same
       * `import-internal-error` code without growing the closed ImportErrorCode
       * union. AI users branch on `'loadError' in err.detail`.
       */
      readonly loadError: string;
    };

/**
 * Structured import error — four-field surface (`.code` / `.expected` /
 * `.hint` / `.detail`) structurally parallel to `PackError` / `AssetError`
 * (charter P4 consistent abstraction). `.detail` is narrowed per `.code` via
 * {@link ImportErrorDetail}.
 *
 * AI users consume the structured surface via property access:
 * `switch (err.code) { case 'guid-mismatch': ... err.detail.unexpectedGuids ... }`
 * — never by parsing `.message` (charter P3 red line).
 */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ImportErrorDetail;

  constructor(args: {
    code: ImportErrorCode;
    expected: string;
    hint: string;
    detail: ImportErrorDetail;
  }) {
    super(`[ImportError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'ImportError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

/**
 * Per-code `.hint` string literals SSOT. `Record<ImportErrorCode, string>`
 * makes a new closed-union member a compile-time error here as well
 * (reinforces charter P3 explicit failure). Consumed by the import runner +
 * tests so the producer and the fixtures share one source of truth.
 */
export const IMPORT_ERROR_HINTS: Readonly<Record<ImportErrorCode, string>> = {
  'importer-not-registered':
    'no importer registered for this meta.importer key; register one via importers.register(importer) (the importer carries its own key, e.g. gltfImporter / imageImporter); err.detail.registeredImporters lists the keys currently wired',
  'source-read-failed':
    'the file at meta.source could not be read; check the path is correct relative to the sidecar and the process has read access',
  'import-produced-no-assets':
    'the importer produced no assets, or omitted a GUID that meta.subAssets[] declared; the produced GUID set must be a superset of the declared set (GUID import-stable iron law); err.detail.missingGuids lists the declared GUIDs not produced',
  'guid-mismatch':
    'the importer produced a GUID that meta.subAssets[] never declared (violates the GUID import-stable iron law: GUIDs come from the external meta, never minted by the importer); err.detail.unexpectedGuids lists the offending GUIDs',
  'import-internal-error':
    'the importer failed at runtime; branch on err.detail: a conversion THROW carries err.detail.reason (the loaded importer threw while converting the source — an importer bug, not a meta / source problem), while a build-time module-LOAD failure carries err.detail.loadError (the host importer module / native addon could not be imported)',
};

/**
 * One asset produced by an {@link Importer}: the meta-declared `guid`, the
 * in-memory `Asset` POD, and its outbound GUID cross-references (`refs`). The
 * import runner folds these into the DDC `.pack.json` `assets[]` rows (one
 * `ImportedAsset` -> one `{ guid, kind, payload, refs }` row).
 *
 * The `guid` always comes from `meta.subAssets[].guid` (GUID import-stable
 * iron law) — the importer never mints it; it reads the declared GUID off the
 * meta and stamps it here. `kind` mirrors the `Asset.kind` discriminant so the
 * DDC row and the runtime loader dispatch on the same string.
 */
export interface ImportedAsset<P = Asset> {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly payload: P;
  readonly refs: readonly AssetRef[];
}

/**
 * One declared sub-asset entry the import runner hands to an
 * {@link Importer.import} call — the meta-declared `guid` + its `sourceIndex`
 * + `kind`. Mirrors the `meta.subAssets[]` rows so the importer can map a
 * source object index to the GUID it must stamp (GUID import-stable iron law).
 */
export interface ImportSubAsset {
  readonly guid: string;
  readonly sourceIndex: number;
  readonly kind: string;
}

/**
 * Capabilities + declarations the import runner wires into an
 * {@link Importer.import} call. The importer reads the source bytes via
 * `readSource`, the GUID declarations via `subAssets`, and the free-form
 * importer settings via `importSettings`. It stays pure of disk write +
 * registry bookkeeping (pipeline isolation, architecture-principles #4).
 *
 *   - `source` — the `meta.source` path (relative to the sidecar), for
 *     diagnostics + the importer's own external-resource resolution base.
 *   - `readSource()` — fetch the raw source bytes (the runner has already
 *     resolved the path); a structured failure here surfaces as
 *     `source-read-failed`.
 *   - `subAssets` — the `meta.subAssets[]` GUID declarations the importer must
 *     honour (GUID import-stable iron law).
 *   - `importSettings` — free-form importer settings copied verbatim from the
 *     sidecar.
 *   - `readSibling(uri)` — fetch raw bytes of a file co-located with the
 *     primary source (e.g. an `.gltf` referencing an external `.bin` /
 *     `.png` via relative URI). Failures surface as `source-read-failed`
 *     (C-6 — no specialised error code; the URI is forensic detail). Used
 *     by gltfImporter to resolve `images[].uri` external references at
 *     import time.
 *   - `decodeImage(bytes, mimeType, importSettings)` — decode raw image
 *     bytes (PNG / JPEG) into a `TextureAsset` POD plus a `bytes` copy
 *     suitable for `<guid>.bin` emission. The seam keeps gltfImporter
 *     out of `@forgeax/engine-image` (D-1: zero static `from
 *     '@forgeax/engine-image'` edge in `packages/gltf/src`). The
 *     concrete implementation (parseImage + format derivation) lives
 *     behind `@forgeax/engine-image/image-importer`; the build-time
 *     orchestrator (vite-plugin-pack / cli-gltf / tests) binds the
 *     callback when constructing the runner's `ImportRunnerFs`.
 */
export interface ImportContext {
  readonly source: string;
  readSource(): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: unknown }
  >;
  readSibling(
    uri: string,
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: ImportError }
  >;
  decodeImage(
    bytes: Uint8Array,
    mimeType: 'image/png' | 'image/jpeg',
    importSettings: Readonly<Record<string, unknown>>,
  ): Promise<
    | {
        readonly ok: true;
        readonly value: { readonly texture: TextureAsset; readonly bytes: Uint8Array };
      }
    | { readonly ok: false; readonly error: ImageError }
  >;
  readonly subAssets: readonly ImportSubAsset[];
  readonly importSettings: Readonly<Record<string, unknown>>;
}

/**
 * Build-time importer injected into the `ImporterRegistry`. One importer per
 * `meta.importer` key; the import runner dispatches on the key.
 *
 * `import` is pure of disk write + GUID minting: it reads the source via
 * `ctx.readSource()`, honours the `ctx.subAssets[]` GUID declarations, and
 * returns the produced `ImportedAsset[]`. The runner validates the produced
 * GUID set against the declared set (GUID import-stable iron law) and writes
 * the DDC. A thrown error is wrapped by the runner into
 * `import-internal-error` (charter P3) — importers may throw, but should
 * prefer returning a partial / empty result so the runner can attribute the
 * failure precisely.
 */
export interface Importer {
  readonly key: string;
  import(ctx: ImportContext): Promise<readonly ImportedAsset[]> | readonly ImportedAsset[];
}

/**
 * Interface slot for the M4 lazy-import transport (OOS-2). A runtime
 * `ImportTransport` fetches a missing DDC artefact on demand (the shipped form
 * never falls back to a runtime import; see `AssetErrorCode 'asset-not-imported'`).
 * Declared here as a contract seam only — the HTTP adapter lands in M4 w31;
 * M2 does not implement it (plan-strategy D-6 / research Finding 8).
 */
export interface ImportTransport {
  /**
   * Trigger an on-demand DDC import for a GUID at runtime. On success the
   * transport returns the freshly imported catalog rows for the GUID (and any
   * sub-asset siblings produced by the same import) so the caller patches just
   * those rows into its catalog cache -- per-asset incremental, never a
   * whole-catalog re-fetch (the four-verb redesign, 2026-06-06). `entries` may
   * be empty when the transport imported the artefact but does not surface the
   * rows; the caller then re-resolves the GUID from its (possibly stale) cache.
   * `ok: false` means the import did not produce an artefact and the caller
   * surfaces `asset-not-imported`.
   */
  fetchPack(
    guid: string,
  ): Promise<
    { readonly ok: true; readonly entries?: readonly PackIndexEntry[] } | { readonly ok: false }
  >;
}

// inspector-client is Node-only (imports 'ws'); consume via
//   import { ... } from '@forgeax/engine-types/inspector-client'
