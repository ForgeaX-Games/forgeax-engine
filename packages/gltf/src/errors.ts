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

export { err, ok, type Result } from '@forgeax/engine-types';

// === GltfErrorCode — closed union SSOT (15 members) ===

/**
 * Closed `GltfErrorCode` union - 15 members (9 original + 4 skin/animation
 * added in feat-20260523 + `gltf-image-extract-failed` added in
 * feat-20260608 M3 D-6 + `gltf-skin-attr-asymmetric` added in
 * feat-20260611 M1 w3).
 *
 * Domain-separated from `AssetErrorCode` (runtime registry surface) and
 * `ImportErrorCode` (importer dispatch surface). AI users face these 15
 * alternatives at the importer surface.
 */
export type GltfErrorCode =
  | 'gltf-malformed-header'
  | 'gltf-version-unsupported'
  | 'gltf-buffer-out-of-bounds'
  | 'gltf-extension-unsupported'
  | 'gltf-accessor-type-mismatch'
  | 'gltf-texture-load-failed'
  | 'gltf-meta-missing'
  | 'gltf-instancing-count-mismatch'
  | 'gltf-image-mime-unsupported'
  | 'gltf-skin-joint-count-exceeded'
  | 'gltf-animation-cubicspline-unsupported'
  | 'gltf-morph-unsupported'
  | 'gltf-skin-joint-name-missing'
  | 'gltf-image-extract-failed'
  | 'gltf-skin-attr-asymmetric';

// === Per-code detail shapes (15 interfaces, 1 discriminated union) ===

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

/** Discriminated detail family unifying all 15 GltfError variants. */
export type GltfErrorDetail =
  | GltfMalformedHeaderDetail
  | GltfVersionUnsupportedDetail
  | GltfBufferOutOfBoundsDetail
  | GltfExtensionUnsupportedDetail
  | GltfAccessorTypeMismatchDetail
  | GltfTextureLoadFailedDetail
  | GltfMetaMissingDetail
  | GltfInstancingCountMismatchDetail
  | GltfImageMimeUnsupportedDetail
  | GltfSkinJointCountExceededDetail
  | GltfAnimationCubicsplineUnsupportedDetail
  | GltfMorphUnsupportedDetail
  | GltfSkinJointNameMissingDetail
  | GltfImageExtractFailedDetail
  | GltfSkinAttrAsymmetricDetail;

// === GltfError discriminated union (15 variants) ===

export type GltfError =
  | {
      readonly code: 'gltf-malformed-header';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfMalformedHeaderDetail;
    }
  | {
      readonly code: 'gltf-version-unsupported';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfVersionUnsupportedDetail;
    }
  | {
      readonly code: 'gltf-buffer-out-of-bounds';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfBufferOutOfBoundsDetail;
    }
  | {
      readonly code: 'gltf-extension-unsupported';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfExtensionUnsupportedDetail;
    }
  | {
      readonly code: 'gltf-accessor-type-mismatch';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfAccessorTypeMismatchDetail;
    }
  | {
      readonly code: 'gltf-meta-missing';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfMetaMissingDetail;
    }
  | {
      readonly code: 'gltf-texture-load-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfTextureLoadFailedDetail;
    }
  | {
      readonly code: 'gltf-instancing-count-mismatch';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfInstancingCountMismatchDetail;
    }
  | {
      readonly code: 'gltf-image-mime-unsupported';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfImageMimeUnsupportedDetail;
    }
  | {
      readonly code: 'gltf-skin-joint-count-exceeded';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfSkinJointCountExceededDetail;
    }
  | {
      readonly code: 'gltf-animation-cubicspline-unsupported';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfAnimationCubicsplineUnsupportedDetail;
    }
  | {
      readonly code: 'gltf-morph-unsupported';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfMorphUnsupportedDetail;
    }
  | {
      readonly code: 'gltf-skin-joint-name-missing';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfSkinJointNameMissingDetail;
    }
  | {
      readonly code: 'gltf-image-extract-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfImageExtractFailedDetail;
    }
  | {
      readonly code: 'gltf-skin-attr-asymmetric';
      readonly expected: string;
      readonly hint: string;
      readonly detail: GltfSkinAttrAsymmetricDetail;
    };

// === GLTF_ERROR_HINTS (Record<GltfErrorCode, string>) ===

export const GLTF_ERROR_HINTS: Readonly<Record<GltfErrorCode, string>> = {
  'gltf-malformed-header':
    'verify .glb is not truncated; rerun: forgeax-engine-console-gltf import <path>',
  'gltf-version-unsupported': 'asset.version must be "2.0"; v1 or v3 not supported',
  'gltf-buffer-out-of-bounds':
    'rebuild .gltf with valid bufferViews; check accessor index; ensure accessor.byteOffset + EFFECTIVE_STRIDE * (count - 1) + element_size <= bufferView.byteLength',
  'gltf-extension-unsupported':
    'see feat-future-gltf-extensions-allowlist; remove this extension or wait for the allowlist to expand',
  'gltf-accessor-type-mismatch':
    'sparse: see feat-future-gltf-sparse-accessor; morph: see feat-future-gltf-morph; interleaved: see feat-future-gltf-mesh-multi-section',
  'gltf-texture-load-failed':
    'check sidecar meta.json + textures/ directory + vite-plugin-pack /__pack/lookup route',
  'gltf-meta-missing': 'run: forgeax-engine-console-gltf import <path>',
  'gltf-instancing-count-mismatch':
    'EXT_mesh_gpu_instancing requires TRANSLATION/ROTATION/SCALE accessors to share count; see https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/EXT_mesh_gpu_instancing/README.md#extending-nodes-with-instance-attributes',
  'gltf-image-mime-unsupported':
    'convert to JPG/PNG via external tool; only image/jpeg and image/png are supported',
  'gltf-skin-joint-count-exceeded':
    'reduce joint count below MAX_JOINTS (256) or see OOS-skin-max-joints',
  'gltf-animation-cubicspline-unsupported':
    'see OOS-skin-cubicspline; convert CUBICSPLINE to LINEAR/STEP in DCC tool',
  'gltf-morph-unsupported':
    'see OOS-skin-morph-anim; remove morph targets from animation channels in DCC tool',
  'gltf-skin-joint-name-missing':
    'ensure every joint node in the skin has a non-empty name in the DCC tool',
  'gltf-image-extract-failed':
    'verify the bufferView byte range / data: URI base64 / external URI sibling file is intact next to the .gltf source; rerun: forgeax-engine-console-gltf import <path>',
  'gltf-skin-attr-asymmetric':
    'glTF spec requires JOINTS_0 and WEIGHTS_0 to appear together for each skinned primitive; add the missing attribute or remove the present one in the DCC tool',
};

// === GLTF_EXPECTED (Record<GltfErrorCode, string>) ===

const GLTF_EXPECTED: Readonly<Record<GltfErrorCode, string>> = {
  'gltf-malformed-header':
    'GLB 12-byte header (magic 0x46546C67 + version=2 + length) plus mandatory JSON chunk',
  'gltf-version-unsupported': 'asset.version === "2.0"',
  'gltf-buffer-out-of-bounds': 'accessor byte range within bufferView.byteLength',
  'gltf-extension-unsupported':
    'extension listed in v1 allowlist (see EXTENSION_ALLOWLIST in @forgeax/engine-gltf)',
  'gltf-accessor-type-mismatch': 'dense fixed-stride accessor with supported componentType',
  'gltf-texture-load-failed':
    'externalLoader resolved the URI into an ArrayBuffer without throwing',
  'gltf-meta-missing': "sidecar <source>.meta.json (importer: 'gltf') present in same directory",
  'gltf-instancing-count-mismatch': 'all instance attribute accessors share the same count',
  'gltf-image-mime-unsupported': 'image/mimeType is image/jpeg or image/png',
  'gltf-skin-joint-count-exceeded': 'skin.joints.length <= MAX_JOINTS (256)',
  'gltf-animation-cubicspline-unsupported': 'animation sampler interpolation is LINEAR or STEP',
  'gltf-morph-unsupported': 'no animation channel targets morph weights (path !== "weights")',
  'gltf-skin-joint-name-missing': 'every joint node has a non-empty name',
  'gltf-image-extract-failed':
    'image bytes extractable from bufferView / data-URI / external URI without corruption',
  'gltf-skin-attr-asymmetric':
    'mesh primitive declares JOINTS_0 and WEIGHTS_0 symmetrically (both present or both absent)',
};

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
}

/**
 * Build a fully-typed GltfError. The discriminated-union return type lets
 * call sites narrow with `switch (e.code)` on the result.
 *
 * Charter proposition 4 explicit-failure: `expected` + `hint` fields are
 * sourced from the SSOT tables - no producer can omit them.
 */
export function gltfErr<C extends GltfErrorCode>(code: C, detail: DetailFor[C]): GltfError {
  return {
    code,
    expected: GLTF_EXPECTED[code],
    hint: GLTF_ERROR_HINTS[code],
    detail,
  } as GltfError;
}
