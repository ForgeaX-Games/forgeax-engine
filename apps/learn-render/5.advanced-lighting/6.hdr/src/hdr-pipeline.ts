// apps/learn-render/5.advanced-lighting/6.hdr/src/hdr-pipeline.ts
// LearnOpenGL section 5.6 - HDR.
//
// Custom RenderPipeline factory + pure mode-switch function. Two
// RenderPipelineAsset handles, hot-swapped via `renderer.installPipeline`:
//   key '1' -> HDR pipeline      (rgba16float offscreen + LO exposure tonemap)
//   key '2' -> LDR pipeline      (rgba16float offscreen + passthrough; LDR
//                                  swap-chain rgba8unorm-srgb store clamps
//                                  > 1.0 values to white -> burn-to-white
//                                  is the canonical LO 5.6 LDR teaching
//                                  artefact)
//
// The two modes share an identical 2-pass graph topology:
//   addColorTarget('offscreenHdr', { format: 'rgba16float' })
//   addDepthTarget('hdrDepth')
//   addScenePass('main', { color: offscreenHdr, depth, _routeFromOpts: true })
//   addFullscreenPass('postHdr', { shader: <per-mode>, color: 'swapchain',
//                                   reads: ['offscreenHdr'] })
// They differ only in the post-process WGSL fragment registered against
// the per-mode shader id (HDR_EXPOSURE_POSTPROCESS_ID for the LO exposure
// tonemap; HDR_PASSTHROUGH_POSTPROCESS_ID for the LDR passthrough).
//
// Forgeax production-grade tonemapping path, in contrast, declares
// `Camera.tonemap = TONEMAP_REINHARD_EXTENDED` and lets the URP default
// pipeline run `packages/shader/src/tonemap.wgsl` as the engine-built-in
// tonemap pass (see 7.bloom for that surface). This 6.hdr demo
// intentionally hand-rolls a tiny LO exposure tonemap inline so the
// LearnOpenGL teaching equation `1.0 - exp(-hdrColor * exposure)` is
// grep-able in src/index.ts (AC-11) and the dual-pipeline mode-switch
// surface (`renderer.installPipeline(asset)`) is exercised end-to-end.
//
// GREP anchors for AI users:
//   - "addColorTarget"          rgba16float offscreen color target
//   - "addScenePass"            geometry pass into offscreen HDR target
//   - "addFullscreenPass"       per-mode fullscreen blit to swap-chain
//   - "rgba16float"             HDR storage format literal
//   - "installHdrPipelineByKey" pure key -> RenderPipelineAsset table-lookup

import { RenderGraph } from '@forgeax/engine-render-graph';
import {
  addFullscreenPass,
  addScenePass,
  type RenderPipeline,
  type RenderPipelineContext,
  type RenderPipelineData,
} from '@forgeax/engine-runtime';
import { type Result, err, ok } from '@forgeax/engine-types';
import type { RenderPipelineAsset } from '@forgeax/engine-types';

/**
 * Closed roster of HDR demo modes. The two values map 1:1 to the two
 * RenderPipelineAsset PODs src/index.ts registers; pressing keys 1/2
 * hot-swaps `installPipeline` between them.
 */
export type HdrMode = 'hdr' | 'ldr';

/** Post-process shader id for the HDR LO-exposure tonemap fragment. */
export const HDR_EXPOSURE_POSTPROCESS_ID = 'learn-render::5-6-hdr-lo-exposure';

/** Post-process shader id for the LDR passthrough fragment (burns to white). */
export const HDR_PASSTHROUGH_POSTPROCESS_ID = 'learn-render::5-6-hdr-passthrough';

/** RenderPipeline ids passed to renderer.registerPipeline + handle resolve. */
export const HDR_PIPELINE_ID = 'learn-render-5-6-hdr::hdr';
export const LDR_PIPELINE_ID = 'learn-render-5-6-hdr::ldr';

const OFFSCREEN_HDR_KEY = 'offscreenHdr';
const OFFSCREEN_DEPTH_KEY = 'hdrDepth';

/**
 * Build a single per-mode RenderPipeline.buildGraph closure: declare an
 * rgba16float offscreen color target + depth target, run addScenePass into
 * them via `_routeFromOpts: true`, then sample 'offscreenHdr' through
 * addFullscreenPass writing to the swap-chain via the per-mode shader id
 * (HDR_EXPOSURE_POSTPROCESS_ID vs HDR_PASSTHROUGH_POSTPROCESS_ID).
 *
 * One closure per mode (not one parameterised closure body) so AI users
 * grep `addFullscreenPass` and find the per-mode call site listed by
 * shader id literal.
 */
export function makeHdrPipeline(mode: HdrMode): RenderPipeline {
  return {
    buildGraph(
      ctx: RenderPipelineContext,
      _data: RenderPipelineData,
    ): RenderGraph<RenderPipelineContext> | null {
      const graph = new RenderGraph<RenderPipelineContext>();

      // HDR offscreen color target: rgba16float so per-channel values can
      // exceed 1.0 without clamping; the post-process pass tonemaps the
      // HDR value range down before the swap-chain rgba8unorm-srgb store.
      graph.addColorTarget(OFFSCREEN_HDR_KEY, {
        format: 'rgba16float',
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

      addScenePass(graph, 'main', {
        color: OFFSCREEN_HDR_KEY,
        depth: OFFSCREEN_DEPTH_KEY,
        // URP forward-pass selector convention; matches the standard PBR /
        // unlit material's `LightMode: 'Forward'` pass tags so this
        // offscreen render walks the same dispatch as urp-pipeline's main.
        selector: { LightMode: ['Forward'] },
        // Opt-in: route geometry into our offscreen rgba16float RT,
        // bypassing urp-pipeline's tonemap+MSAA gate selection of
        // geometryColorView (sibling feat-20260609 T-12-a).
        _routeFromOpts: true,
      });

      const postShaderId =
        mode === 'hdr' ? HDR_EXPOSURE_POSTPROCESS_ID : HDR_PASSTHROUGH_POSTPROCESS_ID;
      addFullscreenPass(graph, 'postHdr', {
        shader: postShaderId,
        // 'swapchain' is the engine-built-in reserved key (graph.ts
        // validateNoUnknownResource): the dispatcher's resolveCtx.resolve
        // returns undefined and writeView falls through to ctx.view (the
        // current swap-chain view, rgba8unorm-srgb).
        color: 'swapchain',
        reads: [OFFSCREEN_HDR_KEY],
      });

      const compileResult = graph.compile({
        backendKind: ctx.runtime.device.caps.backendKind,
        caps: ctx.runtime.device.caps,
        device: ctx.runtime.device,
      });
      if (!compileResult.ok) {
        const e = compileResult.error;
        console.error(
          '[learn-render 5.6 hdr] graph.compile failed:',
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

// ---------------------------------------------------------------------------
// Mode-switch pure function (AC-10, no GPU dependency)
// ---------------------------------------------------------------------------

/**
 * Closed Result error shape for installHdrPipelineByKey. Mirrors
 * gamma-correction's `pipelines-not-ready` / `unknown-*-key` error model
 * (AGENTS.md §Error model: closed unions, exhaustive `switch (err.code)`
 * without default).
 */
export type HdrInstallError =
  | { code: 'pipelines-not-ready'; hint: string }
  | { code: 'unknown-hdr-key'; hint: string };

/**
 * Renderer surface needed by the mode-switch pure function. Narrowed to
 * just `installPipeline` so unit tests can stub a fake renderer without
 * pulling in the full RhiRenderer type.
 */
export interface HdrPipelineRegistry {
  assetsByKey: ReadonlyMap<string, RenderPipelineAsset>;
  renderer: {
    installPipeline(
      asset: RenderPipelineAsset,
    ): { ok: true } | { ok: false; error: { code: string; hint?: string } };
  };
}

let activeRegistry: HdrPipelineRegistry | null = null;

/**
 * Install one of the two HDR pipelines by keyboard digit.
 *   '1' -> HDR (LO exposure tonemap)
 *   '2' -> LDR (passthrough; burns to white)
 * Returns Result-shape per AGENTS.md §Error model: closed union over
 * `pipelines-not-ready` (registry not yet populated by bootstrap) and
 * `unknown-hdr-key` (key outside the closed roster).
 */
export function installHdrPipelineByKey(key: string): Result<true, HdrInstallError> {
  if (activeRegistry === null) {
    return err({
      code: 'pipelines-not-ready',
      hint: 'await app.start() resolves before calling installHdrPipelineByKey',
    });
  }
  const asset = activeRegistry.assetsByKey.get(key);
  if (asset === undefined) {
    return err({
      code: 'unknown-hdr-key',
      hint: `expected '1' or '2'; received ${JSON.stringify(key)}`,
    });
  }
  const installRes = activeRegistry.renderer.installPipeline(asset);
  if (!installRes.ok) {
    return err({
      code: 'pipelines-not-ready',
      hint: installRes.error.hint ?? installRes.error.code,
    });
  }
  return ok(true);
}

/** Public lookup mirror: '1' -> 'hdr', '2' -> 'ldr'. */
export function hdrDisplayNameByKey(key: string): HdrMode | null {
  if (key === '1') return 'hdr';
  if (key === '2') return 'ldr';
  return null;
}

/**
 * Bootstrap-only setter. Called once by src/index.ts after the two
 * RenderPipelineAsset PODs are built + renderer is ready.
 */
export function setHdrPipelineRegistryForTest(registry: HdrPipelineRegistry): void {
  activeRegistry = registry;
}

/** Test-only reset. Clears the module-level registry between unit tests. */
export function resetHdrPipelineRegistryForTest(): void {
  activeRegistry = null;
}
