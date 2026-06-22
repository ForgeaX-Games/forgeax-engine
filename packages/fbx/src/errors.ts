// errors.ts — FbxError definitions SSOT + factory.
//
// Per requirements AC-09 + plan-strategy D-5 (DIP), FbxErrorCode +
// FbxErrorDetail + FbxError + FBX_ERROR_HINTS are the FBX importer's
// own error SSOT, local to this package. M2 seeds the union with two
// members; subsequent milestones (M3/M4/M5) append per-section members.
//
// Producers MUST go through `fbxErr` so any FbxErrorCode addition that
// lacks a matching detail variant fails at the call site (TS exhaustive
// per-arm).

export { err, ok, type Result } from '@forgeax/engine-types';

// === FbxErrorCode — closed union SSOT (2 members at M2) ===

/**
 * Closed `FbxErrorCode` union. M2 seeds two members:
 * `fbx-binding-not-built` (native addon absent) and
 * `fbx-mesh-type-unsupported` (NURBS/patch).
 *
 * Domain-separated from `ImportErrorCode` (importer dispatch surface in
 * @forgeax/engine-types) and `AssetErrorCode` (runtime registry surface).
 */
export type FbxErrorCode = 'fbx-binding-not-built' | 'fbx-mesh-type-unsupported';

// === Per-code detail shapes (2 interfaces, 1 discriminated union) ===

/** `fbx-binding-not-built` payload: SDK root + expected binding path. */
export interface FbxBindingNotBuiltDetail {
  readonly sdkRoot: string | undefined;
  readonly binding: string;
}

/** `fbx-mesh-type-unsupported` payload: surface type + mesh name. */
export interface FbxMeshTypeUnsupportedDetail {
  readonly meshType: 'nurbs' | 'patch';
  readonly meshName: string;
}

/** Discriminated detail family unifying all FbxError variants. */
export type FbxErrorDetail = FbxBindingNotBuiltDetail | FbxMeshTypeUnsupportedDetail;

// === FbxError discriminated union (2 variants) ===

export type FbxError =
  | {
      readonly code: 'fbx-binding-not-built';
      readonly expected: string;
      readonly hint: string;
      readonly detail: FbxBindingNotBuiltDetail;
    }
  | {
      readonly code: 'fbx-mesh-type-unsupported';
      readonly expected: string;
      readonly hint: string;
      readonly detail: FbxMeshTypeUnsupportedDetail;
    };

// === FBX_ERROR_HINTS (Record<FbxErrorCode, string>) ===

export const FBX_ERROR_HINTS: Readonly<Record<FbxErrorCode, string>> = {
  'fbx-binding-not-built':
    'set FBX_SDK_ROOT to the FBX SDK 2020.3.7 install root, then run: pnpm rebuild @forgeax/engine-fbx',
  'fbx-mesh-type-unsupported':
    'NURBS and patch surfaces are not supported; convert to polygon mesh in a DCC tool before import',
};

// === FBX_EXPECTED (Record<FbxErrorCode, string>) ===

const FBX_EXPECTED: Readonly<Record<FbxErrorCode, string>> = {
  'fbx-binding-not-built':
    'native addon build/Release/fbx_binding.node loadable; FBX_SDK_ROOT set to FBX SDK 2020.3.7 root',
  'fbx-mesh-type-unsupported':
    'all meshes in the file are polygon (triangles/quads), not NURBS or patch surfaces',
};

// === DetailFor map + fbxErr factory ===

interface DetailFor {
  readonly 'fbx-binding-not-built': FbxBindingNotBuiltDetail;
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
