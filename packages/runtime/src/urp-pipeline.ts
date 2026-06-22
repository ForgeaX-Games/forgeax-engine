// @forgeax/engine-runtime - forgeax::urp built-in RenderPipeline.
//
// feat-20260604-resource-owning-render-graph-and-fullscreen-postpr M3 / w21
// (D-5 / D-6 / AC-12 / AC-18): the engine's default forward pipeline is now
// a transparent dogfood of the SAME public render-graph vocabulary an
// AI-user-defined custom pipeline uses. The 9 pass declarations below read
// (top to bottom) as a one-page activity diagram an AI user can study and
// then write their own pipeline against — no private record*Pass imports,
// no kitchen-sink ctx, no escape-hatch detours.
//
// PUBLIC VOCABULARY (the only nouns/verbs touched):
//   - graph.addColorTarget(name, desc)        — allocate a graph-owned RT (M1)
//   - graph.addColorTargetAlias(name, src)    — fold a logical key onto a target
//   - addShadowPass(graph, name, opts)        — render shadow casters (depth-only)
//   - addSkyboxPass(graph, name, opts)        — render skybox cube
//   - addScenePass(graph, name, opts)         — render the ECS scene (4-BGL chain)
//   - addBloomPasses(graph, opts)             — bloom bright + 2 blur + composite
//   - addTonemapPass(graph, name, opts)       — HDR -> LDR
//   - addFullscreenPass(graph, name, opts)    — generic fullscreen post-process
//
// PIPELINE_ID: the reserved engine prefix id (requirements naming convention:
// builtins use `forgeax::`, user pipelines use `<package>::<id>`).
//
// 9 PASS NAMES PRESERVED (R-PERFPASS): shadow / skybox / main /
// bloom-bright / bloom-blur-h / bloom-blur-v / bloom-composite / tonemap /
// fxaa. perFramePassNames must equal that list element-for-element after the
// rewrite — hello-bloom smoke `includes(['bloom-*'])` and AC-15
// `perFramePassNames` regression depend on it.

/**
 * ## Pipeline convention: PassSelector tags
 *
 * URP uses **LightMode** as the tag key and **Forward** / **ShadowCaster**
 * as its two values.  The shadow pass dispatches with
 * `{ LightMode: ['ShadowCaster'] }`, the scene pass with
 * `{ LightMode: ['Forward'] }`.  The `Materials.*` factories emit these
 * exact tags so assets "just work" in the built-in pipeline.
 *
 * A different pipeline flavour (HDRP, custom deferred, etc.) is free to
 * choose its own tag vocabulary — e.g. `{ RenderType: ['Opaque', 'Cutout'] }`.
 * Custom pipelines that ship their own material factory **must** emit
 * pass entries whose tags match whatever the pipeline's selectors expect;
 * otherwise the pass is silently skipped.
 */

import { mat4 } from '@forgeax/engine-math';
import { RenderGraph } from '@forgeax/engine-render-graph';
import { RhiError } from '@forgeax/engine-rhi';
import { attachDebugOverlayPass } from './debug-draw-glue';
import {
  addBloomPasses,
  addFullscreenPass,
  addPointShadowPass,
  addScenePass,
  addShadowPass,
  addSkyboxPass,
  addTonemapPass,
} from './render-graph-primitives';
import type { RenderPipeline } from './render-pipeline';
import type { RenderPipelineContext, RenderPipelineData } from './render-pipeline-context';

/** Reserved engine pipeline id for the default forward pipeline. */
export const URP_PIPELINE_ID = 'forgeax::urp';

// feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-8 (plan-strategy §D-1 + §D-8):
// URP will ship @group(0) @binding(5) cube_array shadow atlas + @binding(6)
// per-light shadow params (proj constants for cube depth-ref reconstruction).
// Slot reservations + naming are in common.wgsl (M1); the WGSL declarations
// + URP unified BGL extension land in M3 (T-M3-7) gated by a
// `POINT_SHADOW_AVAILABLE` naga_oil define so existing BGLs without the
// extra slots keep validating. M1 only reserves the slot numbers and renames
// the prior `pointPadW` host packer lane to `shadowAtlasLayer: i32`.

/**
 * The built-in forward render pipeline. `buildGraph` declares the 9-pass chain
 * using the public render-graph vocabulary; `execute` runs the memoized graph.
 *
 * The 9-pass topology is data-flow driven: shadow writes shadowDepth, skybox
 * writes hdrColor, main reads both + writes hdrColor + depth, the 4 bloom
 * passes form a half-res blur chain composing back into hdrComposited (alias
 * of hdrColor), tonemap reads the alias + writes the swap-chain, and fxaa
 * does a final pass over the swap-chain. See the AGENTS.md "RenderPipeline"
 * section for a guided walk-through.
 */
export const urpPipeline: RenderPipeline = {
  buildGraph(
    ctx: RenderPipelineContext,
    data: RenderPipelineData,
  ): RenderGraph<RenderPipelineContext> | null {
    const runtime = ctx.runtime;
    const graph = new RenderGraph<RenderPipelineContext>();

    // Swap-chain format SSOT (PipelineState, derived from selectSwapChainFormat
    // in createRenderer — backend-aware: Channel 2 native WebGPU follows
    // getPreferredCanvasFormat → bgra8unorm on Metal/D3D/Vulkan, Channel 3 GLES
    // stays rgba8unorm). Graph targets that copy/resolve against the swap-chain
    // texture (fxaaIntermediate, msaaColor) MUST match it. ctx.pipelineState is
    // the non-nullable layer-3 resource carrier (render-pipeline-context.ts):
    // buildGraph runs after record's getPipelineState() null-check so the state
    // is always resident here.
    const swapChainStorageFormat = ctx.pipelineState.format;
    const swapChainViewFormat = ctx.pipelineState.colorAttachmentFormat;

    // ── COLOUR / DEPTH TARGETS (graph-owned, allocated by compile) ──────────

    // Per-pass single-sample depth target (used when MSAA is OFF and the
    // tonemap path is the geometry depth).
    graph.addColorTarget('depth', {
      format: 'depth24plus-stencil8',
      size: 'swapchain',
      sample: 1,
      usage: 0x10, // RENDER_ATTACHMENT
    });

    // Shadow depth atlas target. ECS-driven size (DirectionalLightShadow.mapSize
    // per-cascade) x tilesPerSide. cascadeCount (1..4) drives the atlas tile
    // grid: tilesPerSide = ceil(sqrt(cascadeCount)), atlasSize = tilesPerSide *
    // mapSize. N=4 => 2x2 tiles => atlasSize = 2 * mapSize (e.g. 4096x4096 for
    // mapSize=2048). cascadeCount < 4: unused tiles (right/bottom) are never
    // written or read (D-5).
    //
    // recordFrame projects both fields onto data; we read them here to size
    // the atlas. Falls back to 1024 x 1 cascade when no DirectionalLightShadow
    // is wired (the shadow pass is gated downstream on shadowMapSize > 0 so a
    // fallback texture is harmless).
    const shadowMapSize =
      data.shadowMapSize !== undefined && data.shadowMapSize > 0 ? data.shadowMapSize : 1024;
    const cascadeCount =
      data.cascadeCount !== undefined && data.cascadeCount >= 1 && data.cascadeCount <= 4
        ? data.cascadeCount
        : 1;
    const tilesPerSide = Math.ceil(Math.sqrt(cascadeCount));
    const atlasSize = tilesPerSide * shadowMapSize;
    graph.addColorTarget('shadowDepth', {
      format: 'depth32float',
      size: { w: atlasSize, h: atlasSize },
      sample: 1,
      usage: 0x10 | 0x04 | 0x01, // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC
    });

    // FXAA scratch RT (pass writes intermediate copy of swap-chain; final
    // fragment pass samples it back into swap-chain via non-srgb storage view).
    // bug-20260610: aligned with v18 swap-chain RGBA unification — must match
    // the swap-chain storage format so copyTextureToTexture stays zero-conversion.
    // bug-20260612 made the swap-chain storage format backend-aware
    // (Channel 2 native WebGPU follows getPreferredCanvasFormat → bgra8unorm
    // on Metal/D3D/Vulkan; Channel 3 GLES stays rgba8unorm) but left this
    // target hard-coded rgba8unorm, so copyTextureToTexture(swap-chain →
    // fxaaIntermediate) failed "not copy compatible" on bgra8unorm backends.
    // Derive the format from the swap-chain storage SSOT instead.
    graph.addColorTarget('fxaaIntermediate', {
      format: swapChainStorageFormat,
      size: 'swapchain',
      sample: 1,
      usage: 0x04 | 0x02, // TEXTURE_BINDING | COPY_DST
    });

    // HDR colour target. Bloom + tonemap consumers sample this. When MSAA is
    // active the geometry pass writes hdrColorMsaa (count=4) and resolves to
    // hdrColor (count=1).
    graph.addColorTarget('hdrColor', {
      format: 'rgba16float',
      size: 'swapchain',
      sample: 1,
      usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
    });
    // hdrComposited is a logical ordering resource (bloom-composite writes it,
    // tonemap reads it) — the actual GPU texture is hdrColor. Fold via alias
    // (KB-1 / D-2).
    graph.addColorTargetAlias('hdrComposited', 'hdrColor');

    // Half-res bloom chain.
    graph.addColorTarget('bloomBright', {
      format: 'rgba16float',
      size: 'half-swapchain',
      sample: 1,
      usage: 0x10 | 0x04,
    });
    graph.addColorTarget('bloomBlurH', {
      format: 'rgba16float',
      size: 'half-swapchain',
      sample: 1,
      usage: 0x10 | 0x04,
    });
    graph.addColorTarget('bloomBlurV', {
      format: 'rgba16float',
      size: 'half-swapchain',
      sample: 1,
      usage: 0x10 | 0x04,
    });

    // MSAA targets (count=4). The geometry pass writes hdrColorMsaa /
    // hdrDepthMsaa when antialias === 'msaa'; the LDR MSAA path uses
    // msaaColor / msaaDepth with rgba8unorm storage + rgba8unorm-srgb view
    // (post-v18 swap-chain unification).
    graph.addColorTarget('hdrColorMsaa', {
      format: 'rgba16float',
      size: 'swapchain',
      sample: 4,
      usage: 0x10,
    });
    graph.addColorTarget('hdrDepth', {
      format: 'depth24plus-stencil8',
      size: 'swapchain',
      sample: 1,
      usage: 0x10,
    });
    graph.addColorTarget('hdrDepthMsaa', {
      format: 'depth24plus-stencil8',
      size: 'swapchain',
      sample: 4,
      usage: 0x10,
    });
    // bug-20260610: aligned with createRenderer's RGBA swap-chain switch
    // (BGRA isn't supported on wgpu's GLES backend). Match the swap-chain
    // storage/view layout so the MSAA resolve target (=swap-chain texture,
    // format=rgba8unorm) and the color attachment (msaaColor, format=
    // rgba8unorm) stay format-compatible while the renderer-attached view
    // (rgba8unorm-srgb) handles the linear→sRGB encode on store.
    // bug-20260612: WebGL2 fallback path lacks the VIEW_FORMATS downlevel
    // flag — passing viewFormats[] to createTexture panics under wgpu-wasm.
    // Gate on caps.storageBuffer (the WebGL2 proxy: GLES backend has no
    // storage buffers and no view-format reinterpretation). When the cap is
    // off the surface is configured as rgba8unorm-srgb directly, so the MSAA
    // resolve does the linear->sRGB encode without a separate view.
    // bug-20260612 follow-up: the MSAA resolve target is the swap-chain
    // texture, so msaaColor's format must equal the swap-chain storage format
    // (resolve requires identical formats). Hard-coded rgba8unorm broke the
    // resolve on bgra8unorm backends (Metal/D3D/Vulkan via Channel 2). Derive
    // both the storage format and the srgb view format from the swap-chain SSOT.
    const supportsViewFormats = runtime.device.caps.storageBuffer;
    graph.addColorTarget('msaaColor', {
      format: swapChainStorageFormat,
      size: 'swapchain',
      sample: 4,
      usage: 0x10,
      ...(supportsViewFormats ? { viewFormats: [swapChainViewFormat] } : {}),
    });
    graph.addColorTarget('msaaDepth', {
      format: 'depth24plus-stencil8',
      size: 'swapchain',
      sample: 4,
      usage: 0x10,
    });

    // ── PASS CHAIN (9 passes in canonical order, R-PERFPASS) ────────────────

    // 1. Shadow cascades: N independent addShadowPass calls, each writing to
    // one tile of the shadow atlas via per-cascade viewport (D-4, D-5, D-6).
    // cascadeCount < 4: only the valid cascades are iterated; unused tiles
    // (right / bottom of the atlas) are never drawn or read. Pass names
    // follow 'shadowCascade<i>' for per-cascade traceability in
    // perFramePassNames.
    const shadowSelector = { LightMode: ['ShadowCaster'] };
    for (let i = 0; i < cascadeCount; i++) {
      const col = i % tilesPerSide;
      const row = Math.floor(i / tilesPerSide);
      addShadowPass(graph, `shadowCascade${i}`, {
        depth: 'shadowDepth',
        selector: shadowSelector,
        viewport: {
          x: col * shadowMapSize,
          y: row * shadowMapSize,
          w: shadowMapSize,
          h: shadowMapSize,
        },
        // feat-20260613-csm-cascaded-shadow-maps M5 / w28: cascade index
        // selects view.lightViewProj_X inside shadow_caster.wgsl.
        cascadeIndex: i,
      });
    }

    // 1.b feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-4 (AC-04 + AC-09):
    // 6 x N point-light shadow caster passes (one per (cube layer, face)) into
    // the runtime-owned cube_array atlas. The pass node is declared
    // unconditionally so `buildGraph` stays a pure topology declaration (no
    // dependency on per-frame `frameState.pointShadowSnapshots` content; the
    // memoized graph never rebuilds on snapshot count drift). The execute
    // closure (`recordPointShadowPass` in render-system-record.ts) early-
    // returns when `frameState.pointShadowSnapshots.length === 0` so
    // zero-shadow scenes pay nothing at frame time (AC-09 zero-pass + zero-
    // allocation guarantee — see also `frameState.pointShadowAtlas` lazy-
    // ensure path in recordFrame).
    addPointShadowPass(graph, 'point-shadow');

    // 2. Skybox: writes hdrColor as far-plane background. Declaring writes:
    //    [hdrColor] forces skybox -> main topological order via the data
    //    dependency (main reads hdrColor).
    addSkyboxPass(graph, 'skybox', { color: 'hdrColor' });

    // 3. Main: scene draw list into the colour + depth target. Reads
    //    shadowDepth (sampled by lighting) and hdrColor (forces skybox order).
    addScenePass(graph, 'main', {
      color: 'hdrColor',
      depth: 'depth',
      reads: ['shadowDepth', 'hdrColor'],
      selector: { LightMode: ['Forward'] },
    });

    // 4-7. Bloom chain: bright -> blur-h -> blur-v -> composite.
    addBloomPasses(graph, {
      hdrColor: 'hdrColor',
      hdrComposited: 'hdrComposited',
      bright: 'bloomBright',
      blurH: 'bloomBlurH',
      blurV: 'bloomBlurV',
    });

    // 8. Tonemap: HDR -> LDR. Reads the bloom composite alias.
    addTonemapPass(graph, 'tonemap', { hdrComposited: 'hdrComposited' });

    // 9. FXAA: fullscreen post-process over the swap-chain. Writes
    //    fxaaIntermediate (the RT used to copy swap-chain -> sample -> write).
    //    Empty reads — FXAA samples the swap-chain directly via
    //    copyTextureToTexture (R-COLORSPACE: write through the swap-chain's
    //    non-srgb storage view to avoid double sRGB encoding).
    addFullscreenPass(graph, 'fxaa', { shader: 'fxaa', color: 'fxaaIntermediate' });

    // 9.b feat-20260621 M4' post-URP post-process effects: ordered registered
    // effect ids the install-time config requests, composited over the FINAL
    // swap-chain image (after fxaa, before the debug overlay). Each effect
    // copies the swap-chain into a shared scratch target, samples it, and writes
    // back through the swap-chain non-srgb storage view (copyFromSwapchain) — so
    // the built-in 9-pass chain (shadow cascades + tonemap + bloom + fxaa) runs
    // unchanged and the effects layer on top. AUGMENT, not REPLACE: a shadow
    // demo keeps its shadows while adding a debug overlay. `undefined`/`[]` adds
    // zero passes (default frame byte-identical, no scratch target declared).
    const postEffects = data.config?.postEffects ?? [];
    for (let i = 0; i < postEffects.length; i++) {
      const effectId = postEffects[i] as string;
      // One scratch target per effect (mirrors fxaaIntermediate). It is the
      // pass `color` (graph writer -> no dangling-read) AND the copy-dst +
      // sampled input; the effect reads the prior swap-chain state, so chaining
      // N effects composes left-to-right (effect i sees effect i-1's output).
      const scratchKey = `postEffectScratch${i}`;
      graph.addColorTarget(scratchKey, {
        format: swapChainStorageFormat,
        size: 'swapchain',
        sample: 1,
        usage: 0x04 | 0x02, // TEXTURE_BINDING | COPY_DST
      });
      addFullscreenPass(graph, `post-effect-${i}`, {
        shader: effectId,
        color: scratchKey,
        compositeOverSwapchain: true,
      });
    }

    // 10. DebugOverlay: immediate-mode debug line/sphere/aabb/frustum overlay.
    //    Reads the swap-chain via ctx.view (not a graph resource), writes
    //    directly to the swap-chain with loadOp='load'. When no DebugDraw is
    //    registered (createDebugDrawOnReady not called), the pass is a no-op.
    //    Must be the last pass so the overlay draws on top of everything
    //    including FXAA (plan-strategy D-5 / D-8 tonemap-suffix).
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

    // ── COMPILE ─────────────────────────────────────────────────────────────

    const compileResult = graph.compile({
      backendKind: runtime.device.caps.backendKind,
      caps: runtime.device.caps,
      device: runtime.device,
    });
    if (!compileResult.ok) {
      runtime.errorRegistry.fire(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'render-graph compile succeeds for the per-frame pass set',
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
    // The RenderSystem memoizes the graph on frameState.perFrameGraph and
    // calls graph.execute(ctx) directly in recordFrame; this method is the
    // RenderPipeline contract surface for callers driving the pipeline
    // through the interface.
    ctx.frameState.perFrameGraph?.execute(ctx);
  },
};
