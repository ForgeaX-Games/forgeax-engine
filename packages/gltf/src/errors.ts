// errors.ts - GltfError definitions SSOT + factory.
//
// Per requirements AC-28 + plan-strategy D-5 (DIP), GltfErrorCode +
// GltfErrorDetail + GltfError + GLTF_ERROR_HINTS are the glTF importer's
// own error SSOT, local to this package. They were migrated here from
// @forgeax/engine-types in feat-20260615-fbx-importer-via-sdk M1 (t7).
//
// Producers MUST go through `gltfErr` so any GltfErrorCode addition that
// lacks a matching detail variant fails at the call site (TS exhaustive
// per-arm).
//
// Result<T, E> + ok / err live in `@forgeax/engine-types` (tweak-20260612-result-
// into-types) and are re-exported for ergonomic single-import from this module.

export {
  createMaterialError,
  err,
  type GltfMaterialUvSetMissingDetail,
  type MaterialError,
  ok,
  type Result,
} from '@forgeax/engine-types';

// === Per-code detail shapes (16 interfaces, 1 discriminated union) ===

/** `gltf-malformed-header` payload: GLB magic / chunk header surface. */
export interface GltfMalformedHeaderDetail {
  readonly filePath: string;
  readonly byteOffset: number;
  readonly magic?: number;
}

/** `gltf-version-unsupported` payload: surfaced asset.version literal. */
export interface GltfVersionUnsupportedDetail {
  readonly filePath: string;
  readonly actualVersion: string;
}

/** `gltf-buffer-out-of-bounds` payload: accessor + bufferView coordinates. */
export interface GltfBufferOutOfBoundsDetail {
  readonly accessor: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly bufferIndex: number;
}

/** `gltf-extension-unsupported` payload: extension name + which array it appeared in. */
export interface GltfExtensionUnsupportedDetail {
  readonly extension: string;
  readonly source: 'extensionsRequired' | 'extensionsUsed';
}

/** `gltf-accessor-type-mismatch` payload: 4-member closed reason discriminator. */
export interface GltfAccessorTypeMismatchDetail {
  readonly accessorIndex: number;
  readonly reason: 'sparse' | 'morph' | 'interleaved' | 'unknownComponentType';
}

/** `gltf-texture-load-failed` payload: URI that failed to load. */
export interface GltfTextureLoadFailedDetail {
  readonly uri: string;
}

/** `gltf-meta-missing` payload: source path + expected sidecar path. */
export interface GltfMetaMissingDetail {
  readonly filePath: string;
  readonly expectedMetaPath: string;
}

/** `gltf-image-mime-unsupported` payload: rejected MIME type. */
export interface GltfImageMimeUnsupportedDetail {
  readonly mimeType: string;
}

/** `gltf-skin-joint-count-exceeded` payload: skin joint count exceeds MAX_JOINTS. */
export interface GltfSkinJointCountExceededDetail {
  readonly skinIndex: number;
  readonly jointCount: number;
  readonly maxJoints: number;
}

/** `gltf-animation-cubicspline-unsupported` payload: CUBICSPLINE sampler. */
export interface GltfAnimationCubicsplineUnsupportedDetail {
  readonly animationIndex: number;
  readonly samplerIndex: number;
}

/** `gltf-morph-unsupported` payload: channel targeting morph weights. */
export interface GltfMorphUnsupportedDetail {
  readonly animationIndex: number;
  readonly channelIndex: number;
  readonly nodeIndex: number;
}

/** `gltf-skin-joint-name-missing` payload: joint node has no name. */
export interface GltfSkinJointNameMissingDetail {
  readonly reason: 'name-missing' | 'hierarchy-cycle';
  readonly skinIndex: number;
  readonly jointPathIndex: number;
  readonly nodeIndex: number;
}

/** `gltf-image-extract-failed` payload: image bytes extraction failure. */
export interface GltfImageExtractFailedDetail {
  readonly imageIndex: number;
  readonly source: 'bufferView' | 'data-uri' | 'external-uri';
  readonly reason: string;
}

/** `gltf-instancing-count-mismatch` payload: TRS accessor count disagreement. */
export interface GltfInstancingCountMismatchDetail {
  readonly nodeIndex: number;
  readonly accessor: 'TRANSLATION' | 'ROTATION' | 'SCALE';
  readonly expectedCount: number;
  readonly actualCount: number;
}

/** `gltf-skin-attr-asymmetric` payload: JOINTS_0/WEIGHTS_0 paired-presence fail. */
export interface GltfSkinAttrAsymmetricDetail {
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly hasJoints: boolean;
  readonly hasWeights: boolean;
}

export interface GltfAnimationTargetInvalidDetail {
  readonly reason:
    | 'name-missing'
    | 'path-invalid'
    | 'path-duplicate'
    | 'path-not-found'
    | 'hierarchy-cycle'
    | 'id-collision';
  readonly animationIndex: number;
  readonly channelIndex: number;
  readonly nodeIndex: number;
}

/** Discriminated detail family unifying all 16 GltfError variants. */
export type GltfErrorDetail = DetailFor[GltfErrorCode];

// === GltfErrorCode and GltfError discriminated union ===

export type GltfErrorCode = keyof DetailFor;

export type GltfError = {
  readonly [C in GltfErrorCode]: {
    readonly code: C;
    readonly expected: string;
    readonly hint: string;
    readonly detail: DetailFor[C];
  };
}[GltfErrorCode];

// === Private per-code policy owner ===

type GltfErrorPolicy = { readonly expected: string; readonly hint: string };

const gltfErrorPolicy = {
  'gltf-malformed-header': {
    expected:
      'GLB 12-byte header (magic 0x46546C67 + version=2 + length) plus mandatory JSON chunk',
    hint: 'verify .glb is not truncated; rerun: forgeax-engine-remote-gltf import <path>',
  },
  'gltf-version-unsupported': {
    expected: 'asset.version === "2.0"',
    hint: 'asset.version must be "2.0"; v1 or v3 not supported',
  },
  'gltf-buffer-out-of-bounds': {
    expected: 'accessor byte range within bufferView.byteLength',
    hint: 'rebuild .gltf with valid bufferViews; check accessor index; ensure accessor.byteOffset + EFFECTIVE_STRIDE * (count - 1) + element_size <= bufferView.byteLength',
  },
  'gltf-extension-unsupported': {
    expected: 'extension listed in v1 allowlist (see EXTENSION_ALLOWLIST in @forgeax/engine-gltf)',
    hint: 'see feat-future-gltf-extensions-allowlist; remove this extension or wait for the allowlist to expand',
  },
  'gltf-accessor-type-mismatch': {
    expected: 'dense fixed-stride accessor with supported componentType',
    hint: 'sparse: see feat-future-gltf-sparse-accessor; morph: see feat-future-gltf-morph; interleaved: see feat-future-gltf-mesh-multi-section',
  },
  'gltf-texture-load-failed': {
    expected: 'externalLoader resolved the URI into an ArrayBuffer without throwing',
    hint: 'check sidecar meta.json + textures/ directory + vite-plugin-pack /__pack/lookup route',
  },
  'gltf-meta-missing': {
    expected: "sidecar <source>.meta.json (importer: 'gltf') present in same directory",
    hint: 'run: forgeax-engine-remote-gltf import <path>',
  },
  'gltf-instancing-count-mismatch': {
    expected: 'all instance attribute accessors share the same count',
    hint: 'EXT_mesh_gpu_instancing requires TRANSLATION/ROTATION/SCALE accessors to share count; see https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/EXT_mesh_gpu_instancing/README.md#extending-nodes-with-instance-attributes',
  },
  'gltf-image-mime-unsupported': {
    expected: 'image/mimeType is image/jpeg or image/png',
    hint: 'convert to JPG/PNG via external tool; only image/jpeg and image/png are supported',
  },
  'gltf-skin-joint-count-exceeded': {
    expected: 'skin.joints.length <= MAX_JOINTS (256)',
    hint: 'reduce joint count below MAX_JOINTS (256) or see OOS-skin-max-joints',
  },
  'gltf-animation-cubicspline-unsupported': {
    expected: 'animation sampler interpolation is LINEAR or STEP',
    hint: 'see OOS-skin-cubicspline; convert CUBICSPLINE to LINEAR/STEP in DCC tool',
  },
  'gltf-morph-unsupported': {
    expected: 'no animation channel targets morph weights (path !== "weights")',
    hint: 'see OOS-skin-morph-anim; remove morph targets from animation channels in DCC tool',
  },
  'gltf-skin-joint-name-missing': {
    expected: 'every joint node has a non-empty name and belongs to an acyclic hierarchy',
    hint: 'ensure every joint node has a non-empty name and the node hierarchy is acyclic',
  },
  'gltf-image-extract-failed': {
    expected:
      'image bytes extractable from bufferView / data-URI / external URI without corruption',
    hint: 'verify the bufferView byte range / data: URI base64 / external URI sibling file is intact next to the .gltf source; rerun: forgeax-engine-remote-gltf import <path>',
  },
  'gltf-skin-attr-asymmetric': {
    expected:
      'mesh primitive declares JOINTS_0 and WEIGHTS_0 symmetrically (both present or both absent)',
    hint: 'glTF spec requires JOINTS_0 and WEIGHTS_0 to appear together for each skinned primitive; add the missing attribute or remove the present one in the DCC tool',
  },
  'gltf-animation-target-invalid': {
    expected:
      'every animation channel resolves to one uniquely named scene node and stable target ID',
    hint: 'name every node in the animated hierarchy and ensure each animated full path is unique',
  },
} satisfies Record<GltfErrorCode, GltfErrorPolicy>;

export const GLTF_ERROR_HINTS: Readonly<Record<GltfErrorCode, string>> = Object.fromEntries(
  Object.entries(gltfErrorPolicy).map(([code, policy]) => [code, policy.hint]),
) as Readonly<Record<GltfErrorCode, string>>;

// === DetailFor map + gltfErr factory ===

interface DetailFor {
  readonly 'gltf-malformed-header': GltfMalformedHeaderDetail;
  readonly 'gltf-version-unsupported': GltfVersionUnsupportedDetail;
  readonly 'gltf-buffer-out-of-bounds': GltfBufferOutOfBoundsDetail;
  readonly 'gltf-extension-unsupported': GltfExtensionUnsupportedDetail;
  readonly 'gltf-accessor-type-mismatch': GltfAccessorTypeMismatchDetail;
  readonly 'gltf-texture-load-failed': GltfTextureLoadFailedDetail;
  readonly 'gltf-meta-missing': GltfMetaMissingDetail;
  readonly 'gltf-instancing-count-mismatch': GltfInstancingCountMismatchDetail;
  readonly 'gltf-image-mime-unsupported': GltfImageMimeUnsupportedDetail;
  readonly 'gltf-skin-joint-count-exceeded': GltfSkinJointCountExceededDetail;
  readonly 'gltf-animation-cubicspline-unsupported': GltfAnimationCubicsplineUnsupportedDetail;
  readonly 'gltf-morph-unsupported': GltfMorphUnsupportedDetail;
  readonly 'gltf-skin-joint-name-missing': GltfSkinJointNameMissingDetail;
  readonly 'gltf-image-extract-failed': GltfImageExtractFailedDetail;
  readonly 'gltf-skin-attr-asymmetric': GltfSkinAttrAsymmetricDetail;
  readonly 'gltf-animation-target-invalid': GltfAnimationTargetInvalidDetail;
}

/**
 * Build a fully-typed GltfError. The discriminated-union return type lets
 * call sites narrow with `switch (e.code)` on the result.
 *
 * Charter proposition 4 explicit-failure: `expected` + `hint` fields are
 * sourced from the SSOT tables - no producer can omit them.
 */
export function gltfErr<C extends GltfErrorCode>(
  code: C,
  detail: DetailFor[C],
): Extract<GltfError, { readonly code: C }> {
  return {
    code,
    expected: gltfErrorPolicy[code].expected,
    hint: gltfErrorPolicy[code].hint,
    detail,
  } as Extract<GltfError, { readonly code: C }>;
}
