import type { AssetErrorDetail, AssetGuid, MeshAsset } from '@forgeax/engine-types';

export type MeshMaterialBindingSource = 'renderer-override' | 'mesh-default' | 'engine-default';

export interface MeshMaterialBindingDiagnostic {
  readonly code:
    | 'mesh-renderer-material-override-invalid'
    | 'mesh-renderer-material-override-overflow';
  readonly slotIndex: number;
  readonly handle?: number;
  /** Structured detail mirrors the renderer error for the active frame. */
  readonly detail?: Readonly<AssetErrorDetail>;
}

export interface ResolvedMeshMaterialBinding {
  readonly handle: number;
  readonly source: MeshMaterialBindingSource;
}

/** Public read-only observation of the bindings used by the last frame. */
export interface MeshMaterialBindingObservation {
  readonly worldId: number;
  readonly entityKey: number;
  readonly bindings: readonly ResolvedMeshMaterialBinding[];
  readonly diagnostics: readonly MeshMaterialBindingDiagnostic[];
}

export type ResolveMeshMaterialBindingsResult =
  | {
      readonly ok: true;
      readonly bindings: readonly ResolvedMeshMaterialBinding[];
      readonly diagnostics: readonly MeshMaterialBindingDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly code: 'mesh-material-slots-missing';
    }
  | {
      readonly ok: false;
      readonly code: 'mesh-default-material-not-ready';
      readonly slotIndex: number;
      readonly defaultMaterial: AssetGuid;
    };

/**
 * Single owner of the instance override -> mesh default -> engine default
 * inheritance rule. It resolves once per logical slot; submeshes only project
 * their materialSlot index onto the returned table.
 */
export function resolveMeshMaterialBindings(
  mesh: MeshAsset,
  rendererOverrides: ArrayLike<number>,
  deps: {
    readonly isValidOverride: (handle: number) => boolean;
    readonly resolveMeshDefault: (guid: AssetGuid) => number | undefined;
  },
): ResolveMeshMaterialBindingsResult {
  const bindings: ResolvedMeshMaterialBinding[] = [];
  const diagnostics: MeshMaterialBindingDiagnostic[] = [];

  if (!Array.isArray(mesh.materialSlots)) {
    return { ok: false, code: 'mesh-material-slots-missing' };
  }

  if (rendererOverrides.length > mesh.materialSlots.length) {
    diagnostics.push({
      code: 'mesh-renderer-material-override-overflow',
      slotIndex: mesh.materialSlots.length,
    });
  }

  for (let slotIndex = 0; slotIndex < mesh.materialSlots.length; slotIndex++) {
    const override = rendererOverrides[slotIndex] ?? 0;
    if (override !== 0 && deps.isValidOverride(override)) {
      bindings.push({ handle: override, source: 'renderer-override' });
      continue;
    }
    if (override !== 0) {
      diagnostics.push({
        code: 'mesh-renderer-material-override-invalid',
        slotIndex,
        handle: override,
      });
    }
    const declaredDefault = mesh.materialSlots[slotIndex]?.defaultMaterial;
    if (declaredDefault !== undefined) {
      const handle = deps.resolveMeshDefault(declaredDefault);
      if (handle === undefined) {
        return {
          ok: false,
          code: 'mesh-default-material-not-ready',
          slotIndex,
          defaultMaterial: declaredDefault,
        };
      }
      bindings.push({ handle, source: 'mesh-default' });
      continue;
    }
    bindings.push({ handle: 0, source: 'engine-default' });
  }

  return { ok: true, bindings, diagnostics };
}
