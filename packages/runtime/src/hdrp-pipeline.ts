// @forgeax/engine-runtime — forgeax::hdrp built-in RenderPipeline
// feat-20260608-cluster-lighting M2 / w9 · M4 / w18
// feat-20260612-hdrp-deferred-shading-learn-render-5-8 M2 / w11.
//
// The HDRP (High Definition Render Pipeline) uses deferred opaque + forward
// transparent two-stage rendering. Geometry writes to a 3-RT g-buffer; a
// full-screen lighting pass decodes g-buffer + evaluates GGX via ClusterBinner;
// transparent (alpha-blended) geometry renders directly to hdrColor.
//
// M2 provided:
//   - HDRP_PIPELINE_ID = 'forgeax::hdrp' constant
//   - validateClusterGrid(grid) pure function
//   - hdrpPipeline shell (buildGraph=null, execute stub)
//
// M4 / w18 adds:
//   - buildGraph declares 4 persistent resources (light_data / cluster_grid /
//     light_index_list storage SSBOs + cluster_uniform UBO) on BGL slots 3..6
//     (plan D-1, physically isolated from URP slots 0..2)
//   - buildGraph declares a single 'cluster-forward' pass
//   - execute stub (M5/M6 will fill with real binner + light upload + draw)
//
// feat-20260612 M2 / w11 adds:
//   - D-2/D-6: g-buffer (3 color RT + depth) + lighting + forward passes
//   - D-5: install-time caps check (maxColorAttachments < 4 → throw)
//   - forward pass retains the existing cluster-forward + recordMainPass delegate
//
// feat-20260612 M3 / w16 adds:
//   - D-4: g-buffer pass execute filters by LightMode='Deferred' (passKind='deferred')
//   - forward pass filter by LightMode='Forward' (passKind='forward')
//   - lighting pass stays as fullscreen-quad stub (M4 fills real dispatch)
//   - opaque geometry writes depth in g-buffer; forward pass depth-test culls
//     transparent fragments behind opaque surfaces (no explicit alphaMode gate needed)
//
// Constraints from upstream:
//   D-error-1: hdrp-grid-invalid is an independent install-time error union
//     (NOT in RuntimeErrorCode)
//   D-1: BGL slot 3..6 (URP 0..2 physical isolation)
//   AC-13: 4 buffer occupy 4 binding slots
//   AC-14: cluster_uniform via uniform write; runtime grid change no PSOP rebuild
//   AC-23: charter P3 triple-set .code / .hint / .expected + .detail.{x,y,z}
//   AC-05: installPipeline(hdrpAsset) succeeds on caps-ok paths

import { mat4 } from '@forgeax/engine-math';
import { RenderGraph, type ResolveContext } from '@forgeax/engine-render-graph';
import { err, ok, type Result, RhiError, type TextureView } from '@forgeax/engine-rhi';
import { attachDebugOverlayPass } from './debug-draw-glue';
import { HdrpDeferredCapsInsufficientError } from './errors';
import { getOrCreateHdrpBuffers } from './hdrp-buffers';
import { addPointShadowPass, addSsaoPasses, addTonemapPass } from './render-graph-primitives';
import type { RenderPipeline, RenderPipelineData } from './render-pipeline';
import type {
  _InternalRenderPipelineContext,
  RenderPipelineContext,
} from './render-pipeline-context';
import { recordMainPass } from './render-system-record';

/** Reserved engine pipeline id for the HDRP (cluster-forward pipeline). */
export const HDRP_PIPELINE_ID = 'forgeax::hdrp';

// ── HdrpInstallError ───────────────────────────────────────────────────────

/**
 * Install-time grid validation error — standalone class (NOT in RuntimeErrorCode).
 *
 * Emitted synchronously by `validateClusterGrid` when grid dimensions are
 * non-integer, <= 0, or > 64. Charter P3 triple-set:
 *   - `.code = 'hdrp-grid-invalid'`
 *   - `.hint` — human-readable recovery guidance
 *   - `.expected` — "integer in [1, 64]"
 *   - `.detail = { x, y, z }` — the actual invalid grid values
 *
 * D-plan-4 (Option B): this is a standalone class, independent of any closed
 * union. The single-member union approach was rejected because `hdrp-grid-invalid`
 * is a synchronous throw at install-time, never fanned through `onError`, and a
 * 1-member union adds ceremony without exhaustive-switch benefit. The charter
 * P3 triple-set is fully satisfied by the class surface alone.
 */
export class HdrpInstallError extends Error {
  readonly code = 'hdrp-grid-invalid' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly x: number; readonly y: number; readonly z: number };

  constructor(x: number, y: number, z: number) {
    const expected = 'clusterGrid.{x,y,z} each integer in [1, 64]';
    const hint = `clusterGrid {x:${x}, y:${y}, z:${z}} is invalid; set {x,y,z} to positive integers in [1, 64]`;
    super(
      `hdrp-grid-invalid: clusterGrid {x:${x}, y:${y}, z:${z}} — each dimension must be an integer in [1, 64]`,
    );
    this.name = 'HdrpInstallError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { x, y, z };
  }
}

// ── validateClusterGrid ───────────────────────────────────────────────────

/**
 * Validates HDRP cluster grid dimensions are integers in [1, 64].
 *
 * Returns `Result.ok({x,y,z})` on valid input; `Result.err(new HdrpInstallError(...))`
 * when any dimension is <= 0, > 64, or non-integer. Each dimension carries its
 * original value in `.detail.{x,y,z}` so AI users read the offending value directly
 * (charter P3: structured errors, no string parsing).
 *
 * AC-23: 4 trigger scenarios — x=0 (<=0), x=1.5 (non-integer), y=-1 (<=0),
 * z=65 (>64) — all produce `code === 'hdrp-grid-invalid'`.
 */
export function validateClusterGrid(grid: {
  x: number;
  y: number;
  z: number;
}): Result<{ x: number; y: number; z: number }, HdrpInstallError> {
  const { x, y, z } = grid;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(z) ||
    x < 1 ||
    x > 64 ||
    y < 1 ||
    y > 64 ||
    z < 1 ||
    z > 64
  ) {
    return err(new HdrpInstallError(x, y, z));
  }
  return ok({ x, y, z });
}

// ── cluster_grid sizing constants ─────────────────────────────────────────────

/** Default cluster grid dimensions (x=16, y=9, z=24). FR-2 + idTech6 industry default. */
export const DEFAULT_CLUSTER_GRID = { x: 16, y: 9, z: 24 } as const;

/**
 * Number of u32 slots per cluster cell (offset + count = 2).
 * Consumed by the M5 binner upload path.
 */
export const CLUSTER_GRID_STRIDE_U32 = 2;

/**
 * Hard cap on light_index_list entries (FR-6).
 *
 * Originally matched Bevy GPU_CLUSTERING_INITIAL_INDEX_LIST_CAPACITY = 65536
 * (256 KiB SSBO). Bumped to 1048576 (4 MiB) after feat-20260609 hdrp-lighting
 * demo M4.5-followup measured the real index-list demand: a 256-light scene
 * with grid 16x9x24 and modest 0.8..1.5m ranges consumed ~556k entries per
 * frame. The cluster-binner's NDC AABB widens drastically when a light
 * sphere even partially crosses the near plane (clusterSpaceObjectAabb
 * line 167 clamps minViewZ to -1e-5, projecting the entire near hemisphere
 * to the full NDC [-1,1] x [-1,1] xy range), so realistic mid-density lit
 * scenes overflow 65k easily even with conservative ranges.
 *
 * 1 MiB entries = 4 MiB SSBO is well within WebGPU's
 * `maxStorageBufferBindingSize` budget (default 128 MiB). Future scenes
 * with more lights or larger grids can scale further; the cluster-binner
 * still fail-softs on overflow with a structured error reporting the
 * actual demand vs capacity.
 */
export const LIGHT_INDEX_LIST_CAPACITY = 1048576;

/** Maximum number of LightSlot entries in light_data SSBO (FR-3, MVP 256). */
export const MAX_LIGHTS = 256;

// ── hdrpPipeline ──────────────────────────────────────────────────────────────

/**
 * The built-in HDRP cluster-forward render pipeline.
 *
 * M4 (w18): `buildGraph` declares 4 persistent graph resources on BGL slots
 * 3..6 (plan D-1) and a single 'cluster-forward' pass. The execute closure is
 * a stub — M5/M6 will fill in the real binner + light upload + draw.
 *
 * Resource layout:
 *   - 'hdrpLightData'        : storage, persistent, 256 x 64B = 16 KiB
 *   - 'hdrpClusterGrid'      : storage, persistent, gridX*gridY*gridZ*2 u32
 *   - 'hdrpLightIndexList'   : storage, persistent, 65536 u32 = 256 KiB
 *   - 'hdrpClusterUniform'   : uniform, persistent, 32 B std140
 *
 * BGL slot mapping (HDRP):
 *   slot 3 = light_data     (storage) — @group(2) @binding(3)
 *   slot 4 = cluster_grid   (storage) — @group(2) @binding(4)
 *   slot 5 = light_index_list (storage) — @group(2) @binding(5)
 *   slot 6 = cluster_uniform (uniform) — @group(2) @binding(6)
 */
export const hdrpPipeline: RenderPipeline = {
  buildGraph(
    ctx: RenderPipelineContext,
    data: RenderPipelineData,
  ): RenderGraph<RenderPipelineContext> | null {
    const runtime = ctx.runtime;
    const graph = new RenderGraph<RenderPipelineContext>();

    // Round-2 fix-up [w18-fix-r2] (F-1): allocate the 4 persistent RHI buffers
    // up front. Lazy alloc happens here on first buildGraph call; subsequent
    // calls return the cached set (per-runtime WeakMap). On allocation failure
    // the registry has already received a structured RhiError; return null so
    // the renderer falls back to URP for the frame.
    //
    // Post-rebase fix: feat-20260604 render-graph M2 narrowed `RenderPipelineContext`
    // (frameState removed from the public ctx); install-time config now flows as
    // `data.config?.clusterGrid` per RenderPipelineData (D-C of feat-20260601 verify
    // round 2). buildGraph's second arg is the per-frame snapshot.
    const hdrpBuffers = getOrCreateHdrpBuffers(runtime, data.config?.clusterGrid);
    if (hdrpBuffers === null) return null;

    // D-5 install-time caps check: deferred path needs 3 g-buffer RT + depth.
    // `maxColorAttachments < 4` -> throw HdrpDeferredCapsInsufficientError
    // (not RuntimeError because this is synchronous install-time, not async
    // per-frame fire-through-onError; HDRP is hard-disabled on this device).
    const maxColorAttachments = runtime.device.caps.maxColorAttachments;
    if (maxColorAttachments < 4) {
      throw new HdrpDeferredCapsInsufficientError(maxColorAttachments);
    }

    // Declare 4 persistent buffer resources for the cluster forwarding data path.
    // All are lifetime=persistent because they are written every frame by the
    // CPU binner + upload path (the cluster-binner-upload pass below) and read
    // by the 'cluster-forward' pass. graph-level resource kind is 'buffer' for
    // non-texture data; storage-vs-uniform binding kind lives at the RHI BGL
    // layer.
    graph.addResource('hdrpLightData', { kind: 'buffer', lifetime: 'persistent' });
    graph.addResource('hdrpClusterGrid', { kind: 'buffer', lifetime: 'persistent' });
    graph.addResource('hdrpLightIndexList', { kind: 'buffer', lifetime: 'persistent' });
    graph.addResource('hdrpClusterUniform', {
      kind: 'buffer',
      lifetime: 'persistent',
      bufferRole: 'uniform',
    });

    // feat-20260609-hdrp-cluster-fragment-ggx M4 / w17: HDR colour + depth
    // targets so the cluster-forward pass can declare `writes: ['hdrColor']`
    // and recordMainPass (delegate executed by the pass) can resolve
    // `geometryColorView` against the graph's hdrColor when the active
    // camera carries `tonemap !== 'none'`. Mirrors the URP shape (see
    // `urp-pipeline.ts` -- same format / size / usage) so a future M-N
    // tonemap pass for HDRP can drop into the same target without renaming.
    // When tonemap is inactive, recordMainPass falls back to the swap-chain
    // view (the existing `geometryColorView ?? view` selector in recordFrame
    // line ~1672) and the graph's hdrColor stays a no-op resource -- the
    // pass topology is still well-formed.
    graph.addColorTarget('hdrColor', {
      format: 'rgba16float',
      size: 'swapchain',
      sample: 1,
      usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
    });
    graph.addColorTarget('hdrDepth', {
      format: 'depth24plus-stencil8',
      size: 'swapchain',
      sample: 1,
      // RENDER_ATTACHMENT | TEXTURE_BINDING — SSAO calc + blur passes
      // sample hdr_depth via the dedicated SSAO BGL @binding(5); a
      // depth-only view is constructed in render-graph-primitives.ts
      // (resolveHdrDepthDepthOnlyView) and bound at draw time.
      usage: 0x10 | 0x04,
    });
    // feat-20260609-hdrp-cluster-fragment-ggx [scope-amend graph-depth-target]:
    // `recordFrame` (render-system-record.ts:1539) hard-requires a graph color
    // target named 'depth' to resolve `geometryDepthView`; missing it triggers
    // a silent early-return and **zero** RenderPasses are begun (swap-chain
    // stays at its createTexture-time RGBA(0,0,0,0) state, every frame).
    // URP's graph already declares 'depth' (urp-pipeline.ts:69); HDRP's parallel
    // target is the semantically-richer 'hdrDepth'. Alias the contract name onto
    // the existing physical depth texture so HDRP satisfies the record contract
    // without owning two depth textures. See memory
    // `graph-silent-early-return-on-missing-depth-target` for full diagnosis.
    graph.addColorTargetAlias('depth', 'hdrDepth');

    // D-2 g-buffer = 3 color RT + hardware depth (straightforward layout).
    // RT0 = normal.rgb + roughness.a → rgba16f
    // RT1 = albedo.rgb + metallic.a → rgba8unorm
    // RT2 = emissive.rgb + ao.a → rgba16f
    // All sample=1 (no MSAA — OOS-1).
    graph.addColorTarget('gbuf0', {
      format: 'rgba16float',
      size: 'swapchain',
      sample: 1,
      usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
    });
    graph.addColorTarget('gbuf1', {
      format: 'rgba8unorm',
      size: 'swapchain',
      sample: 1,
      usage: 0x10 | 0x04,
    });
    graph.addColorTarget('gbuf2', {
      format: 'rgba16float',
      size: 'swapchain',
      sample: 1,
      usage: 0x10 | 0x04,
    });

    // feat-20260612-hdrp-ssao M4 / w19: SSAO half-resolution transient targets
    // (plan-strategy D-2: half-swapchain r8unorm). Declared unconditionally
    // so the graph topology is fixed; the ssao-calc/ssao-blur pass nodes are
    // conditionally wired only when config.ssao?.enabled === true.
    graph.addColorTarget('ssaoRaw', {
      format: 'r8unorm',
      size: 'half-swapchain',
      sample: 1,
      usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
    });
    graph.addColorTarget('ssaoBlurred', {
      format: 'r8unorm',
      size: 'half-swapchain',
      sample: 1,
      usage: 0x10 | 0x04,
    });

    // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-1 (plan-strategy §D-1
    // + AC-04 + AC-05): 6 x N point-light shadow caster passes (one per (cube
    // layer, face)) into the runtime-owned cube_array atlas. HDRP shares the
    // SAME `recordPointShadowPass` that URP M3 wired (via `addPointShadowPass`),
    // so the atlas + per-light face iteration topology is reused verbatim.
    // Pass node is declared unconditionally; the execute closure
    // (`recordPointShadowPass` in render-system-record.ts) early-returns when
    // `frameState.pointShadowSnapshots.length === 0` so zero-shadow scenes pay
    // nothing at frame time (AC-09 zero-pass + zero-allocation; AC-05 HDRP
    // no-shadow no-regression). The point-shadow pass writes the runtime-owned
    // cube_array atlas (NOT a graph-declared color target) — the dependency
    // edge into the cluster-forward pass is enforced by the manual
    // command-encoder boundary inside `recordPointShadowPass` (RD-4 manual
    // barrier; same as URP).
    addPointShadowPass(graph, 'point-shadow');

    // Round-2 fix-up [w18-fix-r2] (F-1): producer pass for the 4 HDRP buffers.
    // The actual binner + writeBuffer happens earlier in recordFrame
    // (render-system-record.ts HDRP block; Round-2 fix-up [w21-fix-r2]) so the
    // host has access to camera + extract pipeline. This pass exists for graph
    // bookkeeping -- declares writes so the cluster-forward pass below has a
    // valid producer for its reads (no more dangling-read fail-fast every
    // frame). execute is a no-op; barriers and topology are correct.
    graph.addPass('cluster-binner-upload', {
      reads: [],
      writes: ['hdrpLightData', 'hdrpClusterGrid', 'hdrpLightIndexList', 'hdrpClusterUniform'],
      // No execute closure: the upload happens out-of-graph in recordFrame's
      // HDRP block (see render-system-record.ts [w21-fix-r2]). The pass exists
      // so that 'cluster-forward.reads' has a valid writer, satisfying
      // render-graph dangling-read validation.
    });

    // D-2 / D-6 / D-4 g-buffer pass: render opaque geometry via passKind='deferred'.
    // Filters dispatch entries by tags={LightMode:'Deferred'} so only entities
    // with a MaterialPassDescriptor carrying passKind='deferred' are drawn.
    // recordMainPass delegates the per-entity draw loop (bind mesh SSBO, set
    // PSO with fs_gbuffer fragment entry, draw indexed). Depth writes are enabled
    // (opaque geometry), so the subsequent forward pass culls behind opaque surfaces.
    graph.addPass('g-buffer', {
      reads: [],
      writes: ['gbuf0', 'gbuf1', 'gbuf2', 'hdrDepth'],
      execute: (ctx: RenderPipelineContext) => {
        recordMainPass(ctx as _InternalRenderPipelineContext, { LightMode: ['Deferred'] });
      },
    });

    // feat-20260612-hdrp-ssao M4 / w19: SSAO calc + blur chain.
    // plan-strategy D-4: only wire when config.ssao?.enabled === true AND
    // g-buffer declared (which HDRP always declares — safe to wire here).
    // URP ignores config.ssao at runtime (same shared-config pattern as clusterGrid).
    if (data.config?.ssao?.enabled) {
      addSsaoPasses(graph, {
        gbuf0: 'gbuf0',
        hdrDepth: 'hdrDepth',
        ssaoRaw: 'ssaoRaw',
        ssaoBlurred: 'ssaoBlurred',
        params: {
          radius: data.config.ssao.radius,
          bias: data.config.ssao.bias,
          intensity: data.config.ssao.intensity,
        },
        ctx,
      });
    }

    // D-2 / D-6 lighting pass: full-screen quad that samples g-buffer (3 RT +
    // depth) + cluster buffers, evaluates GGX BRDF per pixel, writes hdrColor.
    // Execute stub — the real full-screen quad dispatch (bind g-buffer
    // textures as sampled read-only + cluster buffers, draw full-screen
    // triangle with fs_lighting entry) is filled by M4 w16 execute integration.
    //
    // feat-20260612-hdrp-ssao M4 / w19: conditionally add ssaoBlurred to reads
    // when SSAO is enabled. The lighting shader (default-standard-pbr.wgsl) has
    // the ssaoFactor identity-fallback for when the texture is not bound.
    const lightingReads: string[] = [
      'gbuf0',
      'gbuf1',
      'gbuf2',
      'hdrDepth',
      'hdrpLightData',
      'hdrpClusterGrid',
      'hdrpLightIndexList',
      'hdrpClusterUniform',
    ];
    if (data.config?.ssao?.enabled) {
      lightingReads.push('ssaoBlurred');
    }
    graph.addPass('lighting', {
      reads: lightingReads,
      writes: ['hdrColor'],
    });

    // D-6 / D-4 forward transparent pass: renders alpha-blended geometry via
    // passKind='forward'. Filters dispatch entries by tags={LightMode:'Forward'}
    // so only entities with a MaterialPassDescriptor carrying passKind='forward'
    // are drawn. Depth test reads the g-buffer's hdrDepth (written by g-buffer
    // pass) so transparent fragments behind opaque surfaces are naturally culled.
    // Opaque geometry was already rendered in g-buffer; this pass handles
    // alpha-blended materials via cluster-forward (existing code path, same
    // recordMainPass delegate as the old 'cluster-forward' pass).
    // feat-20260612-hdrp-ssao wiring fix: the cluster-forward shader (fs_main)
    // is what actually shades opaque HDRP geometry and samples the SSAO factor
    // at @group(2) @binding(7). The `ssaoBlurred` texture is a graph-transient
    // resolved only inside an execute closure (resolveCtx), so the group(2)
    // bind group built ahead of graph.execute (render-system-record.ts) cannot
    // carry it. Here we rebuild the unified group(2) bind group with the real
    // ssaoBlurred view and hand it to recordMainPass via ctx.hdrpSsaoBindGroup.
    // When SSAO is off, ssaoForwardReads stays empty and recordMainPass uses the
    // existing white-fallback bind group (identity AO).
    const ssaoForwardReads: string[] = data.config?.ssao?.enabled ? ['ssaoBlurred'] : [];
    graph.addPass('forward', {
      reads: [
        'hdrDepth',
        'hdrpLightData',
        'hdrpClusterGrid',
        'hdrpLightIndexList',
        'hdrpClusterUniform',
        ...ssaoForwardReads,
      ],
      writes: ['hdrColor'],
      execute: (ctx: RenderPipelineContext, resolveCtx?: ResolveContext) => {
        const internal = ctx as _InternalRenderPipelineContext;
        if (data.config?.ssao?.enabled && resolveCtx !== undefined) {
          internal.hdrpSsaoBlurredView = resolveCtx.resolve('ssaoBlurred') as TextureView;
        }
        recordMainPass(internal, { LightMode: ['Forward'] });
      },
    });

    // Tonemap: HDR rgba16float -> LDR swap-chain. Mirrors URP's pass at
    // urp-pipeline.ts:196. With 256 punctual lights the HDR target trivially
    // exceeds [0,1]; without this pass the swap-chain sRGB clamp burns out
    // every lit pixel to pure white. The pass is a no-op when
    // camera.tonemap === 'none' (recordTonemapPass at render-system-record.ts
    // line ~4326).
    // No bloom path under HDRP yet, so the tonemap pass reads hdrColor
    // directly (URP routes through the separate hdrComposited target written by
    // bloom-composite; HDRP has no such producer). With hdrColorWhenBloomOff
    // defaulting to hdrComposited, both keys are hdrColor here -> single read,
    // always resolves hdrColor.
    addTonemapPass(graph, 'tonemap', { hdrComposited: 'hdrColor' });

    // 11. DebugOverlay: immediate-mode debug overlay on top of everything
    //     (AFTER tonemap, verifying AC-07 R>=0.85 red-channel gate — the
    //     overlay writes to the swap-chain that the tonemap just populated,
    //     so overlay pixels sit on top of the tonemapped LDR result).
    //     When no DebugDraw is registered, the pass is a silent no-op.
    attachDebugOverlayPass(graph, (ctx: RenderPipelineContext) => {
      const proj = mat4.create();
      if (ctx.camera.projection === 'orthographic') {
        mat4.orthographic(
          proj,
          ctx.camera.orthoLeft,
          ctx.camera.orthoRight,
          ctx.camera.orthoBottom,
          ctx.camera.orthoTop,
          ctx.camera.near,
          ctx.camera.far,
        );
      } else {
        mat4.perspective(proj, ctx.camera.fov, ctx.camera.aspect, ctx.camera.near, ctx.camera.far);
      }
      const view = mat4.invert(mat4.create(), ctx.camera.world);
      return mat4.multiply(mat4.create(), proj, view);
    });

    // Pass `device` so allocateColorTargets actually creates GPU textures (and
    // resolves aliases — without device the alias lookup `result.get('hdrDepth')`
    // hits an empty map and `'depth'` stays unresolved, dropping recordFrame to
    // the silent early-return path. URP precedent: urp-pipeline.ts:210.
    const compileResult = graph.compile({
      backendKind: runtime.device.caps.backendKind,
      caps: runtime.device.caps,
      device: runtime.device,
    });
    if (!compileResult.ok) {
      runtime.errorRegistry.fire(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'HDRP render-graph compile succeeds for the deferred pass set',
          hint: 'inspect detail.error for the render-graph compile failure code',
          detail: {
            error: {
              code: 'unknown',
              message: `${compileResult.error.code}: ${compileResult.error.expected}`,
            },
          },
        }),
      );
      return null;
    }
    return graph;
  },

  execute(ctx: RenderPipelineContext): void {
    // The RenderSystem memoizes the graph on frameState.perFrameGraph and calls
    // graph.execute(ctx) directly in recordFrame; this method is the
    // RenderPipeline contract surface for direct-driven callers.
    ctx.frameState.perFrameGraph?.execute(ctx);
  },
};
