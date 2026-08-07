// errors.ts — FbxError definitions SSOT + factory.
//
// Per requirements AC-09 + plan-strategy D-5 (DIP), FbxErrorCode +
// FbxErrorDetail + FbxError + FBX_ERROR_HINTS are the FBX importer's
// own error SSOT, local to this package. Subsequent milestones append
// per-section members as needed.
//
// Producers MUST go through `fbxErr` so any FbxErrorCode addition that
// lacks a matching detail variant fails at the call site (TS exhaustive
// per-arm).

export { err, ok, type Result } from '@forgeax/engine-types';

// === FbxErrorCode — closed union SSOT ===

/**
 * Closed `FbxErrorCode` union. The source union below is the single authority
 * for parser diagnostics; the ufbx WASM parser needs no native-addon build
 * step.
 *
 * Domain-separated from `ImportErrorCode` (importer dispatch surface in
 * @forgeax/engine-types) and `AssetErrorCode` (runtime registry surface).
 */
export type FbxErrorCode = 'fbx-mesh-type-unsupported' | 'fbx-animation-target-invalid';

// === Per-code detail shapes ===

/** `fbx-mesh-type-unsupported` payload: surface type + mesh name. */
export interface FbxMeshTypeUnsupportedDetail {
  readonly meshType: 'nurbs' | 'patch';
  readonly meshName: string;
}

export type FbxAnimationTargetInvalidDetail =
  | {
      readonly reason: 'hierarchy-cycle';
      readonly nodeIndex: number;
    }
  | {
      readonly reason:
        | 'name-missing'
        | 'path-invalid'
        | 'path-duplicate'
        | 'path-not-found'
        | 'id-collision';
      readonly clipIndex: number;
      readonly channelIndex: number;
      readonly targetNode: string;
    };

/** Discriminated detail family unifying all FbxError variants. */
export type FbxErrorDetail = DetailFor[FbxErrorCode];

// === FbxError discriminated union ===

export type FbxError =
  | {
      readonly code: 'fbx-mesh-type-unsupported';
      readonly expected: string;
      readonly hint: string;
      readonly detail: FbxMeshTypeUnsupportedDetail;
    }
  | {
      readonly code: 'fbx-animation-target-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: FbxAnimationTargetInvalidDetail;
    };

// === FBX_ERROR_HINTS (Record<FbxErrorCode, string>) ===

export const FBX_ERROR_HINTS: Readonly<Record<FbxErrorCode, string>> = {
  'fbx-mesh-type-unsupported':
    'NURBS and patch surfaces are not supported; convert to polygon mesh in a DCC tool before import',
  'fbx-animation-target-invalid':
    'name every node, keep the hierarchy acyclic, and export unique full animation target paths',
};

// === FBX_EXPECTED (Record<FbxErrorCode, string>) ===

const FBX_EXPECTED: Readonly<Record<FbxErrorCode, string>> = {
  'fbx-mesh-type-unsupported':
    'all meshes in the file are polygon (triangles/quads), not NURBS or patch surfaces',
  'fbx-animation-target-invalid':
    'an acyclic hierarchy where every animation channel uniquely matches one named Scene node and stable target ID',
};

// === DetailFor map + fbxErr factory ===

interface DetailFor {
  readonly 'fbx-mesh-type-unsupported': FbxMeshTypeUnsupportedDetail;
  readonly 'fbx-animation-target-invalid': FbxAnimationTargetInvalidDetail;
}

/**
 * Build a fully-typed FbxError. The discriminated-union return type lets
 * call sites narrow with `switch (e.code)` on the result.
 *
 * Charter P3 explicit-failure: `expected` + `hint` fields are sourced from
 * the SSOT tables — no producer can omit them.
 */
export function fbxErr<C extends FbxErrorCode>(
  code: C,
  detail: DetailFor[C],
): Extract<FbxError, { readonly code: C }> {
  return {
    code,
    expected: FBX_EXPECTED[code],
    hint: FBX_ERROR_HINTS[code],
    detail,
  } as Extract<FbxError, { readonly code: C }>;
}
