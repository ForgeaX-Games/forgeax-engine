// apps/learn-render/5.advanced-lighting/2.gamma-correction/src/gamma-pipeline.ts
// LearnOpenGL section 5.2 - Gamma Correction.
//
// Custom RenderPipeline factory demonstrating the AI-user surface for
// gamma-correct vs no-gamma rendering paths. Each call to makeGammaPipeline
// returns a RenderPipeline (buildGraph + execute) that an AI user installs
// via `renderer.installPipeline(handle)`; flipping between the two installed
// pipelines toggles between the gamma-correct view and the no-gamma view of
// the same scene.
//
// Path comparison (research F-4 / plan-strategy D-1):
//
//   correct mode:
//     scene render -> 'offscreenSrgb' (rgba8unorm-srgb)
//                       (HW encodes linear -> sRGB on store)
//     fullscreen passthrough -> swap-chain (rgba8unorm-srgb)
//                       (HW decodes sRGB -> linear on sample, encodes back
//                        on store; net identity -> correct image)
//
//   wrong mode (no-gamma):
//     scene render -> 'offscreenSrgb' (rgba8unorm-srgb)
//     fullscreen wrong-gamma effect -> swap-chain (rgba8unorm-srgb)
//                       (samples linear, applies pow(col, 2.2) which UNDOES
//                        the sRGB encoding the swap-chain will apply on
//                        store; net effect: raw linear values reach the
//                        display -> too dark; the canonical LearnOpenGL 5.2
//                        "no gamma" image)
//
// Non-sRGB color target ('intermediateLinear', format: 'bgra8unorm') is
// declared by the wrong pipeline as a graph-resource demonstration of the
// AI-user surface for non-sRGB render targets (plan AC-12 grep gate). The
// fullscreen-post-process dispatcher hardcodes its writeView format to
// 'rgba8unorm-srgb' (see render-graph-primitives.ts dispatchFullscreenPass),
// so the fullscreen blit must still target the swap-chain; the declared
// non-sRGB target stays unused by passes but exercises the addColorTarget
// API surface for non-sRGB formats. A future feat that lifts the fullscreen
// dispatcher's hardcoded format will switch this declaration into an active
// blit chain (offscreenSrgb -> intermediateLinear bgra8unorm -> swap-chain),
// at which point the visual difference between modes becomes purely RT-
// format driven instead of shader-driven.
//
// GREP anchors for AI users:
//   - "addColorTarget"          declared color targets (incl. bgra8unorm)
//   - "addScenePass"            geometry pass into offscreen sRGB target
//   - "addFullscreenPass"       per-mode fullscreen blit to swap-chain
//   - "bgra8unorm"              non-sRGB target literal (AC-12)

import { RenderGraph } from '@forgeax/engine-render-graph';
import {
  addFullscreenPass,
  addScenePass,
  type RenderPipeline,
  type RenderPipelineContext,
  type RenderPipelineData,
} from '@forgeax/engine-runtime';

/**
 * Closed roster of gamma demo modes. The two values map 1:1 to the two
 * RenderPipelineAsset handles src/index.ts registers; pressing keys 1/2
 * hot-swaps `installPipeline` between them.
 */
export type GammaMode = 'correct' | 'wrong';

/**
 * Post-process shader id for the gamma-correct passthrough effect. Registered
 * via `renderer.postProcess.register(...)` in src/index.ts with an inline
 * WGSL passthrough fragment (samples the offscreen sRGB target, returns as-
 * is; the swap-chain sRGB view re-encodes on store).
 */
export const GAMMA_CORRECT_POSTPROCESS_ID = 'forgeax-gamma::passthrough-correct';

/**
 * Post-process shader id for the no-gamma effect. Applies pow(col, 2.2)
 * which UNDOES the sRGB encoding the swap-chain will reapply, leaving the
 * raw linear values on the display surface (the canonical "too dark"
 * LearnOpenGL 5.2 no-gamma image).
 */
export const GAMMA_WRONG_POSTPROCESS_ID = 'forgeax-gamma::wrong-gamma';

/** RenderPipeline ids passed to renderer.registerPipeline + handle resolve. */
export const GAMMA_CORRECT_PIPELINE_ID = 'learn-render-2-gamma::correct';
export const GAMMA_WRONG_PIPELINE_ID = 'learn-render-2-gamma::wrong';

const OFFSCREEN_SRGB_KEY = 'offscreenSrgb';
const OFFSCREEN_DEPTH_KEY = 'gammaDepth';
const INTERMEDIATE_LINEAR_KEY = 'intermediateLinear';

/**
 * Build a single per-mode RenderPipeline.buildGraph closure: declare
 * offscreen sRGB color + depth targets, run addScenePass into them, then
 * sample 'offscreenSrgb' through addFullscreenPass writing to the swap-chain
 * via the per-mode shader id (passthrough-correct vs wrong-gamma). The
 * 'wrong' mode additionally declares a non-sRGB ('bgra8unorm')
 * 'intermediateLinear' color target as the AI-user surface anchor for the
 * AC-12 non-sRGB target grep gate.
 *
 * One closure per mode (not one parameterised closure) so AI users grep
 * `addFullscreenPass` and find the per-mode call site listed by name; the
 * 'wrong' branch additionally lists `addColorTarget(... 'bgra8unorm' ...)`
 * inline so the non-sRGB target literal is co-located with the consuming
 * pipeline.
 */
export function makeGammaPipeline(mode: GammaMode): RenderPipeline {
  return {
    buildGraph(
      ctx: RenderPipelineContext,
      _data: RenderPipelineData,
    ): RenderGraph<RenderPipelineContext> | null {
      const graph = new RenderGraph<RenderPipelineContext>();

      // Offscreen sRGB color target. Format MUST match the engine's
      // colorAttachmentFormat — the swap-chain view format from
      // selectSwapChainFormat: 'bgra8unorm-srgb' on macOS/Windows (UA-preferred
      // since bug-20260612-webgpu-canvas-format-prefer-bgra), 'rgba8unorm-srgb'
      // on the GLES fallback — so the standard PBR / unlit material pipeline
      // cache hits without a per-target re-compile. Hardcoding 'rgba8unorm-srgb'
      // mismatched the geometry PSO on BGRA runners (nightly #385/#391).
      const swapChainColorFormat =
        ctx.pipelineState?.colorAttachmentFormat ?? 'rgba8unorm-srgb';
      graph.addColorTarget(OFFSCREEN_SRGB_KEY, {
        format: swapChainColorFormat,
        size: 'swapchain',
        sample: 1,
        usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
      });
      graph.addColorTarget(OFFSCREEN_DEPTH_KEY, {
        format: 'depth24plus-stencil8',
        size: 'swapchain',
        sample: 1,
        usage: 0x10, // RENDER_ATTACHMENT
      });

      if (mode === 'wrong') {
        // Non-sRGB intermediate target (format: 'bgra8unorm', no '-srgb'
        // suffix). AC-12 grep gate anchor: the demo declares the API surface
        // for a linear/raw write target via addColorTarget with a
        // bgra8unorm format. This target is declared for AI-user reference and
        // stays unbound to a pass write/read; the fullscreen post pass writes
        // the swap-chain view (whose format dispatchFullscreenPass now follows
        // via ctx.pipelineState.colorAttachmentFormat). The visual delta
        // between correct and wrong modes is produced by the wrong-gamma
        // fragment shader (pow(col, 2.2)) instead.
        graph.addColorTarget(INTERMEDIATE_LINEAR_KEY, {
          format: 'bgra8unorm',
          size: 'swapchain',
          sample: 1,
          usage: 0x10 | 0x04, // RENDER_ATTACHMENT | TEXTURE_BINDING
        });
      }

      addScenePass(graph, 'main', {
        color: OFFSCREEN_SRGB_KEY,
        depth: OFFSCREEN_DEPTH_KEY,
        // feat-20260609 T-003: required pipeline-specific selector. URP forward
        // pass convention; matches the standard PBR / unlit material's
        // `LightMode: 'Forward'` pass tags so this offscreen render walks the
        // same dispatch as urp-pipeline's main pass.
        selector: { LightMode: ['Forward'] },
        // T-12-a opt-in: route geometry into our offscreen RT, bypassing
        // urp-pipeline's tonemap+MSAA gate selection of geometryColorView.
        _routeFromOpts: true,
      });

      const postShaderId =
        mode === 'correct' ? GAMMA_CORRECT_POSTPROCESS_ID : GAMMA_WRONG_POSTPROCESS_ID;
      addFullscreenPass(graph, 'postGamma', {
        shader: postShaderId,
        // 'swapchain' is the engine-built-in reserved key (graph.ts
        // validateNoUnknownResource): the dispatcher's resolveCtx.resolve
        // returns undefined and writeView falls through to ctx.view (the
        // current swap-chain view).
        color: 'swapchain',
        reads: [OFFSCREEN_SRGB_KEY],
      });

      const compileResult = graph.compile({
        backendKind: ctx.runtime.device.caps.backendKind,
        caps: ctx.runtime.device.caps,
        device: ctx.runtime.device,
      });
      if (!compileResult.ok) {
        const e = compileResult.error;
        console.error(
          '[learn-render 5.2 gamma-correction] graph.compile failed:',
          e.code,
          'expected:',
          e.expected,
          'hint:',
          e.hint,
          'detail:',
          e.detail,
        );
        return null;
      }
      return graph;
    },
    execute(ctx: RenderPipelineContext): void {
      ctx.frameState.perFrameGraph?.execute(ctx);
    },
  };
}
