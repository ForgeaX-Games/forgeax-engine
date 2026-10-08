import { RhiError } from '@forgeax/engine-rhi';
import type { Handle } from '@forgeax/engine-types';
import {
  applyMaterialTextureUvScales,
  applyParamSnapshotToUbo,
  detectNineSliceScaleTooSmall,
  residentTextureView,
  writePbrMaterialUboPayload,
} from './main-pass-material';
import type { _InternalRenderPipelineContext } from './render-context';
import { MATERIAL_PER_ENTITY_STRIDE, MATERIAL_UNIFORM_BYTES } from './render-context';

/** Stage the root parameter storage before any shadow or color pass consumes it. */
export function uploadMaterialUniforms(c: _InternalRenderPipelineContext): void {
  const {
    runtime,
    world,
    store,
    pipelineState,
    validatedOrdered,
    frameState,
    materialSlots,
    materialSlotOwners,
    materialSlotCount,
  } = c;
  if (materialSlotCount === 0) return;
  const cachedMaterialUboPayload = c.materialUboPayloadCache;
  let materialUboPayload: Uint8Array;
  if (
    cachedMaterialUboPayload?.materialSlots === materialSlots &&
    cachedMaterialUboPayload.materialSlotCount === materialSlotCount
  ) {
    materialUboPayload = cachedMaterialUboPayload.payload;
  } else {
    // A new slot table of the same size rewrites the previous payload bytes:
    // `writeBuffer` copies at submit, and the cache is this payload's only
    // other holder, so a per-frame slot table no longer allocates the whole
    // material UBO image (render-worker GC pressure).
    const payloadBytes = materialSlotCount * MATERIAL_PER_ENTITY_STRIDE;
    if (cachedMaterialUboPayload?.payload.byteLength === payloadBytes) {
      materialUboPayload = cachedMaterialUboPayload.payload;
      materialUboPayload.fill(0);
    } else {
      materialUboPayload = new Uint8Array(payloadBytes);
    }
    const slotPayload = new Uint8Array(MATERIAL_UNIFORM_BYTES);
    const slotPayloadF32 = new Float32Array(
      slotPayload.buffer,
      slotPayload.byteOffset,
      slotPayload.byteLength / 4,
    );
    for (let materialSlot = 0; materialSlot < materialSlots.length; materialSlot += 1) {
      const mat = materialSlots[materialSlot];
      const entry = materialSlotOwners[materialSlot];
      if (mat === undefined || entry === undefined) continue;

      // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13 (D-2):
      // single unified Material UBO write path. Sprite materials now flow
      // through the same `buildPbrMaterialUboPayload` baseline +
      // `applyParamSnapshotToUbo` generic std140 overlay every other
      // paramSchema-driven material uses. Extract folds the sprite-specific
      // user inputs into the UBO-aligned paramSnapshot vec4 entries
      // (colorTint / region / pivotAndSize / slicesAndMode); the writer
      // walks `derive(paramSchema).uboLayout.entries` and writes each at
      // its std140 offset. The legacy sprite-specific UBO builder + the
      // sprite-vs-PBR branch are gone (AC-03).
      writePbrMaterialUboPayload(slotPayloadF32, mat);
      // Schema-driven paramSnapshot overlay generalised in feat-20260625
      // M1 / w3: the writer walks `derive(paramSchema).uboLayout.entries`
      // and writes each numeric field at its std140 offset (plan-strategy
      // section 2 D-2). The engine's stock PBR material ships
      // `paramSnapshot: undefined`, so this is a no-op on the default
      // PBR path -- the explicit field writes in buildPbrMaterialUboPayload
      // already cover every byte. User shaders carrying a paramSnapshot
      // (including the post-ablation sprite path) get their fields
      // written at the derive-computed offsets; R-H gate keeps the
      // helper snapshot-only, no asset get.
      const materialShaderId = mat.materialShaderId;
      const schema =
        mat.materialParamSchema ??
        (materialShaderId !== undefined ? runtime.getParamSchema?.(materialShaderId) : undefined);
      applyParamSnapshotToUbo(slotPayloadF32, schema, mat.paramSnapshot);
      const processValue = (
        globalThis as {
          process?: { env?: Record<string, string | undefined> };
        }
      ).process;
      if (
        processValue?.env?.FORGEAX_MATERIAL_PIPELINE_DIAGNOSTICS === '1' &&
        (materialShaderId === 'forgeax::default-standard-pbr' ||
          materialShaderId === 'forgeax::pbr-skin')
      ) {
        console.error(
          `[render-material] UBO receipt: ${JSON.stringify({
            entityIndex: entry.renderableIndex,
            materialHandle: mat.materialHandle,
            materialShaderId,
            clearcoat: slotPayloadF32[32],
            clearcoatRoughness: slotPayloadF32[33],
            clearcoatNormalScale: slotPayloadF32[34],
            paramSnapshot: mat.paramSnapshot,
          })}`,
        );
      }
      applyMaterialTextureUvScales(slotPayloadF32, mat, world);
      // Missing-texture detection: structural debug-pink fallback overrides
      // the baseColor/colorTint slot when a bound baseColorTexture handle
      // resolves to no GPU view. Runs for every textured material path
      // (sprite / sprite-lit / standard-pbr / pbr-skin / unlit) — the bound
      // texture would otherwise silently fall back to the 1x1 white view in
      // the per-submesh BG (main-pass-material.ts), rendering flat with no
      // warn / RhiError. Mirroring the telemetry here makes a missing/failed
      // GLB texture immediately diagnosable instead of a silent flat render
      // (feat-future-pbr-missing-texture-fallback-explicit; feedback
      // 2026-07-04-glb-pbr-textures-not-applied-flat-render).
      //
      // Reads only `mat.baseColorTexture` + the GPU view registry (plan R-H
      // gate: no asset.get<MaterialAsset> reach-back). The debug-pink write
      // lands on f32[0..2], which is baseColor.rgb for the PBR/skin UBO and
      // colorTint.rgb for the sprite UBO — same offset, so one override
      // covers both.
      {
        const matHandleRaw = mat.baseColorTexture as Handle<'TextureAsset', 'shared'> | undefined;
        if (matHandleRaw !== undefined) {
          const view = residentTextureView(entry.world ?? world, store, runtime, matHandleRaw);
          if (view === undefined) {
            const rawId: number = matHandleRaw;
            if (!frameState.warnedMissingBaseColorTextureHandles.has(rawId)) {
              frameState.warnedMissingBaseColorTextureHandles.add(rawId);
              console.warn(
                `[forgeax] baseColor texture ${rawId} missing GPU view, rendering debug pink (shader=${materialShaderId ?? '<none>'} entityIndex=${entry.renderableIndex})`,
              );
            }
            runtime.errorRegistry.fire(
              new RhiError({
                code: 'asset-not-registered',
                expected: 'material baseColor TextureAsset uploaded to GPU',
                hint: 'register + uploadTexture the baseColor texture before draw([world], { cameraOwner: 0, resourceOwner: 0 }); rendering falls back to debug pink until then',
                detail: { assetHandle: rawId },
              }),
            );
            // Debug pink override on slot 0 baseColor/colorTint.rgb (alpha preserved).
            slotPayloadF32[0] = 1.0;
            slotPayloadF32[1] = 0.4;
            slotPayloadF32[2] = 0.7;
          }
        }
      }

      materialUboPayload.set(slotPayload, materialSlot * MATERIAL_PER_ENTITY_STRIDE);
    }

    // Material UBO slots can share one snapshot identity, but nine-slice
    // validity depends on each entity's transform. Preserve diagnostics per
    // renderable instead of inheriting the first owner of a shared slot.
    for (const entry of validatedOrdered) {
      const mat = entry.source.material;
      const materialShaderId = mat.materialShaderId;
      if (materialShaderId !== 'forgeax::sprite' && materialShaderId !== 'forgeax::sprite-lit')
        continue;
      const slicesAndMode = mat.paramSnapshot?.slicesAndMode as readonly number[] | undefined;
      if (slicesAndMode === undefined || slicesAndMode.length < 4) continue;
      const slicesArr: readonly [number, number, number, number] = [
        slicesAndMode[0] ?? 0,
        slicesAndMode[1] ?? 0,
        slicesAndMode[2] ?? 0,
        slicesAndMode[3] ?? 0,
      ];
      if (slicesArr[0] === 0 && slicesArr[1] === 0 && slicesArr[2] === 0 && slicesArr[3] === 0)
        continue;
      detectNineSliceScaleTooSmall(
        entry.source.transform.world,
        slicesArr,
        entry.renderableIndex,
        frameState.warnedNineSliceScaleEntities,
        runtime.metrics,
      );
    }
    c.materialUboPayloadCache = {
      materialSlots,
      materialSlotCount,
      payload: materialUboPayload,
    };
  }

  // All material slots are staged before the first geometry draw. One
  // stride-shaped upload preserves every dynamic offset while avoiding one
  // queue call per material; the RHI still validates alignment and bounds at
  // this single owner-level write boundary.
  const materialUboUpload = runtime.device.queue.writeBuffer(
    pipelineState.materialUniformBuffer.buffer,
    0,
    materialUboPayload,
  );
  if (!materialUboUpload.ok) throw materialUboUpload.error;
}
