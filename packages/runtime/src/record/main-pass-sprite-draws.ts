// @forgeax/engine-runtime - RenderSystem record stage: main-pass sprite draws.
// feat-20260704 M5/w31: further-split from main-pass.ts (AC-05 <=1500 lines/file).
// recordSpritePass + sprite entity/transparent/instance-buffer helpers, moved verbatim.

import { buildMeshAttributeMapForUvSets } from '@forgeax/engine-geometry';
import {
  type BindGroup,
  type Buffer,
  type RenderPipeline,
  RhiError,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import type { Handle, MaterialRenderState } from '@forgeax/engine-types';
import { GpuBuffer } from '../gpu-resource';
import {
  assembleMaterialWithSkylightEntries,
  type EmissiveAoBindGroupResources,
  type SkylightBindGroupResources,
} from '../ibl/skylight-bind-group';
import type { InstanceBufferCacheEntry } from '../instance-buffer-cache';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '../materials';
import { SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET } from '../pbr-pipeline';
import { buildBeginRenderPassDescriptor } from '../pipeline-spec';
import type { _InternalRenderPipelineContext } from '../render-pipeline-context';
import { STANDARD_PBR_UBO_SIZE } from '../render-system';
import type { MaterialSnapshot, SpriteInstancesSnapshot } from '../render-system-extract';
import { worldEntityKey } from './frame-snapshot';
import { entityHasTransparentSubmesh, residentTextureView } from './main-pass-material';
import { interleaveSpriteInstanceBuffer, spriteInstancesCacheHit } from './main-pass-sprite';
import {
  COPY_DST_USAGE,
  extractEntryResourceHandle,
  getOrCreatePerEntity,
  MAX_UNIFORM_INSTANCES,
  MESH_PER_ENTITY_STRIDE,
  STORAGE_USAGE,
  UNIFORM_USAGE,
} from './mesh-ssbo';

/**
 * feat-20260704 M3/w19: LDR sprite split sub-pass, extracted verbatim from
 * recordMainPass. Runs after the geometry pass when there are sprite / LDR
 * transparent entities and the split path is active (splitLdrSprite && a raw
 * unorm swap-chain view exists). Ends the geometry `pass`, opens a `spritePass`
 * on the non-sRGB blend view (loadOp=load), draws the sprite / sprite-lit
 * entities (fold-instanced where possible) then the generic per-submesh
 * transparent PBR submeshes, and ends the sprite pass. Returns the updated
 * `geometryPassEnded` flag so the caller skips the unconditional pass.end().
 *
 * @internal
 */
export function recordSpritePass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  matchedIndices: Set<number> | null,
  materialSlotStart: readonly number[],
  sampleCount: number,
  buildPerSubmeshMaterialBg: (submeshMaterial: MaterialSnapshot, entityKey: number) => BindGroup,
  skylightResources: SkylightBindGroupResources,
): boolean {
  const {
    runtime,
    pipelineState,
    encoder,
    msaaActive,
    ldrSpriteUnormView,
    ldrSpriteColorView,
    geometryDepthView,
    viewBindGroup,
    splitLdrSprite,
  } = c;
  let geometryPassEnded = false;
  if (splitLdrSprite && ldrSpriteUnormView !== null) {
    pass.end();
    geometryPassEnded = true;

    // feat-20260604 M2 / w9 (F-1): under MSAA the sprite sub-pass writes the
    // count=4 unorm view of the SAME multisample texture the geometry pass
    // wrote (loadOp=load preserves geometry under sprites) and resolves the
    // combined result to the single-sample swap-chain unorm view at this
    // (last) pass end. Depth reuses the shared count=4 multisample depth
    // (depthLoadOp=load preserves sprite-vs-mesh occlusion). The single-
    // sample path is byte-for-byte unchanged (writes the swap-chain view).
    const spriteColorView = msaaActive ? ldrSpriteColorView : ldrSpriteUnormView;
    // sprite-split sub-pass: forward shape with both color and depth loaded
    // (preserves prior content from the main forward pass under the sprites).
    // Stencil ops auto-emitted by the helper because depthFormat carries
    // stencil8.
    const spritePass: RhiRenderPassEncoder = encoder.beginRenderPass(
      buildBeginRenderPassDescriptor(
        {
          // bug-20260616: SSOT for the sprite-pass color format is the
          // runtime swap-chain storage format. The sprite PSO target was
          // pre-feat wired to `swapChainFormats.storage` (raw, non-srgb)
          // and this pass writes through the raw view of the same texture
          // (`ldrSpriteUnormView`), so encoder + PSO must agree. Hard-coding
          // `'bgra8unorm'` here broke Channel 3 / dawn-node where the
          // storage format is `rgba8unorm` (Attachment state mismatch fired
          // every frame: PSO target rgba8unorm-srgb vs encoder bgra8unorm).
          colorFormats: [pipelineState.format as unknown as GPUTextureFormat],
          depthFormat: 'depth24plus-stencil8',
          sampleCount: msaaActive ? 4 : 1,
        },
        {
          colorViews: [spriteColorView],
          depthView: geometryDepthView,
          ...(msaaActive ? { resolveTargets: [ldrSpriteUnormView] } : {}),
        },
        'forward',
        { colorLoadOp: 'load', depthLoadOp: 'load' },
      ) as never,
    );

    spritePass.setBindGroup(0, viewBindGroup as BindGroup);

    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w14 (D-7):
    // sprite PSO resolution migrated from the dedicated boot-time PSO
    // fields (deleted) to the generic per-MaterialShader pipeline cache.
    // feat-20260626-collapse M2 / M2-T2: blend factor pair literal moved
    // to the public `SPRITE_PREMULTIPLIED_ALPHA_BLEND` named constant
    // (re-exported from `@forgeax/engine-runtime`) so any AI user
    // building a transparent material declares the same blend by
    // reference; the previous implicit blend-state factory helper is
    // gone. Cache miss still surfaces as a structured
    // `shader-compile-failed` RhiError mirroring the pre-w14 behaviour.
    //
    // feat-20260608-tilemap-object-layer-rendering M2 / m2-t6 (D-8): sprite
    // pipeline cullMode='none'. H/V flip via negative scale x/y (tilemap
    // per-cell entity TRS form) inverts the triangle winding; cullMode='back'
    // would throw the flipped quad away. The sprite pass runs in the
    // alpha-blend transparent bucket back-to-front already, so cullMode='none'
    // adds no overdraw cost. Pre-feat-20260625 the dedicated spritePipeline
    // hard-coded 'none' (deleted in w14); the generic path must replicate
    // it here or the cullmode-flip dawn smoke goes black on negative-scale.
    const spritePremulBlend: MaterialRenderState = {
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
      cullMode: 'none',
      blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND,
    };
    // bug-20260629: PR #526 added PER_INSTANCE_REGION as a second variant
    // axis on sprite.wgsl. Build BOTH variants here; the per-entity loop
    // picks the right one based on whether the entity carries a
    // SpriteInstances snapshot:
    //   - spritePH (PER_INSTANCE_REGION=false): regular per-entity sprites
    //     + fold-bucket instanced draws (64-byte mat4 only instance buf);
    //     UV region comes from the material UBO `region` slot.
    //   - spritePH_withRegion (PER_INSTANCE_REGION=true): SpriteInstances
    //     entities with 80-byte interleaved (mat4 64B + region 16B) per
    //     instance; UV region comes from `instances[idx].region`.
    //
    // Without spritePH_withRegion the SpriteInstances data was uploaded
    // but the shader read bytes 64-79 as region=0 → black quads.
    //
    // feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t7:
    // sprite-lit walks the same LDR transparent split pass with mirror
    // PSO request shape (only materialShaderId string differs). The
    // sprite-lit PSO is fetched lazily per-entity below since the pass
    // mixes sprite + sprite-lit transparent entities. PSO cache strings
    // are isolated by `materialShaderId` (D-11), no slot collision.
    const spritePH =
      runtime.getMaterialShaderPipeline?.(
        'forgeax::sprite',
        /* isHdr */ false,
        spritePremulBlend,
        'triangle-list',
        undefined,
        undefined,
        'forward',
        undefined,
        msaaActive ? 4 : 1,
        // feat-20260625-refactor-sprite-as-transparent-mesh R2 fix-up:
        // the LDR sprite split sub-pass writes through the storage
        // (non-sRGB) view of the swap-chain texture (`ldrSpriteUnormView`;
        // see beginRenderPass colorFormats=`pipelineState.format` above).
        // Pre-w14 the dedicated `forgeax::default-sprite` SPEC_CONST
        // entries baked this non-sRGB mapping into SPRITE_ATTACHMENTS_*
        // (deleted); the generic lazy build path that replaced them
        // defaults to `colorAttachmentFormat` (the sRGB VIEW format used
        // by the geometry pass), so without this override the PSO builds
        // with `rgba8unorm-srgb` while the encoder declares `rgba8unorm`
        // — WebGPU rejects SetPipeline with "Attachment state ... not
        // compatible". Threading `pipelineState.format` (storage,
        // non-sRGB) here keeps PSO + encoder in sync (bug-20260527-
        // sprite-pipeline-bgra8unorm-srgb-not-blendable parity).
        pipelineState.format as unknown as GPUTextureFormat,
      ) ?? null;
    const spritePH_withRegion =
      runtime.getMaterialShaderPipeline?.(
        'forgeax::sprite',
        /* isHdr */ false,
        spritePremulBlend,
        'triangle-list',
        undefined,
        SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET,
        'forward',
        undefined,
        msaaActive ? 4 : 1,
        pipelineState.format as unknown as GPUTextureFormat,
      ) ?? null;

    // bug-20260629: spritePH===null check moved OUTSIDE the entity loop so the
    // sprite pass is properly ended before returning. Inside the loop the early
    // `return` left spritePass open → render-pass-not-ended error every frame
    // where the pipeline is still being compiled (frame 0 on first load).
    //
    // feat-city-glb Bug 5: a missing sprite PSO must NOT abort the whole
    // sub-pass — the generic per-submesh PBR transparent loop below does not
    // depend on the sprite shader. Only skip the sprite ENTITIES when spritePH
    // is null (fire the diagnostic once, iff a sprite entity is actually
    // present), then fall through to the PBR loop. A PBR-only transparent
    // scene (e.g. a glTF BLEND decal, no sprites) renders regardless of
    // whether sprite.wgsl is in the manifest.
    const spriteUnavailable = spritePH === null;
    let spriteUnavailableReported = false;
    const reportSpriteUnavailable = (): void => {
      if (spriteUnavailableReported) return;
      spriteUnavailableReported = true;
      runtime.errorRegistry.fire(
        new RhiError({
          code: 'shader-compile-failed',
          expected:
            'manifest entries include sprite.wgsl + the engine triple (pbr + unlit + tonemap)',
          hint: 'verify @forgeax/engine-vite-plugin-shader emits manifest.json with the 4 engine entries (sprite.wgsl is required when spawning sprite materials); check vite plugin engineEntries option',
        }),
      );
    };

    // feat-20260624 M1' / t7: parallel sprite-lit PSO request — same
    // arg shape, only materialShaderId differs.
    const spriteLitPH =
      runtime.getMaterialShaderPipeline?.(
        'forgeax::sprite-lit',
        /* isHdr */ false,
        spritePremulBlend,
        'triangle-list',
        undefined,
        undefined,
        'forward',
        undefined,
        msaaActive ? 4 : 1,
        pipelineState.format as unknown as GPUTextureFormat,
      ) ?? null;

    recordSpriteEntityDraws(
      c,
      spritePass,
      matchedIndices,
      skylightResources,
      spritePH,
      spritePH_withRegion,
      spriteLitPH,
      spriteUnavailable,
      reportSpriteUnavailable,
    );

    // feat-city-glb Bug 5 (per-submesh transparency): generic per-submesh PBR
    // draws in the LDR blend sub-pass. The sprite loop above handles only true
    // sprite / sprite-lit entities (whole-mesh sprite PSO). EVERY non-sprite
    // transparent material — built-in PBR, single- or multi-submesh, incl.
    // glTF alphaMode=BLEND (the crosswalk decal submesh AND the 4.3-blending
    // window quad) — is drawn here with its real shader + per-submesh
    // geometry, reusing the geometry pass's PBR machinery but rendering into
    // the non-sRGB blend view (colorFormatOverride = pipelineState.format).
    // Opaque submeshes of a mixed mesh were already drawn in the geometry pass
    // (per-submesh skip there).
    //
    // Non-skinned, non-instanced (glTF static meshes): group 2 = the shared
    // frame meshBindGroup with the per-entity dynamic offset; group 3 = the
    // identity instance BG (drawIndexed instanceCount=1). Skinned / instanced
    // transparent submeshes are OOS here (no such content) and fall through.
    recordSpriteTransparentPbrDraws(
      c,
      spritePass,
      matchedIndices,
      materialSlotStart,
      sampleCount,
      buildPerSubmeshMaterialBg,
    );

    spritePass.end();
  }
  return geometryPassEnded;
}

/**
 * feat-20260704 M3/w19: generic per-submesh transparent PBR draws in the LDR
 * blend sub-pass, extracted verbatim from the sprite split pass. Every
 * non-sprite transparent material (built-in PBR, single- or multi-submesh, incl.
 * glTF alphaMode=BLEND) draws here with its real shader + per-submesh geometry,
 * reusing the geometry pass's PBR machinery but rendering into the non-sRGB
 * blend view (colorFormatOverride = pipelineState.format). Opaque submeshes of a
 * mixed mesh were already drawn in the geometry pass (per-submesh skip there).
 * Sprites are handled by the sprite loop; skinned / instanced transparent
 * submeshes are OOS here and fall through.
 *
 * @internal
 */
function recordSpriteTransparentPbrDraws(
  c: _InternalRenderPipelineContext,
  spritePass: RhiRenderPassEncoder,
  matchedIndices: Set<number> | null,
  materialSlotStart: readonly number[],
  sampleCount: number,
  buildPerSubmeshMaterialBg: (submeshMaterial: MaterialSnapshot, entityKey: number) => BindGroup,
): void {
  const { runtime, pipelineState, frameState, bindGroupCounts, validatedOrdered, meshBindGroup } =
    c;
  const MATERIAL_PER_ENTITY_STRIDE = 256;
  let lastPbrSubPipelineHandle: typeof pipelineState.unlitPipeline = null;
  let lastPbrSubVertexBuffer: GpuBuffer | null = null;
  let lastPbrSubIndexBuffer: GpuBuffer | null = null;
  for (let i = 0; i < validatedOrdered.length; i++) {
    const entry = validatedOrdered[i];
    if (entry === undefined) continue;
    if (matchedIndices !== null && !matchedIndices.has(entry.renderableIndex)) continue;
    // Sprites are handled by the sprite loop above; skip them here.
    const entShaderId = entry.source.material.materialShaderId;
    const entIsSprite = entShaderId === 'forgeax::sprite' || entShaderId === 'forgeax::sprite-lit';
    if (entIsSprite) continue;
    // Only entities that carry at least one transparent submesh reach a draw
    // (single-submesh transparent PBR and mixed opaque+transparent meshes).
    if (!entityHasTransparentSubmesh(entry.source)) continue;
    // Skinned / instanced transparent submeshes are not supported in this
    // sub-pass path (no such content today); skip to avoid mis-binding.
    if (entry.source.skin !== undefined || entry.source.instances !== undefined) continue;

    const matsForRebind = entry.source.materials;
    const entityMatBaseOffset = (materialSlotStart[i] ?? 0) * MATERIAL_PER_ENTITY_STRIDE;
    if (entry.mesh.vertexBuffer !== lastPbrSubVertexBuffer) {
      spritePass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
      lastPbrSubVertexBuffer = entry.mesh.vertexBuffer;
    }
    if (
      entry.mesh.indexed &&
      entry.mesh.indexBuffer !== null &&
      entry.mesh.indexBuffer !== lastPbrSubIndexBuffer
    ) {
      spritePass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
      lastPbrSubIndexBuffer = entry.mesh.indexBuffer;
    }
    spritePass.setBindGroup(2, meshBindGroup as BindGroup, [i * MESH_PER_ENTITY_STRIDE]);
    // Identity instance BG (instanceCount=1); reuse the per-entity cache.
    const identityInstBg: BindGroup = getOrCreatePerEntity(
      frameState.instancesBgPerEntity,
      worldEntityKey(entry.source.worldId, entry.source.entityKey),
      [pipelineState.identityInstanceBuffer],
      'instances',
      () => {
        const result = runtime.device.createBindGroup({
          label: 'pbr-transparent-sub-instances-bg',
          layout: pipelineState.instancesBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: { buffer: pipelineState.identityInstanceBuffer },
              },
            },
          ],
        });
        if (!result.ok) throw result.error;
        return result.value;
      },
      bindGroupCounts,
    );
    spritePass.setBindGroup(3, identityInstBg);

    const subVariantSet = frameState.isHdrpActive
      ? ''
      : 'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true';
    const subMeshUvAttributes =
      entry.mesh.uvSetCount > 1 ? buildMeshAttributeMapForUvSets(entry.mesh.uvSetCount) : undefined;

    for (let smIdx = 0; smIdx < entry.mesh.submeshes.length; smIdx++) {
      const sm = entry.mesh.submeshes[smIdx];
      if (sm === undefined) continue;
      const matSlotIdx = smIdx < matsForRebind.length ? smIdx : 0;
      const submeshMaterial = matsForRebind[matSlotIdx] ?? entry.source.material;
      // Only transparent submeshes belong in this blend sub-pass; opaque
      // submeshes were drawn in the geometry pass.
      if (submeshMaterial.transparent !== true) continue;
      const smShaderId = submeshMaterial.materialShaderId;
      if (smShaderId === undefined) continue;

      // Bind the per-submesh material BG first (mirrors the geometry pass
      // order), then resolve the PSO; a first-frame async-compile miss skips
      // only the draw, not the BG (one transient frame, PSO flows in next).
      const subBg = buildPerSubmeshMaterialBg(submeshMaterial, entry.source.entityKey);
      spritePass.setBindGroup(1, subBg, [
        entityMatBaseOffset + matSlotIdx * MATERIAL_PER_ENTITY_STRIDE,
      ]);

      const subPipeline =
        runtime.getMaterialShaderPipeline?.(
          smShaderId,
          /* isHdr */ false,
          entry.renderState,
          sm.topology,
          entry.mesh.indexFormat,
          subVariantSet,
          'forward',
          subMeshUvAttributes,
          sampleCount,
          // Non-sRGB blend view (same override the sprite path uses).
          pipelineState.format as unknown as GPUTextureFormat,
        ) ?? null;
      if (subPipeline === null) continue;

      if (lastPbrSubPipelineHandle !== subPipeline) {
        // biome-ignore lint/suspicious/noExplicitAny: opaque RHI pipeline handle
        spritePass.setPipeline(subPipeline as any);
        lastPbrSubPipelineHandle = subPipeline;
      }
      if (entry.mesh.indexed) {
        spritePass.drawIndexed(sm.indexCount, 1, sm.indexOffset, 0, 0);
      } else {
        spritePass.draw(sm.vertexCount, 1, 0, 0);
      }
    }
  }
}

/**
 * feat-20260704 M3/w19: per-entity sprite / sprite-lit draw loop for the LDR
 * blend sub-pass, extracted verbatim from the sprite split pass. Selects the
 * sprite vs sprite-lit PSO per entity, resolves the per-entity / fold-bucket
 * instance buffer (fold-instanced drawIndexed where a fold bucket applies and
 * the entity has no explicit Instances), uploads the per-entity sprite material
 * UBO slice, binds view / material / mesh / instances groups, and issues the
 * draw. Non-sprite transparent submeshes are drawn separately
 * (recordSpriteTransparentPbrDraws). The loop-invariant sprite PSO handles + the
 * once-per-frame sprite-unavailable diagnostic are threaded in.
 *
 * @internal
 */
function recordSpriteEntityDraws(
  c: _InternalRenderPipelineContext,
  spritePass: RhiRenderPassEncoder,
  matchedIndices: Set<number> | null,
  skylightResources: SkylightBindGroupResources,
  spritePH: RenderPipeline | null,
  spritePH_withRegion: RenderPipeline | null,
  spriteLitPH: RenderPipeline | null,
  spriteUnavailable: boolean,
  reportSpriteUnavailable: () => void,
): void {
  const {
    runtime,
    world,
    store,
    pipelineState,
    frameState,
    bindGroupCounts,
    validatedOrdered,
    meshBindGroup,
    foldDispatchPlan,
  } = c;
  const MATERIAL_PER_ENTITY_STRIDE = 256;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI pipeline handle
  let lastSpritePipelineHandle: any = null;
  let lastSpriteVertexBuffer: GpuBuffer | null = null;
  let lastSpriteIndexBuffer: GpuBuffer | null = null;
  for (let i = 0; i < validatedOrdered.length; i++) {
    const spriteEntry = validatedOrdered[i];
    // feat-20260625 M3 / w13: sub-pass entity filter migrated from
    // `shadingModel === 'sprite'` to `transparent === true` — the
    // shadingModel arm is gone post-feat (plan-strategy D-3).
    if (spriteEntry === undefined || spriteEntry.source.material.transparent !== true) continue;
    // feat-city-glb Bug 5 (per-submesh transparency): this loop is the
    // SPRITE path (whole-mesh sprite / sprite-lit PSO). Non-sprite
    // transparent materials (built-in PBR, incl. glTF alphaMode=BLEND) are
    // drawn per-submesh with their real shader in the dedicated PBR loop
    // below — so skip them here. Previously the 4.3-blending window (a PBR
    // material) was drawn through here with the sprite shader; it now flows
    // through the PBR loop, which is both correct and multi-submesh-capable.
    {
      const sid = spriteEntry.source.material.materialShaderId;
      const isSpriteShader = sid === 'forgeax::sprite' || sid === 'forgeax::sprite-lit';
      if (!isSpriteShader) continue;
    }
    // Sprite PSO unavailable (sprite.wgsl absent / still compiling): skip
    // sprite entities and report once, but do NOT abort the sub-pass — the
    // PBR transparent loop below is independent of the sprite shader.
    if (spriteUnavailable) {
      reportSpriteUnavailable();
      continue;
    }

    // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4-record-swap
    // (D-1): fold-bucket non-head member — skip; the bucket head emits one
    // instanced drawIndexed covering all members.
    if (foldDispatchPlan?.skipIndices.has(i) === true) continue;
    const foldHeadBucket = foldDispatchPlan?.headBuckets.get(i);

    // feat-20260609 M2: skip entities that don't match the pass selector.
    if (matchedIndices !== null && !matchedIndices.has(spriteEntry.renderableIndex)) continue;

    // feat-20260624 M1' / t7: select sprite vs sprite-lit PSO per
    // entity. Both paths share the LDR sub-pass + the same UBO
    // layout; only the shader module + fragment math differ. PSO
    // cache strings are isolated by materialShaderId (D-11) so
    // routing here keeps the cache slots disjoint.
    //
    // bug-20260629: SpriteInstances entities additionally need the
    // PER_INSTANCE_REGION=true variant so the shader reads UV region
    // from the 80B-per-instance interleaved buffer rather than from
    // the material UBO. Only the base sprite path has the per-instance
    // region variant compiled; sprite-lit + non-instances entities
    // keep the PER_INSTANCE_REGION=false variant.
    const entityShaderId = spriteEntry.source.material.materialShaderId;
    const useRegionVariant =
      entityShaderId !== 'forgeax::sprite-lit' && spriteEntry.source.spriteInstances !== undefined;
    const activeSpritePH =
      entityShaderId === 'forgeax::sprite-lit'
        ? spriteLitPH
        : useRegionVariant
          ? spritePH_withRegion
          : spritePH;
    if (activeSpritePH === null) {
      // Variant not yet compiled — for PER_INSTANCE_REGION=true the
      // variant cache fill is async on first use (mirrors the
      // spritePH===null guard above); falling back to the non-region
      // variant would render black quads (region read returns 0).
      // For sprite-lit the manifest may lack sprite-lit.wgsl; either
      // way fail-safe-skip is the closest the renderer can get to
      // "show nothing visibly wrong" without ending the sprite pass
      // (which would drop remaining sprite entities for the frame).
      if (entityShaderId === 'forgeax::sprite-lit') {
        runtime.errorRegistry.fire(
          new RhiError({
            code: 'shader-compile-failed',
            expected:
              'manifest entries include sprite.wgsl + sprite-lit.wgsl (when sprite-lit materials are used) + the engine triple (pbr + unlit + tonemap)',
            hint: 'verify @forgeax/engine-vite-plugin-shader emits manifest.json with sprite.wgsl AND sprite-lit.wgsl entries; check vite plugin engineEntries option',
          }),
        );
      }
      continue;
    }
    if (lastSpritePipelineHandle !== activeSpritePH) {
      // biome-ignore lint/suspicious/noExplicitAny: opaque RHI pipeline handle
      spritePass.setPipeline(activeSpritePH as any);
      lastSpritePipelineHandle = activeSpritePH;
    }

    if (spriteEntry.mesh.vertexBuffer !== lastSpriteVertexBuffer) {
      spritePass.setVertexBuffer(0, spriteEntry.mesh.vertexBuffer.handle);
      lastSpriteVertexBuffer = spriteEntry.mesh.vertexBuffer;
    }
    if (
      spriteEntry.mesh.indexBuffer !== null &&
      spriteEntry.mesh.indexBuffer !== lastSpriteIndexBuffer
    ) {
      spritePass.setIndexBuffer(spriteEntry.mesh.indexBuffer.handle, spriteEntry.mesh.indexFormat);
      lastSpriteIndexBuffer = spriteEntry.mesh.indexBuffer;
    }

    // Instance buffer resolution: same cap-gate logic as the geometry
    // pass entity loop; sprites with Instances (e.g. hello-sprite-atlas
    // 100-instance walk-cycle) require per-entity storage buffer upload.
    // SSOT mirror of geometry pass instances block above (~line 1610):
    // identical cap-gate sequence (storageBuffer cap → limit-exceeded →
    // cache-lookup → createBuffer → writeBuffer); variable names carry
    // "sprite" prefix; logic divergence would be a bug.
    //
    // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4-record-swap
    // (D-1): when `foldHeadBucket !== undefined` AND the sprite entity has
    // no explicit Instances component, assemble the bucket transforms into
    // a transient instance buffer + override `spriteInstanceCount =
    // bucket.bucketSize`. The mesh slot at `i*MESH_PER_ENTITY_STRIDE` was
    // already overwritten to identity in the mesh SSBO upload loop above,
    // so the shader computes `world = identity * bucket.transforms[idx] *
    // pos`, per-instance correct. Entities with explicit Instances bypass
    // fold (their per-entity Instances semantic wins); bucket key forces
    // such an entity to be a singleton bucket in practice because its
    // material is distinct or unfolded, but defensively check here as a
    // belt-and-suspenders guard.
    let spriteInstanceBuffer: Buffer = pipelineState.identityInstanceBuffer;
    let spriteInstanceCount = 1;
    const spriteInst = spriteEntry.source.instances;
    const useFold = foldHeadBucket !== undefined && spriteInst === undefined;
    if (useFold && foldHeadBucket !== undefined) {
      // w6 (D-8): bucket transient buffer reuse — composite cacheKey from
      // (materialHandle, layer, validatedOrdered head index) so the
      // existing `frameState.instanceBuffers` byteLength/archVersion path
      // covers static steady-state upload-skip. Numeric Map<number,…> key
      // requires a 32-bit-safe fold; we use a negative number-space prefix
      // (-1, -2, ...) by `((materialHandle << 16) | i)` shifted into the
      // negative half so it never collides with positive entity-Instances
      // cacheKeys (which are extracted from Instances component cacheKey
      // numeric ids, always non-negative). The `archVersion` proxy is
      // bucketSize (a structural-shape signal) so static frames hit the
      // cache.
      const bucketCacheKey = -1 - (((foldHeadBucket.materialHandle & 0xffff) << 16) | (i & 0xffff));
      const bucketBytes = foldHeadBucket.transforms.byteLength;
      const uniformFallback = runtime.device.caps.storageBuffer === false;
      const bucketBufUsage = uniformFallback
        ? UNIFORM_USAGE | COPY_DST_USAGE
        : STORAGE_USAGE | COPY_DST_USAGE;
      const cachedBucket = frameState.instanceBuffers.get(bucketCacheKey);
      let activeBucket: InstanceBufferCacheEntry | null = null;
      if (
        cachedBucket !== undefined &&
        cachedBucket.uploadedArchVersion === foldHeadBucket.bucketSize &&
        cachedBucket.uploadedByteLength === bucketBytes
      ) {
        activeBucket = cachedBucket;
      } else if (bucketBytes > 0) {
        const bufRes = runtime.device.createBuffer({
          size: bucketBytes,
          usage: bucketBufUsage,
          mappedAtCreation: false,
        });
        if (!bufRes.ok) {
          runtime.errorRegistry.fire(bufRes.error);
        } else {
          if (cachedBucket !== undefined && !cachedBucket.buffer.isDestroyed) {
            const r = cachedBucket.buffer.destroy();
            if (!r.ok) runtime.errorRegistry.fire(r.error);
          }
          const newBuf = new GpuBuffer(runtime.device, bufRes.value);
          activeBucket = {
            buffer: newBuf,
            uploadedArchVersion: foldHeadBucket.bucketSize,
            uploadedByteLength: bucketBytes,
          };
          frameState.instanceBuffers.set(bucketCacheKey, activeBucket);
        }
      }
      if (activeBucket !== null) {
        const writeRes = runtime.device.queue.writeBuffer(
          activeBucket.buffer.handle,
          0,
          foldHeadBucket.transforms,
        );
        if (!writeRes.ok) {
          runtime.errorRegistry.fire(writeRes.error);
        } else {
          spriteInstanceBuffer = activeBucket.buffer.handle;
          spriteInstanceCount = foldHeadBucket.bucketSize;
        }
      }
    } else if (spriteInst !== undefined) {
      const uniformFallback = runtime.device.caps.storageBuffer === false;
      let spriteBufUsage = STORAGE_USAGE | COPY_DST_USAGE;

      if (uniformFallback) {
        if (spriteInst.instanceCount > MAX_UNIFORM_INSTANCES) {
          runtime.errorRegistry.fire(
            new RhiError({
              code: 'limit-exceeded',
              expected: `instance count <= ${MAX_UNIFORM_INSTANCES} (uniform fallback cap)`,
              hint: `reduce instance count to ${MAX_UNIFORM_INSTANCES} or use a WebGPU-capable backend`,
              detail: {
                maxStorageBufferBindingSize: MAX_UNIFORM_INSTANCES * 64,
                requestedBytes: spriteInst.instanceCount * 64,
              },
            }),
          );
          spriteInstanceCount = spriteInst.instanceCount;
          spriteInstanceBuffer = pipelineState.identityInstanceBuffer;
          const spriteInstBgResult = runtime.device.createBindGroup({
            label: 'sprite-pass-instances-bg',
            layout: pipelineState.instancesBindGroupLayout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'buffer',
                  value: { buffer: spriteInstanceBuffer },
                },
              },
            ],
            // biome-ignore lint/suspicious/noExplicitAny: opaque RHI descriptor
          }) as any;
          if (!spriteInstBgResult.ok) throw spriteInstBgResult.error;
          spritePass.setBindGroup(3, spriteInstBgResult.value as BindGroup);
          spritePass.drawIndexed(spriteEntry.mesh.indexCount, spriteInstanceCount, 0, 0, 0);
          continue;
        }
        spriteBufUsage = UNIFORM_USAGE | COPY_DST_USAGE;
      }

      {
        const requestedBytes = spriteInst.transforms.byteLength;
        const cap = runtime.device.limits.maxStorageBufferBindingSize;
        if (typeof cap === 'number' && requestedBytes > cap) {
          runtime.errorRegistry.fire(
            new RhiError({
              code: 'limit-exceeded',
              expected: `requestedBytes (${requestedBytes}) <= maxStorageBufferBindingSize (${cap})`,
              hint: 'reduce instance count to fit within device.limits.maxStorageBufferBindingSize, or split transforms across multiple Instances entries',
              detail: {
                maxStorageBufferBindingSize: cap,
                requestedBytes,
              },
            }),
          );
        } else {
          const cachedSprite = frameState.instanceBuffers.get(
            worldEntityKey(spriteEntry.source.worldId, spriteInst.cacheKey),
          );
          let activeSprite: InstanceBufferCacheEntry | null = null;
          if (
            cachedSprite !== undefined &&
            cachedSprite.uploadedArchVersion === spriteInst.archVersion &&
            cachedSprite.uploadedByteLength === requestedBytes
          ) {
            activeSprite = cachedSprite;
          } else if (requestedBytes > 0) {
            const bufRes = runtime.device.createBuffer({
              size: requestedBytes,
              usage: spriteBufUsage,
              mappedAtCreation: false,
            });
            if (!bufRes.ok) {
              runtime.errorRegistry.fire(bufRes.error);
            } else {
              // feat-20260619 M4 / F12: destroy the old cached buffer
              // before replacing it with the new one (D-6).
              if (cachedSprite !== undefined && !cachedSprite.buffer.isDestroyed) {
                const r = cachedSprite.buffer.destroy();
                if (!r.ok) runtime.errorRegistry.fire(r.error);
              }
              const newBuf = new GpuBuffer(runtime.device, bufRes.value);
              activeSprite = {
                buffer: newBuf,
                uploadedArchVersion: spriteInst.archVersion,
                uploadedByteLength: requestedBytes,
              };
              frameState.instanceBuffers.set(
                worldEntityKey(spriteEntry.source.worldId, spriteInst.cacheKey),
                activeSprite,
              );
            }
          }
          if (activeSprite !== null) {
            const writeRes = runtime.device.queue.writeBuffer(
              activeSprite.buffer.handle,
              0,
              spriteInst.transforms,
            );
            if (!writeRes.ok) {
              runtime.errorRegistry.fire(writeRes.error);
            } else {
              spriteInstanceBuffer = activeSprite.buffer.handle;
              spriteInstanceCount = Math.max(1, spriteInst.instanceCount);
            }
          }
        }
      }
    }

    // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch
    // M3 / w11: SpriteInstances 80B-per-instance interleaved upload path.
    // SSOT for the per-entity 2D mat4 + per-instance UV region buffer
    // (plan-strategy D-1 interleaved single buffer + single binding slot;
    // D-9 cacheKey = entity packed u32). The extract-stage validator
    // (M3 / w10) enforces the XOR contract `Instances XOR SpriteInstances`
    // (sprite-instances-mutually-exclusive-with-instances), so the
    // legacy `spriteInst` block above and this block are never both
    // active for the same entity.
    const _si = resolveSpriteInstancesBuffer(
      c,
      spriteEntry,
      spriteInstanceBuffer,
      spriteInstanceCount,
    );
    spriteInstanceBuffer = _si.buffer;
    spriteInstanceCount = _si.count;

    // M3 / w12: LDR sprite split pass per-entity instances BG cache.
    // Same pattern as #7.
    const spriteInstancesBg: BindGroup = getOrCreatePerEntity(
      frameState.instancesBgPerEntity,
      worldEntityKey(spriteEntry.source.worldId, spriteEntry.source.entityKey),
      [spriteInstanceBuffer],
      'instances',
      () => {
        const result = runtime.device.createBindGroup({
          label: 'sprite-pass-instances-bg',
          layout: pipelineState.instancesBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: { buffer: spriteInstanceBuffer },
              },
            },
          ],
        });
        if (!result.ok) throw result.error;
        return result.value;
      },
      bindGroupCounts,
    );

    spritePass.setBindGroup(2, meshBindGroup as BindGroup, [i * MESH_PER_ENTITY_STRIDE]);

    // Per-entity sprite material bind group: same 7-entry layout as in
    // the geometry pass sprite branch + Skylight merged entries (same
    // skylightResources in scope from above). Texture view is resolved
    // from the sprite material's baseColorTexture handle.
    const spriteTexHandle = spriteEntry.source.material.baseColorTexture as
      | Handle<'TextureAsset', 'shared'>
      | undefined;
    let spriteTexView = pipelineState.defaultWhiteTextureView;
    if (spriteTexHandle !== undefined) {
      const tv = residentTextureView(world, store, runtime, spriteTexHandle);
      if (tv !== undefined) spriteTexView = tv as never;
    }
    const spritePassBaseMaterialEntries = [
      {
        binding: 0,
        resource: {
          kind: 'buffer' as const,
          value: {
            buffer: pipelineState.materialUniformBuffer.buffer,
            offset: 0,
            size: STANDARD_PBR_UBO_SIZE,
          },
        },
      },
      {
        binding: 1,
        resource: { kind: 'sampler' as const, value: pipelineState.nearestSampler },
      },
      { binding: 2, resource: { kind: 'textureView' as const, value: spriteTexView } },
      {
        binding: 3,
        resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
      },
      {
        binding: 4,
        resource: {
          kind: 'textureView' as const,
          value: pipelineState.defaultWhiteTextureView,
        },
      },
      {
        binding: 5,
        resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
      },
      {
        binding: 6,
        resource: {
          kind: 'textureView' as const,
          value: pipelineState.defaultNormalTextureView,
        },
      },
    ];
    const spritePassEmissiveAo: EmissiveAoBindGroupResources = {
      emissiveSampler: pipelineState.defaultSampler,
      emissiveView: pipelineState.defaultWhiteTextureView,
      occlusionSampler: pipelineState.defaultSampler,
      occlusionView: pipelineState.defaultWhiteTextureView,
    };
    const spritePassMergedEntries = assembleMaterialWithSkylightEntries(
      spritePassBaseMaterialEntries,
      skylightResources,
      spritePassEmissiveAo,
    );

    // Sprite-pass material BG cache: keyed on shader id (shared across all
    // sprite entities) so entities using the same atlas texture share one
    // BindGroup instead of creating one per entity (O5 fix — inner WeakMap
    // chain naturally deduplicates by GPU resource object identity, so two
    // entities with different atlases still get distinct BGs).
    const spritePassBg: BindGroup = getOrCreatePerEntity(
      frameState.materialBgShared,
      'forgeax::sprite',
      spritePassMergedEntries.map((e) => extractEntryResourceHandle(e)),
      'sprite-pass-material',
      () => {
        const result = runtime.device.createBindGroup({
          label: 'sprite-pass-material-bg',
          layout: pipelineState.materialBindGroupLayout,
          entries: spritePassMergedEntries,
        });
        if (!result.ok) throw result.error;
        return result.value;
      },
      bindGroupCounts,
    );

    spritePass.setBindGroup(1, spritePassBg, [i * MATERIAL_PER_ENTITY_STRIDE]);
    spritePass.setBindGroup(3, spriteInstancesBg);
    spritePass.drawIndexed(spriteEntry.mesh.indexCount, spriteInstanceCount, 0, 0, 0);
  }
}

/**
 * feat-20260704 M3/w19: resolve the interleaved SpriteInstances (@group(3))
 * buffer + instanceCount for a sprite entity in the LDR blend sub-pass,
 * extracted verbatim from recordSpriteEntityDraws. Uploads the interleaved
 * mat4 + per-instance UV region transforms (cache-keyed on the snapshot); on
 * over-cap fires the structured limit-exceeded error and leaves the passed-in
 * fallback buffer/count. Returns the resolved (or unchanged) buffer + count.
 *
 * @internal
 */
function resolveSpriteInstancesBuffer(
  c: _InternalRenderPipelineContext,
  spriteEntry: _InternalRenderPipelineContext['validatedOrdered'][number],
  fallbackBuffer: Buffer,
  fallbackCount: number,
): { buffer: Buffer; count: number } {
  const { runtime, frameState } = c;
  let buffer = fallbackBuffer;
  let count = fallbackCount;
  const spriteInstancesSnap: SpriteInstancesSnapshot | undefined =
    spriteEntry.source.spriteInstances;
  if (spriteInstancesSnap !== undefined) {
    const requestedBytes =
      spriteInstancesSnap.transforms.byteLength + spriteInstancesSnap.regions.byteLength;
    const cap = runtime.device.limits.maxStorageBufferBindingSize;
    if (typeof cap === 'number' && requestedBytes > cap) {
      runtime.errorRegistry.fire(
        new RhiError({
          code: 'limit-exceeded',
          expected: `requestedBytes (${requestedBytes}) <= maxStorageBufferBindingSize (${cap})`,
          hint: 'reduce SpriteInstances instance count to fit within device.limits.maxStorageBufferBindingSize (80 bytes per instance: mat4 64B + region 16B)',
          detail: {
            maxStorageBufferBindingSize: cap,
            requestedBytes,
          },
        }),
      );
    } else {
      const cachedSpriteInst = frameState.instanceBuffers.get(
        worldEntityKey(spriteEntry.source.worldId, spriteInstancesSnap.cacheKey),
      );
      let activeSpriteInst: InstanceBufferCacheEntry | null = null;
      if (spriteInstancesCacheHit(cachedSpriteInst, spriteInstancesSnap, requestedBytes)) {
        activeSpriteInst = cachedSpriteInst ?? null;
      } else if (requestedBytes > 0) {
        const bufRes = runtime.device.createBuffer({
          size: requestedBytes,
          usage: STORAGE_USAGE | COPY_DST_USAGE,
          mappedAtCreation: false,
        });
        if (!bufRes.ok) {
          runtime.errorRegistry.fire(bufRes.error);
        } else {
          if (cachedSpriteInst !== undefined && !cachedSpriteInst.buffer.isDestroyed) {
            const r = cachedSpriteInst.buffer.destroy();
            if (!r.ok) runtime.errorRegistry.fire(r.error);
          }
          const newBuf = new GpuBuffer(runtime.device, bufRes.value);
          activeSpriteInst = {
            buffer: newBuf,
            uploadedArchVersion: spriteInstancesSnap.archVersion,
            uploadedByteLength: requestedBytes,
          };
          frameState.instanceBuffers.set(
            worldEntityKey(spriteEntry.source.worldId, spriteInstancesSnap.cacheKey),
            activeSpriteInst,
          );
        }
      }
      if (activeSpriteInst !== null && requestedBytes > 0) {
        const interleaved = interleaveSpriteInstanceBuffer(
          spriteInstancesSnap.transforms,
          spriteInstancesSnap.regions,
        );
        const writeRes = runtime.device.queue.writeBuffer(
          activeSpriteInst.buffer.handle,
          0,
          interleaved,
        );
        if (!writeRes.ok) {
          runtime.errorRegistry.fire(writeRes.error);
        } else {
          buffer = activeSpriteInst.buffer.handle;
          count = spriteInstancesSnap.instanceCount;
        }
      }
    }
  }
  return { buffer, count };
}
