// @forgeax/engine-runtime - RenderPipeline interface (the forgeax engine concept,
// equivalent to Unity SRP's RenderPipeline) + RenderPipelineData per-frame snapshot
// placeholder (feat-20260601-customizable-render-pipeline-seam-and-dogfood-rend M1 / w3).
//
// `RenderPipeline` is the registrable / installable / hot-swappable unit that owns
// the per-frame render-graph topology. The engine's own standard forward pipeline
// (`forgeax::urp`) implements this same interface and is driven through
// the same public registerPipeline / installPipeline channel a user would use
// (dogfood hard constraint, requirements M1 item 6).
//
// Naming note (requirements line 155): `RenderPipeline` here is the forgeax engine
// concept name. The RHI GPU `RenderPipeline` handle (`@forgeax/engine-rhi`) is a
// separate, internal opaque-handle type distinguished by module path (AGENTS.md RHI
// form rules - "opaque handles distinguished by module path"); it is not exposed to
// AI users. Files importing both alias the RHI one locally.
//
// Method set is intentionally MINIMAL (requirements M1 item 1): buildGraph(ctx, data)
// + execute(ctx). It does NOT include consumes() / extract() - those are deferred to
// Feat 2 (requirements OOS-3).
//
// M2 stage (w10): `Ctx` defaults to the clean `RenderPipelineContext` dependency face
// (the former `RecordPassContext` full field set is deleted in w12) and `Data` defaults
// to the per-frame snapshot `RenderPipelineData` (plan-strategy D-A / D-B). `internals` is
// no longer reachable through the public pipeline ctx (AC-08 oracle).

import type { ColorValueDomain, RenderGraph } from '@forgeax/engine-render-graph';
import type { Tonemap } from './components/camera';
import type { RenderFeatureTargetHandle } from './features/targets';
import type { RenderPipelineContext, RenderPipelineData } from './render-pipeline-context';

export type { RenderPipelineContext, RenderPipelineData } from './render-pipeline-context';

export type RenderColorDomain = 'linearHdr' | 'linearLdr' | 'displayEncoded';

export interface ToneOutputContract {
  readonly input: RenderColorDomain;
  readonly toneMapped: boolean;
  readonly mapped: 'linearLdr';
  readonly finalCapture: 'displayEncoded';
  readonly exposureStage: 'linearHdr' | 'none';
}

export type RenderPostStageName = 'transparent-blend' | 'bloom' | 'tone' | 'fxaa' | 'output';
export type RenderPostDomainStage = readonly [
  RenderPostStageName,
  ColorValueDomain,
  ColorValueDomain,
];

/**
 * Single post-stage domain contract shared by URP and HDRP.
 * The pipeline selects the scene domain for transparent geometry; every later
 * stage follows the same linear blend, tone, anti-alias, and output sequence.
 */
export function resolvePostColorDomainContract(
  pipeline: 'urp' | 'hdrp',
): readonly RenderPostDomainStage[] {
  const sceneDomain: ColorValueDomain = pipeline === 'hdrp' ? 'linear-hdr' : 'linear-ldr';
  return [
    ['transparent-blend', sceneDomain, sceneDomain],
    ['bloom', 'linear-hdr', 'linear-hdr'],
    ['tone', 'linear-hdr', 'linear-ldr'],
    ['fxaa', 'linear-ldr', 'linear-ldr'],
    ['output', 'linear-ldr', 'display-encoded'],
  ];
}

/**
 * Describe the built-in output stages without moving color-domain policy into
 * a mode name. Tone-enabled cameras render HDR, apply exposure and the
 * selected curve in the fullscreen pass, then reach the encoded surface.
 */
export function resolveToneOutputContract(tonemap: Tonemap): ToneOutputContract {
  if (tonemap === 'none') {
    return {
      input: 'linearLdr',
      toneMapped: false,
      mapped: 'linearLdr',
      finalCapture: 'displayEncoded',
      exposureStage: 'none',
    };
  }
  return {
    input: 'linearHdr',
    toneMapped: true,
    mapped: 'linearLdr',
    finalCapture: 'displayEncoded',
    exposureStage: 'linearHdr',
  };
}

/** Narrow input used by a pipeline to publish logical feature attachments. */
export interface RenderFeatureTargetContext {
  readonly camera: Pick<RenderPipelineData['camera'], 'tonemap' | 'antialias'>;
  readonly colorAttachmentFormat: string;
  readonly backendKind: string;
  readonly storageBuffer: boolean;
}

/**
 * The forgeax render pipeline contract: a registrable, installable, hot-swappable unit
 * that builds and executes the per-frame render-graph.
 *
 * @typeParam Ctx - the pass-execution context handed to each render-graph closure.
 *   Defaults to the clean `RenderPipelineContext` dependency face (AC-08): `internals`
 *   is unreachable; only the named `assets` / `store` / `pipelineState` / `runtime` +
 *   per-view inputs are exposed.
 * @typeParam Data - the per-frame projected snapshot `RenderPipelineData` (camera /
 *   validated draw lists / target size / per-frame flags) handed to `buildGraph`.
 *
 * - `buildGraph(ctx, data)` constructs + compiles the per-frame `RenderGraph<Ctx>`
 *   (resource declarations + addPass + compile). Returns `null` when compile fails (the
 *   implementation fires a structured RhiError before returning null, matching the prior
 *   buildPerFrameGraph contract). The RenderSystem memoizes the returned graph and only
 *   rebuilds on a pipeline swap (brand-number change).
 * - `execute(ctx)` runs the compiled graph for one frame (`graph.execute(ctx)`).
 */
export interface RenderPipeline<Ctx = RenderPipelineContext, Data = RenderPipelineData> {
  /** Publish the scene color/depth contract for producer-owned graphics features. */
  readonly getRenderFeatureTargets?: (
    context: RenderFeatureTargetContext,
  ) => readonly RenderFeatureTargetHandle[];
  buildGraph(ctx: Ctx, data: Data): RenderGraph<Ctx> | null;
  execute(ctx: Ctx): void;
}
