// @forgeax/engine-runtime - RenderSystem record stage: main-pass geometry draws.
// feat-20260704 M5/w31: further-split from main-pass.ts (AC-05 <=1500 lines/file).
// recordGeometryDraws + resolveGeometryInstanceBuffer, moved verbatim.

import { buildMeshAttributeMapForUvSets } from '@forgeax/engine-geometry';
import {
  type BindGroup,
  type Buffer,
  RhiError,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { GpuBuffer } from '../gpu-resource';
import type { InstanceBufferCacheEntry } from '../instance-buffer-cache';
import { SKIN_MATERIAL_SHADER_ID } from '../pbr-pipeline';
import type { _InternalRenderPipelineContext } from '../render-pipeline-context';
import type { MaterialSnapshot } from '../render-system-extract';
import { isEntityFullyTransparent, selectGeometryPipeline } from './main-pass-material';
import { _computeSkinGroup2DynOffsets } from './main-pass-skin';
import {
  COPY_DST_USAGE,
  getOrCreateFromChain,
  getOrCreatePerEntity,
  MAX_UNIFORM_INSTANCES,
  MESH_SSBO_BYTES,
  MESH_UBO_FULL_ARRAY_BYTES,
  STORAGE_USAGE,
  UNIFORM_USAGE,
} from './mesh-ssbo';

/**
 * feat-20260704 M3/w19: per-entity geometry (main colour) draw loop, extracted
 * verbatim from recordMainPass. Walks `c.validatedOrdered`, selects the
 * per-entity / per-submesh PBR / unlit / skin pipeline, uploads the per-submesh
 * material UBO slices, binds view / material / mesh / instances bind groups, and
 * issues the per-submesh draws into the already-begun geometry `pass`. Fully-
 * transparent entities are skipped here (drawn in the LDR blend sub-pass);
 * mixed meshes draw their opaque submeshes here and skip transparent submeshes.
 * The pass-selector match set, per-entity material-slot start table, MSAA sample
 * count, group(2) bind group, and the shared per-submesh material BG builder are
 * threaded in explicitly.
 *
 * @internal
 */
export function recordGeometryDraws(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  matchedIndices: Set<number> | null,
  materialSlotStart: readonly number[],
  sampleCount: number,
  meshGroup2: BindGroup | null,
  buildPerSubmeshMaterialBg: (submeshMaterial: MaterialSnapshot, entityKey: number) => BindGroup,
): void {
  const {
    runtime,
    pipelineState,
    frameState,
    bindGroupCounts,
    dispatchCounts,
    tonemapActive,
    msaaActive,
    validatedOrdered,
    splitLdrSprite,
  } = c;
  const MATERIAL_PER_ENTITY_STRIDE = 256;
  let lastVertexBuffer: GpuBuffer | null = null;
  let lastIndexBuffer: GpuBuffer | null = null;
  // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w14 (D-7):
  // sprite PSO selection no longer maintains a dedicated tag — the
  // generic materialShaderId path covers sprite via the same per-
  // MaterialShader pipeline cache PBR / unlit use. The 4-placeholder
  // BG bindings (D-1 candidate b) still apply via the generic per-
  // submesh BG construction below; sprite's `forgeax::sprite` shader
  // module ships through the same cache key formula.
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI pipeline handle
  let lastPipelineHandle: any = null;

  for (let i = 0; i < validatedOrdered.length; i++) {
    const entry = validatedOrdered[i];
    if (entry === undefined) continue;

    // feat-20260609 M2: skip entities that don't match the pass selector.
    if (matchedIndices !== null && !matchedIndices.has(entry.renderableIndex)) continue;

    // D-2 generalised feat-20260625 M2 / w7: transparent entities are
    // dispatched in the separate sub-pass (bgra8unorm unorm view,
    // loadOp=load) so they must NOT be drawn here in the geometry pass
    // (bgra8unorm-srgb sRGB view, loadOp=clear). In the HDR path
    // (tonemapActive=true) or when there are no transparent entries,
    // splitLdrSprite=false and this guard is a no-op. Post-w13 the
    // legacy shadingModel arm is gone; transparent is the single SSOT
    // mirrored on `computeSplitLdrSprite`.
    //
    // feat-city-glb Bug 5 (per-submesh transparency): only skip the WHOLE
    // entity here when EVERY submesh is transparent (the sprite / fully-
    // transparent-mesh fast path, byte-identical to the pre-fix behavior for
    // single-material entities). A mixed mesh (opaque road submesh + BLEND
    // decal submesh) is NOT skipped at the entity level; its opaque submeshes
    // draw here and the per-submesh loop below skips the transparent ones
    // (they are drawn in the blend sub-pass instead).
    if (splitLdrSprite && isEntityFullyTransparent(entry.source)) continue;

    // tweak-20260701 M1: MaterialSnapshot.shadingModel deleted. Pipeline
    // tag is always 'unlit' -- sprite materials flow through the same
    // materialShaderId pipeline cache PBR / unlit use (plan-strategy D-7).
    const materialShaderId =
      entry.source.skin !== undefined
        ? SKIN_MATERIAL_SHADER_ID
        : entry.source.material.materialShaderId;

    const pipelineTag: 'unlit' = 'unlit';

    // w10: setStencilReference per draw when the dispatch entry carries
    // a stencil reference value (plan-strategy D-3: draw-call dynamic
    // state after setPipeline). Defaults to 0 when no reference is set
    // (WebGPU stencil reference default, semantically a no-op).
    pass.setStencilReference(entry.stencilReference ?? 0);

    if (entry.mesh.vertexBuffer !== lastVertexBuffer) {
      pass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
      lastVertexBuffer = entry.mesh.vertexBuffer;
    }
    // feat-20260604 M4 / w11: vertex-only meshes (indexed === false) carry no
    // index buffer; skip setIndexBuffer entirely and dispatch via pass.draw
    // below. Indexed meshes keep the existing setIndexBuffer path unchanged.
    if (entry.mesh.indexed && entry.mesh.indexBuffer !== lastIndexBuffer) {
      if (entry.mesh.indexBuffer !== null) {
        pass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
        lastIndexBuffer = entry.mesh.indexBuffer;
      }
    }

    // Dispatch counter bump — sprite folds into the same 2-bucket
    // surface for now (`pipelineDispatchCounts.{unlit, standard}`
    // mirror the original 2-pipeline scope; sprite-bucket counters
    // can land in a follow-up if AI users need them separately).
    // sprite entries do not bump either counter — the bench (M-4)
    // can read sprite render counts via the transparent bucket
    // length instead.
    if (pipelineTag === 'unlit') dispatchCounts.unlit += 1;

    const _instRes = resolveGeometryInstanceBuffer(c, pass, entry);
    if (_instRes.drawn) continue;
    const instanceBuffer = _instRes.instanceBuffer;
    const instanceCount = _instRes.instanceCount;

    // feat-20260531-per-frame-bind-group-cache M3 / w12: per-entity
    // instances bind group cache lookup (D-2 handle-set key).
    // Key = 'instances' + entityKey + instanceBuffer handle id.
    // The instanceBuffers cache already handles archVersion/byteLength
    // invalidation (handle changes on buffer rebuild); the BG cache
    // naturally misses when the underlying handle id differs.
    const instancesBindGroup: BindGroup = getOrCreatePerEntity(
      frameState.instancesBgPerEntity,
      entry.source.entityKey,
      [instanceBuffer],
      'instances',
      () => {
        const result = runtime.device.createBindGroup({
          label: 'pbr-instances-bg',
          layout: pipelineState.instancesBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: { buffer: instanceBuffer },
              },
            },
          ],
        });
        if (!result.ok) throw result.error;
        return result.value;
      },
      bindGroupCounts,
    );

    // feat-20260611 R2 / M8 / w28 (IS-14): skin entries need a 2-binding
    // group(2) BG matching `pbr-skin-pl` (binding 0 mesh-array UBO +
    // binding 1 palette UBO). Building this here -- not in the
    // `meshBindGroup` factory above -- because the binding-shape
    // (1-entry vs 2-entry) is per-entry, not per-frame. URP / HDRP
    // entries keep using `meshGroup2` (1-entry mesh-array or HDRP
    // unified). The skin-variant cache key includes both buffer
    // identities so a future allocator-driven palette buffer rotation
    // invalidates the BG without manual eviction.
    //
    // PSO-availability gate: only swap to the skin BG when (a) the
    // skin pipeline layout itself was built (charter P3 fail-stop on
    // BGL-build failure), AND (b) the skin PSO cache returns a non-null
    // pipeline for this entry. Without (b), the per-submesh selector
    // below falls back to URP `standardPipeline` (`pbr-pl` layout,
    // 1-entry mesh-array BGL); binding the 2-entry skin BG against
    // that pipeline reproduces the exact `pbr-mesh-array-bgl ... does
    // not match layout pbr-skin-mesh-array-bgl` device error R1
    // captured. Mirrors the uniform null skip-draw pattern (M6-T1).
    let group2BindGroup: BindGroup = meshGroup2 as BindGroup;
    // feat-20260612-skin-palette-per-frame-upload M3 / m3-2: dyn-offset
    // tuple sourced from `_computeSkinGroup2DynOffsets`.  Defaults to the
    // length-1 non-skin shape; the skin branch below re-computes with the
    // per-entity `entry.source.skin.byteOffset` cursor.
    let group2DynamicOffsets: readonly number[] = _computeSkinGroup2DynOffsets(i, undefined);
    const isSkinEntry = entry.source.skin !== undefined;
    // feat-20260612-skin-palette-per-frame-upload M1 / m1-3 + M6: the
    // record stage reads the GPU buffer reference through
    // `entry.source.skin.buffer` (per-slice carrier set at extract time
    // by allocateSlice). On the storage path every slice carries the
    // same shared buffer pointer, so the BG cache key collapses to one
    // entry per frame (miss=1 + hit=N-1). On the uniform fallback path
    // each slice carries its own per-entity 16320 B UBO, so the BG
    // cache key naturally splits per entity (one BG per buffer pointer)
    // -- there is no shared-buffer assumption to break under
    // 16 KiB UBO cap. Charter P3 explicit failure preserved: skin
    // entries skip when the pipeline layout is missing OR the slice
    // failed to allocate (no buffer field). dynOffset[1] = byteOffset
    // is 0 on the uniform path (entry already covers the full buffer)
    // and walks 0, 1536, 3072, ... on the storage path.
    const skinAllocator = pipelineState.skinPaletteAllocator;
    const skinSlice = entry.source.skin;
    const skinResources =
      isSkinEntry &&
      pipelineState.pbrSkinMeshBindGroupLayout !== null &&
      skinAllocator !== null &&
      skinSlice !== undefined
        ? {
            meshArrayBgl: pipelineState.pbrSkinMeshBindGroupLayout,
            paletteBuffer: skinSlice.buffer,
            paletteBindingWindowBytes: skinAllocator.bindingWindowBytes,
          }
        : null;
    // Probe the skin PSO cache up front so we can decide whether to swap
    // to the 2-binding skin BG. The same probe + selector is repeated in
    // the per-submesh loop below (the loop's variantSet derivation is
    // identical -- skin shader registers a single all-true variant so
    // the canonical empty-key rule applies on HDRP and the URP key is
    // the explicit expanded form, mirroring the standard PBR path).
    const skinVariantSet = frameState.isHdrpActive
      ? ''
      : 'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true';
    const skinPsoProbe =
      skinResources !== null
        ? (runtime.getMaterialShaderPipeline?.(
            SKIN_MATERIAL_SHADER_ID,
            tonemapActive,
            entry.renderState,
            entry.mesh.submeshes[0]?.topology ?? 'triangle-list',
            entry.mesh.indexFormat,
            skinVariantSet,
            undefined, // passKind — defaults to 'forward'
            undefined, // meshAttributes — skin probe uses first submesh, derive from entry
            sampleCount,
          ) ?? null)
        : null;
    if (skinResources !== null && skinPsoProbe !== null) {
      const meshBindSize = runtime.device.caps.storageBuffer
        ? MESH_SSBO_BYTES
        : MESH_UBO_FULL_ARRAY_BYTES;
      // m3-2 / D-8: skin BG cache miss / hit instrumentation. The chain
      // walk no longer exposes a string key to `.has()`, so we derive
      // hit/miss from the w7 `bindGroupCounts.createBindGroup` accounting:
      // snapshot the counter, run `getOrCreateFromChain`, and compare. A
      // delta of 1 means the factory ran (miss); 0 means a chain hit. This
      // publishes the per-frame counter the m3-1 acceptanceCheck reads
      // (miss=1 + hit=N-1 across N skin entries sharing one allocator
      // buffer + mesh SSBO). Field is optional + opt-in (read via
      // structural cast so prod paths that omit the counter pay nothing).
      const skinStats = (pipelineState as { _skinBgCacheStats?: { miss: number; hit: number } })
        ._skinBgCacheStats;
      const skinMissesBefore = bindGroupCounts.createBindGroup;
      const skinBindGroup: BindGroup = getOrCreateFromChain(
        frameState.meshBindGroupCache,
        [pipelineState.meshStorageBuffer.buffer, skinResources.paletteBuffer],
        'pbr-skin-mesh',
        () => {
          const result = runtime.device.createBindGroup({
            label: 'pbr-skin-mesh-bg',
            layout: skinResources.meshArrayBgl,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'buffer',
                  value: {
                    buffer: pipelineState.meshStorageBuffer.buffer,
                    offset: 0,
                    size: meshBindSize,
                  },
                },
              },
              {
                binding: 1,
                resource: {
                  kind: 'buffer',
                  value: {
                    buffer: skinResources.paletteBuffer,
                    offset: 0,
                    // M6 SSOT: static BG entry size (= MAX_JOINTS * 64 =
                    // 16320 B) sourced from the allocator. The per-draw
                    // window slides via `group2DynamicOffsets[1]`
                    // (= entry.source.skin.byteOffset) so this size
                    // stays at the worst case across all skin entries
                    // -- one BG covers every skinned draw in the frame
                    // (m3-1b miss=1 + hit=N-1 contract). The allocator
                    // guarantees `buffer.size >= byteOffset + this size`
                    // so dynOffset[1] passes WebGPU validation.
                    size: skinResources.paletteBindingWindowBytes,
                  },
                },
              },
            ],
          });
          if (!result.ok) throw result.error;
          return result.value;
        },
        bindGroupCounts,
      );
      if (skinStats !== undefined) {
        if (bindGroupCounts.createBindGroup > skinMissesBefore) skinStats.miss += 1;
        else skinStats.hit += 1;
      }
      group2BindGroup = skinBindGroup;
      // m3-2: dyn-offset tuple via `_computeSkinGroup2DynOffsets` with the
      // per-entity palette cursor M2 m2-6 wrote at the extract stage.
      // Replaces the prior PR #353 hard-coded `0` second slot -- every
      // skin entry now points the palette window at its own slice while
      // sharing the worst-case BG entry size above.
      group2DynamicOffsets = _computeSkinGroup2DynOffsets(i, entry.source.skin?.byteOffset);
    } else if (isSkinEntry) {
      // Skin entry but skin PSO not ready (cache miss / async build pending,
      // or skin pipeline layout failed at boot). Skip the draw rather than
      // fall back to URP `pbr-pl` against the 6-attribute skin VBO -- that
      // path produced the layer-3 / layer-4 device errors R1 captured. Once
      // the async PSO compile resolves the cache hits and the next frame
      // routes the skin BG + skin pipeline together. Mirrors the uniform
      // null skip-draw shape (M6-T1, charter P3 explicit failure).
      continue;
    }
    pass.setBindGroup(2, group2BindGroup, group2DynamicOffsets);

    // feat-20260520-2d-sprite-layer-mvp M-3 / w25 (@fallback sprite
    // bucket): sprite entries get a per-entity material BindGroup so
    // each sprite carries its own texture binding at @group(1) @binding(2).
    // Bindings 3..6 (metallicRoughness sampler/texture + normal
    // sampler/texture) bind `pipelineState.defaultSampler` +
    // `pipelineState.defaultWhiteTextureView` placeholders (D-1
    // candidate b — zero new GPU resource; the 1x1 white view was
    // already provisioned for unlit / standard fallback so the sprite
    // path adds 4 binding references, no new resource code).
    //
    // Missing-texture fallback (AC-18 path 4 + R7 isolation): when the
    // sprite texture has no GPU view, the binding uses
    // `defaultWhiteTextureView` as the fallback texture and the
    // material UBO upload above wrote debug-pink colorTint so the
    // sprite is visually distinct. The warn-once + RhiError surface
    // fires inside the upload loop. R7 isolation: this does NOT change
    // the existing unlit / standard bucket missing-texture handling —
    // those keep their silent-white fallback (a future
    // `feat-future-pbr-missing-texture-fallback-explicit` will retrofit).
    // bug-20260610 layer 7d: BG is per-submesh — each iteration of
    // the submesh draw loop below builds (or cache-hits) a BG with
    // matsForRebind[smIdx]'s 5 textureViews (baseColor / MR / normal /
    // emissive / occlusion). Cache key is 14-handle-id only (entityKey
    // dropped) so identical-material submeshes / entities dedup
    // globally. Sprite path is unchanged (single spriteBg, sprite
    // per-submesh OOS-1). The non-sprite branch leaves perSubmeshBg
    // declared but null; the submesh loop reassigns it per iteration
    // and the source-grep gate in skylight-fallback-path.test.ts /
    // systems.unit.test.ts continues to match
    // `setBindGroup\s*\(\s*1\s*,\s*perSubmeshBg\b` on the in-loop call.
    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13 (D-1
    // candidate b): the sprite-specific BG construction is gone — sprite
    // materials reuse the same per-submesh BG path PBR / unlit use. The
    // 7-entry BGL is byte-for-byte shared (binding 0 = Material UBO,
    // 1 = baseColorSampler, 2 = baseColorTexture, 3-6 = filler samplers /
    // textureViews). Sprite's "no metallic/normal/emissive/occlusion
    // texture" simply falls through to `defaultWhite` / `defaultNormal`
    // — the same placeholders the unlit path already used. The generic
    // branch below builds the per-submesh BG.
    let perSubmeshBg: BindGroup | null = null;
    pass.setBindGroup(3, instancesBindGroup);
    // feat-20260608 M4 / w16: per-submesh pipeline selection + draw loop.
    // Each submesh carries its own topology, so pipeline selection is per-submesh.
    // Vertex/index buffers and bind groups are set once (shared across all submeshes).
    // feat-20260608 M5 amend / w16-a: the material UBO bind (group=1)
    // ALSO moves into the loop -- the j-th submesh sees the j-th
    // material slot via dynamic offset (entitySlotStart + j) * 256.
    const entityMatBaseOffset = (materialSlotStart[i] ?? 0) * MATERIAL_PER_ENTITY_STRIDE;
    const matsForRebind = entry.source.materials;
    for (let smIdx = 0; smIdx < entry.mesh.submeshes.length; smIdx++) {
      const sm = entry.mesh.submeshes[smIdx];
      if (sm === undefined) continue;
      // feat-city-glb Bug 5 (per-submesh transparency): in the LDR split, a
      // transparent submesh is drawn in the blend sub-pass (non-sRGB view),
      // NOT here in the sRGB geometry pass. Skip it. Opaque submeshes of the
      // same (mixed) mesh still draw here. Single-material / fully-opaque
      // meshes are unaffected (their submesh materials are not transparent).
      if (
        splitLdrSprite &&
        matsForRebind[smIdx < matsForRebind.length ? smIdx : 0]?.transparent === true
      ) {
        continue;
      }
      {
        // bug-20260610 layer 7d: per-submesh BG construction. Texture
        // views resolve from `matsForRebind[smIdx]` so the j-th submesh
        // sees its own materials[j] textures (baseColor / MR / normal /
        // emissive / occlusion). Pick slot j when materials.length covers
        // smIdx; otherwise fall back to slot 0 (count-mismatch already
        // filtered by extract; this guard handles the materials.length=1
        // single-material path mapped over multi-submesh meshes safely).
        // This BG drops entityKey: identical-texture-set submeshes
        // (whether on the same entity or different ones) share one BG via
        // the shaderId-outer `materialBgShared` cache. The 14 handle
        // objects form the WeakMap chain and fully discriminate the
        // binding state since sampler/textureView/buffer handle identities
        // are stable across frames.
        //
        // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13:
        // sprite materials now use the same per-submesh BG construction
        // (the sprite-specific BG branch above is deleted; sprite per-
        // submesh single-slot is still enforced via materialSlotStart
        // and the sprite-shaped paramSnapshot fills the PBR-shaped BGL
        // bindings via fallback textures for the 4 unused slots).
        const matSlotIdx = smIdx < matsForRebind.length ? smIdx : 0;
        const submeshMaterial = matsForRebind[matSlotIdx] ?? entry.source.material;
        // feat-city-glb Bug 5: per-submesh material BG assembly extracted to
        // the shared `buildPerSubmeshMaterialBg` closure (also called by the
        // LDR blend sub-pass). Resolves the shader's user-region textures
        // (baseColor/MR/normal + any custom Nth texture), emissive/occlusion
        // injection, and Skylight merge; deduped cross-entity via the
        // shaderId-outer `materialBgShared` cache.
        perSubmeshBg = buildPerSubmeshMaterialBg(submeshMaterial, entry.source.entityKey);
        pass.setBindGroup(1, perSubmeshBg, [
          entityMatBaseOffset + matSlotIdx * MATERIAL_PER_ENTITY_STRIDE,
        ]);
      }
      const smTopology = sm.topology;
      let smPipelineHandle: typeof pipelineState.unlitPipeline;
      const nonDefaultTopology = smTopology !== 'triangle-list';
      if (materialShaderId === undefined || materialShaderId === 'forgeax::default-unlit') {
        const unlitRsp =
          (entry.renderState !== undefined || nonDefaultTopology) && materialShaderId !== undefined
            ? runtime.getMaterialShaderPipeline?.(
                materialShaderId,
                tonemapActive,
                entry.renderState,
                smTopology,
                entry.mesh.indexFormat,
                undefined, // variantSet — unlit path has no variant
                undefined, // passKind — defaults to 'forward'
                undefined, // meshAttributes — unlit uses 4-attribute layout
                sampleCount,
              )
            : undefined;
        smPipelineHandle =
          unlitRsp ?? selectGeometryPipeline(pipelineState, tonemapActive, msaaActive);
      } else if (materialShaderId !== undefined) {
        // feat-20260609 M4.5 / w38 (D-11): the variantSet handed to
        // getMaterialShaderPipeline MUST mirror the boot-time
        // `definesKey` rule at createRenderer.ts:2483-2485 (sortedEntries
        // .every(v=>v===true) ? '' : 'A=v+...'). manifest variant.definesKey
        // is `''` for the all-true variant, so HDRP (both axes true) must
        // pass the canonical empty key to hit that variant via
        // findVariantByKey. Passing the expanded form would produce a
        // miss and silently fall back to the registered default WGSL,
        // creating a layout/binding mismatch under HDRP.
        //
        // URP path passes the explicit expanded form because the URP
        // variant's manifest definesKey IS that exact non-empty string
        // (CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true)
        // -- the canonical-empty rule only applies to the all-true case.
        const variantSet = frameState.isHdrpActive
          ? ''
          : 'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true';
        // feat-20260629-multi-uv-set-support: a mesh carrying a real extra UV
        // set (uvSetCount > 1) has a wider interleaved stride (56 B for two
        // sets) than the default single-UV layout (48 B). Hand the material
        // PSO a vertex layout that includes the real @location(6+) attributes
        // so its stride matches the buffer; without this the PSO reads a 48 B
        // stride against the 56 B buffer and every vertex after the first
        // lands off-screen (hello-multi-uv rendered nothing). Single-UV meshes
        // pass undefined and keep the default 4-attribute layout (zero change).
        const meshUvAttributes =
          entry.mesh.uvSetCount > 1
            ? buildMeshAttributeMapForUvSets(entry.mesh.uvSetCount)
            : undefined;
        const cachedPipeline =
          runtime.getMaterialShaderPipeline?.(
            materialShaderId,
            tonemapActive,
            entry.renderState,
            smTopology,
            entry.mesh.indexFormat,
            variantSet,
            undefined, // passKind — defaults to 'forward'
            meshUvAttributes,
            sampleCount,
          ) ?? null;
        // feat-20260615-pipeline-spec-ssot M6-T1: cache miss resolves to
        // null uniformly across URP / HDRP / skin shaders. Charter P3
        // explicit failure: the pre-M6 URP-path silent fallback to the
        // boot-time `pipelineState.standardPipeline*` (M4.5-followup w43)
        // masked real PipelineSpecError build failures behind a
        // layout-compatible-but-wrong PSO. The per-submesh
        // `if (smPipelineHandle === null) continue` skip-draw (which
        // already covered HDRP-active and skin miss paths) is now the
        // single uniform recovery shape -- one frame of skip-draw on
        // first-touch, then the cached PSO flows in once the async
        // build resolves. The pre-loop skin-PSO probe still skips the
        // entire entry on first-submesh probe miss; this site only
        // fires on per-submesh topology variance miss.
        smPipelineHandle = cachedPipeline ?? null;
      } else {
        smPipelineHandle = selectGeometryPipeline(pipelineState, tonemapActive, msaaActive);
      }

      if (smPipelineHandle === null) {
        continue;
      }

      if (lastPipelineHandle !== smPipelineHandle) {
        // biome-ignore lint/suspicious/noExplicitAny: opaque RHI pipeline handle
        pass.setPipeline(smPipelineHandle as any);
        lastPipelineHandle = smPipelineHandle;
      }

      if (entry.mesh.indexed) {
        pass.drawIndexed(sm.indexCount, instanceCount, sm.indexOffset, 0, 0);
      } else {
        pass.draw(sm.vertexCount, instanceCount, 0, 0);
      }
    }
  }
}

/**
 * feat-20260704 M3/w19: resolve the per-entity @group(3) instance buffer for
 * the geometry pass, extracted verbatim from recordGeometryDraws. Returns the
 * ECS-managed instance buffer + instanceCount (identity fallback when the entity
 * has no Instances). On the WebGL2 uniform-fallback over-cap path it fires the
 * structured limit-exceeded error, binds the identity BG, issues the per-submesh
 * draw itself, and returns `{ drawn: true }` so the caller skips its own draw
 * (continue).
 *
 * @internal
 */
function resolveGeometryInstanceBuffer(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
): { drawn: true } | { drawn: false; instanceBuffer: Buffer; instanceCount: number } {
  const { runtime, pipelineState, frameState } = c;
  // Resolve the per-instance buffer: ECS-managed array<f32> snapshot
  // when `Instances` present, identity fallback otherwise (consistent-
  // abstraction single branch — both paths bind something at @group(3)).
  let instanceBuffer: Buffer = pipelineState.identityInstanceBuffer;
  let instanceCount = 1;
  const inst = entry.source.instances;
  if (inst !== undefined) {
    // feat-20260526-pbr-uniform-fallback-no-storage-buffer M3 / w13:
    // caps.storageBuffer===false -> uniform fallback with 128-instance
    // cap (128 * 64B = 8192B < WebGL2 min 16384B UBO limit).
    // caps.storageBuffer===true -> existing storage buffer path unchanged.
    const uniformFallback = runtime.device.caps.storageBuffer === false;
    let instanceBufferUsage = STORAGE_USAGE | COPY_DST_USAGE;

    if (uniformFallback) {
      if (inst.instanceCount > MAX_UNIFORM_INSTANCES) {
        runtime.errorRegistry.fire(
          new RhiError({
            code: 'limit-exceeded',
            expected: `instance count <= ${MAX_UNIFORM_INSTANCES} (uniform fallback cap)`,
            hint: `reduce instance count to ${MAX_UNIFORM_INSTANCES} or use a WebGPU-capable backend`,
            detail: {
              maxStorageBufferBindingSize: MAX_UNIFORM_INSTANCES * 64,
              requestedBytes: inst.instanceCount * 64,
            },
          }),
        );
        instanceCount = inst.instanceCount;
        instanceBuffer = pipelineState.identityInstanceBuffer;
        const setBgResult = runtime.device.createBindGroup({
          label: 'pbr-instances-bg',
          layout: pipelineState.instancesBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: { buffer: instanceBuffer },
              },
            },
          ],
          // biome-ignore lint/suspicious/noExplicitAny: dynamic buffer map key
        }) as any;
        if (!setBgResult.ok) throw setBgResult.error;
        pass.setBindGroup(3, setBgResult.value as BindGroup);
        // feat-20260608 M4 / w16: per-submesh draw loop (uniform fallback path).
        for (const sm of entry.mesh.submeshes) {
          if (entry.mesh.indexed) {
            pass.drawIndexed(sm.indexCount, instanceCount, sm.indexOffset, 0, 0);
          } else {
            pass.draw(sm.vertexCount, instanceCount, 0, 0);
          }
        }
        return { drawn: true };
      }
      instanceBufferUsage = UNIFORM_USAGE | COPY_DST_USAGE;
    }

    {
      // Cap-gate (LimitExceededDetail single emit point — feat-20260514
      // M3 / w15 anchor): `requestedBytes <= maxStorageBufferBindingSize`.
      const requestedBytes = inst.transforms.byteLength;
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
        // Look up the cached GPU buffer or create a fresh one when the
        // archetype version bumped or the byte length changed.
        const cached = frameState.instanceBuffers.get(inst.cacheKey);
        let active: InstanceBufferCacheEntry | null = null;
        if (
          cached !== undefined &&
          cached.uploadedArchVersion === inst.archVersion &&
          cached.uploadedByteLength === requestedBytes
        ) {
          active = cached;
        } else if (requestedBytes > 0) {
          const bufRes = runtime.device.createBuffer({
            size: requestedBytes,
            usage: instanceBufferUsage,
            mappedAtCreation: false,
          });
          if (!bufRes.ok) {
            runtime.errorRegistry.fire(bufRes.error);
          } else {
            // feat-20260619 M4 / F12: destroy the old cached buffer
            // before replacing it with the new one (D-6).
            if (cached !== undefined && !cached.buffer.isDestroyed) {
              const r = cached.buffer.destroy();
              if (!r.ok) runtime.errorRegistry.fire(r.error);
            }
            const newBuffer = new GpuBuffer(runtime.device, bufRes.value);
            active = {
              buffer: newBuffer,
              uploadedArchVersion: inst.archVersion,
              uploadedByteLength: requestedBytes,
            };
            frameState.instanceBuffers.set(inst.cacheKey, active);
          }
        }
        if (active !== null) {
          const writeRes = runtime.device.queue.writeBuffer(
            active.buffer.handle,
            0,
            inst.transforms,
          );
          if (!writeRes.ok) {
            runtime.errorRegistry.fire(writeRes.error);
          } else {
            instanceBuffer = active.buffer.handle;
            instanceCount = Math.max(1, inst.instanceCount);
          }
        }
      }
    }
  }
  return { drawn: false, instanceBuffer, instanceCount };
}
