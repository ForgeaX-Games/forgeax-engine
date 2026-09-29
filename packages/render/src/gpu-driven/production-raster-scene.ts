import type { BindGroup } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';

export interface StandardPbrFrameResourceBinding {
  readonly entryPoint: string;
  readonly layoutIdentity: string;
  readonly receiptGeneration: number;
  readonly bindGroups: readonly [BindGroup, BindGroup, BindGroup, BindGroup];
  readonly resourceSlots: NonNullable<MaterialShaderArtifact['receipt']>['resourceSlots'];
}

/**
 * Adapt the frame's already-created Standard PBR groups to the GPU-driven
 * scene-index draw. This deliberately accepts group handles rather than
 * rebuilding layouts or shader artifacts; the receipt remains the binding
 * contract and the regular frame producers remain the resource owners.
 */
export function adaptStandardPbrFrameResources(input: {
  readonly artifact: MaterialShaderArtifact;
  readonly view: BindGroup;
  readonly material: BindGroup;
  readonly mesh: BindGroup;
  readonly instances: BindGroup;
}):
  | { readonly ok: true; readonly value: StandardPbrFrameResourceBinding }
  | {
      readonly ok: false;
      readonly error: { readonly code: 'missing-material-receipt' | 'invalid-material-receipt' };
    } {
  const receipt = input.artifact.receipt;
  if (receipt === undefined) return { ok: false, error: { code: 'missing-material-receipt' } };
  const reflected = receipt.reflection;
  const sameSlots =
    reflected.resourceSlots.length === receipt.resourceSlots.length &&
    reflected.resourceSlots.every((slot, index) => {
      const expected = receipt.resourceSlots[index];
      return (
        expected !== undefined &&
        slot.name === expected.name &&
        slot.parameter === expected.parameter &&
        slot.kind === expected.kind &&
        slot.group === expected.group &&
        slot.binding === expected.binding
      );
    });
  if (
    reflected.layoutIdentity !== input.artifact.layoutIdentity ||
    !sameSlots ||
    receipt.resourceSlots.some((slot) => slot.group !== 1)
  ) {
    return { ok: false, error: { code: 'invalid-material-receipt' } };
  }
  return {
    ok: true,
    value: {
      entryPoint: receipt.sceneIndexEntry,
      layoutIdentity: input.artifact.layoutIdentity,
      receiptGeneration: receipt.generation,
      bindGroups: [input.view, input.material, input.mesh, input.instances],
      resourceSlots: receipt.resourceSlots,
    },
  };
}
