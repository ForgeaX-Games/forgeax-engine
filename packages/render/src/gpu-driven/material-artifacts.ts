import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import type { RenderSystemInternals } from '../record/render-context';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';
import { hasRequiredVertexInputs } from './prepared-draw';

type ArtifactRow = { readonly source: RenderableSnapshot; readonly renderableIndex: number };

/** Resolve programs from one retained, pre-cull row/dispatch index domain. */
export function collectGpuDrivenMaterialArtifacts({
  rows,
  dispatch,
  resolve,
  clustered,
  reflectionFallback,
}: {
  readonly rows: readonly ArtifactRow[];
  readonly dispatch: readonly DispatchEntry[];
  readonly resolve: RenderSystemInternals['getMaterialShaderArtifact'];
  readonly clustered: boolean;
  readonly reflectionFallback: boolean;
}) {
  // The material key is shared by receivers with and without a local probe.
  // Select one probe-capable program for the frame; sentinel rows yield Sky.
  const probeBlend = rows.some((row) => row.source.probeBlendRecord !== undefined);
  // A receiver roster may repeat one publication thousands of times and may
  // serve both main and shadow views. Resolve each selected request once
  // within this collection. The next frame/recovery observes the producer anew.
  const selectedArtifacts = new Map<string, MaterialShaderArtifact | undefined>();
  const materialArtifacts = new Map<string, MaterialShaderArtifact>();
  const shadowMaterialArtifacts = new Map<string, MaterialShaderArtifact>();
  const shadowProgramEntries = new Map<string, DispatchEntry>();
  const forwardProgramEntries = new Map<
    string,
    { readonly vertexEntry?: string; readonly fragmentEntry?: string }
  >();
  for (const entry of dispatch) {
    if (entry.tags.LightMode !== 'Forward' || entry.materialShaderId === undefined) continue;
    const key = `${entry.renderableIndex}:${entry.materialHandle}`;
    if (forwardProgramEntries.has(key)) continue;
    forwardProgramEntries.set(key, {
      ...(entry.vertexEntry === undefined ? {} : { vertexEntry: entry.vertexEntry }),
      ...(entry.fragmentEntry === undefined ? {} : { fragmentEntry: entry.fragmentEntry }),
    });
  }
  for (const entry of dispatch) {
    if (entry.tags.LightMode !== 'ShadowCaster' || entry.materialShaderId === undefined) continue;
    shadowProgramEntries.set(`${entry.renderableIndex}:${entry.materialHandle}`, entry);
  }
  const collectArtifacts = (
    rows: readonly ArtifactRow[],
    pass: 'forward' | 'shadow',
    target: Map<string, MaterialShaderArtifact>,
  ): void => {
    if (resolve === undefined) return;
    for (const row of rows) {
      for (const draw of row.source.gpuDrivenDraws ?? []) {
        const prepared = draw.prepared;
        if (prepared === undefined) continue;
        const material = row.source.materials[draw.materialSlot] ?? row.source.material;
        const programKey = `${row.renderableIndex}:${material.materialHandle ?? -1}`;
        // Keep program identity and entry points on the same selected dispatch.
        // Looking this up per draw must not scan the scene's dispatch roster.
        const shadowProgramEntry = shadowProgramEntries.get(programKey);
        const logicalMaterialShaderId = material.materialShaderId ?? prepared.identity.material;
        const sceneIndexProgramKeys = material.materialSceneIndexProgramKeys;
        const directMaterialShaderId =
          pass === 'shadow' ? shadowProgramEntry?.materialShaderId : logicalMaterialShaderId;
        let sceneIndexProgramKey: string | undefined;
        for (const passName in sceneIndexProgramKeys) {
          const program = sceneIndexProgramKeys[passName];
          if (
            program?.pass === pass &&
            directMaterialShaderId !== undefined &&
            material.materialProgramKeys?.[passName] === directMaterialShaderId
          ) {
            sceneIndexProgramKey = program.specializationKey;
            break;
          }
        }
        // A modern publication may expose a scene-index pair for its
        // forward Pass but omit ShadowCaster. Keep that material on its
        // explicit CPU shadow lane; do not reinterpret its direct WGSL
        // as a scene-index source and fail later at pipeline creation.
        if (sceneIndexProgramKeys !== undefined && sceneIndexProgramKey === undefined) {
          continue;
        }
        const materialShaderId =
          pass === 'shadow'
            ? (sceneIndexProgramKey ??
              shadowProgramEntry?.materialShaderId ??
              logicalMaterialShaderId)
            : (sceneIndexProgramKey ?? logicalMaterialShaderId);
        const programEntry =
          pass === 'shadow' ? shadowProgramEntry : forwardProgramEntries.get(programKey);
        const vertexColorAvailable = prepared.vertexInputs.some(
          (input) => input.semantic === 'color',
        );
        const selectionKey = JSON.stringify([
          materialShaderId,
          logicalMaterialShaderId,
          sceneIndexProgramKey,
          pass,
          prepared.identity.deformation,
          vertexColorAvailable,
          programEntry?.vertexEntry,
          programEntry?.fragmentEntry,
        ]);
        if (!selectedArtifacts.has(selectionKey)) {
          const artifact = resolve(materialShaderId, {
            vertexColorAvailable,
            deformation: prepared.identity.deformation,
            pass,
            address: 'scene-index',
            ...(pass === 'forward'
              ? {
                  clustered: clustered,
                  probeBlend,
                  reflectionFallback: reflectionFallback,
                }
              : {}),
          });
          const selectedArtifact =
            artifact === undefined
              ? undefined
              : programEntry === undefined
                ? artifact
                : {
                    ...artifact,
                    ...(programEntry.vertexEntry === undefined
                      ? {}
                      : { vertexEntry: programEntry.vertexEntry }),
                    ...(programEntry.fragmentEntry === undefined
                      ? {}
                      : { fragmentEntry: programEntry.fragmentEntry }),
                  };
          // A scene-index program has a distinct registry key but the
          // prepared draw keeps the logical material identity for batching
          // and admission. Carry both facts: `material` remains the logical
          // identity, while `specializationKey` tells the raster owner which
          // published WGSL key must be used for pipeline construction.
          const selectedIdentityArtifact =
            selectedArtifact === undefined || sceneIndexProgramKey === undefined
              ? selectedArtifact
              : {
                  ...selectedArtifact,
                  material: logicalMaterialShaderId,
                  specializationKey: sceneIndexProgramKey,
                };
          selectedArtifacts.set(selectionKey, selectedIdentityArtifact);
        }
        const selectedIdentityArtifact = selectedArtifacts.get(selectionKey);
        const receipt = selectedIdentityArtifact?.receipt;
        const shadowVertexInputsMatch =
          pass !== 'shadow' ||
          (receipt !== undefined &&
            hasRequiredVertexInputs(receipt.vertexInputs, prepared.vertexInputs));
        if (
          selectedIdentityArtifact === undefined ||
          receipt === undefined ||
          !shadowVertexInputsMatch ||
          (pass !== 'shadow' &&
            (receipt.receiptIdentity !== prepared.receiptIdentity ||
              receipt.generation !== prepared.receiptGeneration))
        ) {
          continue;
        }
        target.set(
          gpuDrivenMaterialArtifactKey({
            material: prepared.identity.material,
            deformation: prepared.identity.deformation,
            receiptIdentity: prepared.receiptIdentity,
            receiptGeneration: prepared.receiptGeneration,
          }),
          selectedIdentityArtifact,
        );
      }
    }
  };
  collectArtifacts(rows, 'forward', materialArtifacts);
  collectArtifacts(rows, 'shadow', shadowMaterialArtifacts);
  const firstArtifact = materialArtifacts.values().next().value as
    | MaterialShaderArtifact
    | undefined;
  const firstSkinArtifact = [...materialArtifacts.values()].find(
    (artifact) => artifact.receipt?.skinPaletteAddress !== undefined,
  );
  return { materialArtifacts, shadowMaterialArtifacts, firstArtifact, firstSkinArtifact };
}
