// errors.ts — FbxError definitions SSOT + factory.
//
// Per requirements AC-09 + plan-strategy D-5 (DIP), FbxErrorCode +
// FbxErrorDetail + FbxError + FBX_ERROR_HINTS are the FBX importer's
// own error SSOT, local to this package. After the ufbx WASM collapse the
// union carries a single member; subsequent milestones append per-section
// members as needed.
//
// Producers MUST go through `fbxErr` so any FbxErrorCode addition that
// lacks a matching detail variant fails at the call site (TS exhaustive
// per-arm).

export { err, ok, type Result } from '@forgeax/engine-types';

// === FbxErrorCode — closed union SSOT (1 member) ===

/**
 * Closed `FbxErrorCode` union. The ufbx WASM parser needs no native-addon
 * build step, so the SDK-era binding-availability code retired; the sole
 * member is `fbx-mesh-type-unsupported` (NURBS/patch surfaces).
 *
 * Domain-separated from `ImportErrorCode` (importer dispatch surface in
 * @forgeax/engine-types) and `AssetErrorCode` (runtime registry surface).
 */
export type FbxErrorCode = 'fbx-mesh-type-unsupported';

// === Per-code detail shapes (1 interface, 1 discriminated union) ===

/** `fbx-mesh-type-unsupported` payload: surface type + mesh name. */
export interface FbxMeshTypeUnsupportedDetail {
  readonly meshType: 'nurbs' | 'patch';
  readonly meshName: string;
}

/** Discriminated detail family unifying all FbxError variants. */
export type FbxErrorDetail = FbxMeshTypeUnsupportedDetail;

// === FbxError discriminated union (1 variant) ===

export type FbxError = {
  readonly code: 'fbx-mesh-type-unsupported';
  readonly expected: string;
  readonly hint: string;
  readonly detail: FbxMeshTypeUnsupportedDetail;
};

// === FBX_ERROR_HINTS (Record<FbxErrorCode, string>) ===

export const FBX_ERROR_HINTS: Readonly<Record<FbxErrorCode, string>> = {
  'fbx-mesh-type-unsupported':
    'NURBS and patch surfaces are not supported; convert to polygon mesh in a DCC tool before import',
};

// === FBX_EXPECTED (Record<FbxErrorCode, string>) ===

const FBX_EXPECTED: Readonly<Record<FbxErrorCode, string>> = {
  'fbx-mesh-type-unsupported':
    'all meshes in the file are polygon (triangles/quads), not NURBS or patch surfaces',
};

// === DetailFor map + fbxErr factory ===

interface DetailFor {
  readonly 'fbx-mesh-type-unsupported': FbxMeshTypeUnsupportedDetail;
}

/**
 * Build a fully-typed FbxError. The discriminated-union return type lets
 * call sites narrow with `switch (e.code)` on the result.
 *
 * Charter P3 explicit-failure: `expected` + `hint` fields are sourced from
 * the SSOT tables — no producer can omit them.
 */
export function fbxErr<C extends FbxErrorCode>(code: C, detail: DetailFor[C]): FbxError {
  return {
    code,
    expected: FBX_EXPECTED[code],
    hint: FBX_ERROR_HINTS[code],
    detail,
  } as FbxError;
}
