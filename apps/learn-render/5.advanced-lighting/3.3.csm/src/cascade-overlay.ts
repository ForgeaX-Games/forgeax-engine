// apps/learn-render/5.advanced-lighting/3.3.csm/src/cascade-overlay.ts
// LearnOpenGL section 5.3 cascaded shadow maps -- demo-local cascade overlay
// debug-viz (requirements OOS-4: heuristic, NOT a true shadow atlas tile
// readback). This is debug-viz layered ON TOP of the engine's URP image, NOT a
// replacement render pipeline.
//
// The overlay is wired through the engine M4' post-URP post-process hook
// (`RenderPipelineAsset.config.postEffects`): URP renders the full lit scene
// (shadow cascades + tonemap + bloom + fxaa) into the swap-chain, then
// composites the registered cascade-tint effect over the final image. Because
// URP's 9-pass chain is untouched, the shadows the demo exists to show survive
// -- unlike the prior installPipeline-replacement approach, which dropped every
// URP shadow pass and rendered a shadow demo with no shadows.
//
// Per-mode the only difference is the TINT_MODE constant baked into the overlay
// fragment (regex-swapped from the compiled cascade-overlay.wgsl source); keys
// 1..4 highlight a single cascade, key 0 turns the overlay OFF (URP installed
// with an empty postEffects list -> zero extra passes -> bare lit scene).

import { URP_PIPELINE_ID } from '@forgeax/engine-runtime';
import type { RenderPipelineAsset } from '@forgeax/engine-types';
import overlayShader from './cascade-overlay.wgsl';

/** Closed roster of overlay tint modes. */
export type CsmOverlayMode = 'off' | 'all' | 'c1' | 'c2' | 'c3' | 'c4';

/** PSSM split config baked into cascade-overlay.wgsl; asserted at install. */
const CSM_NEAR = 0.1;
const CSM_FAR = 50;
const CSM_CASCADE_COUNT = 4;
const CSM_SPLIT_LAMBDA = 0.75;

const POSTPROCESS_ID_PREFIX = 'learn-render-5-3-3-csm::overlay';

/** TINT_MODE numeric value baked per mode (matches cascade-overlay.wgsl doc). */
const TINT_MODE_BY_MODE: Readonly<Record<CsmOverlayMode, number>> = {
  off: -1,
  all: 0,
  c1: 1,
  c2: 2,
  c3: 3,
  c4: 4,
};

/** Map a keyboard digit to an overlay mode (key '0' = off, '1'..'4' = single). */
export function csmOverlayModeForKey(key: string): CsmOverlayMode | null {
  if (key === '0') return 'off';
  if (key === '1') return 'c1';
  if (key === '2') return 'c2';
  if (key === '3') return 'c3';
  if (key === '4') return 'c4';
  return null;
}

/**
 * Recompute the PSSM cascade split distances demo-side with the SAME formula
 * the engine uses (render-system-extract.ts pssmSplit, not re-exported from
 * the runtime barrel -- research F6). These match the SPLIT_* constants baked
 * into cascade-overlay.wgsl.
 *
 *   C_i = lambda * n * (f/n)^(i/m) + (1 - lambda) * (n + (i/m)(f - n)),  i=1..m
 */
export function computeCsmSplits(): Float32Array {
  const m = CSM_CASCADE_COUNT;
  const n = CSM_NEAR;
  const f = CSM_FAR;
  const lambda = CSM_SPLIT_LAMBDA;
  const ratio = f / n;
  const out = new Float32Array(m);
  for (let i = 1; i <= m; i++) {
    const t = i / m;
    const logPart = n * ratio ** t;
    const uniformPart = n + t * (f - n);
    out[i - 1] = lambda * logPart + (1 - lambda) * uniformPart;
  }
  return out;
}

/**
 * Build the per-mode overlay WGSL by regex-swapping the single TINT_MODE
 * constant in the compiled cascade-overlay.wgsl source. The compiled source
 * preserves the `const TINT_MODE : f32 = <n>;` declaration verbatim.
 */
function overlaySourceForMode(mode: CsmOverlayMode): string {
  const tint = TINT_MODE_BY_MODE[mode];
  const literal = `${tint.toFixed(1)}`;
  return overlayShader.wgsl.replace(
    /const TINT_MODE : f32 = -?\d+(?:\.\d+)?;/,
    `const TINT_MODE : f32 = ${literal};`,
  );
}

function postProcessId(mode: CsmOverlayMode): string {
  return `${POSTPROCESS_ID_PREFIX}-${mode}`;
}

/**
 * Minimal renderer surface the overlay needs: register a post-process shader id
 * + (re)install the built-in URP with a `config.postEffects` list.
 */
export interface CsmOverlayRenderer {
  postProcess: {
    register(id: string, entry: { source: string; reads?: readonly string[] }): void;
  };
  installPipeline(
    asset: RenderPipelineAsset,
  ): { ok: true } | { ok: false; error: { code: string; hint?: string } };
}

const TINTED_MODES: readonly CsmOverlayMode[] = ['all', 'c1', 'c2', 'c3', 'c4'];

let activeRenderer: CsmOverlayRenderer | null = null;

/**
 * Register the five tinted overlay variants and install URP with the default
 * ('all' bands tinted) overlay composited on top. Call once after app.start()
 * resolves. Returns the recomputed PSSM splits (for logging / smoke assertion);
 * returns null on install error. The 'off' mode needs no registered shader --
 * it installs URP with an empty postEffects list.
 */
export function installCsmOverlay(renderer: CsmOverlayRenderer): Float32Array | null {
  for (const mode of TINTED_MODES) {
    renderer.postProcess.register(postProcessId(mode), {
      source: overlaySourceForMode(mode),
    });
  }
  activeRenderer = renderer;
  if (!setCsmOverlayMode('all')) return null;
  return computeCsmSplits();
}

/**
 * Hot-swap the active overlay by re-installing URP with the matching
 * `config.postEffects`. 'off' installs URP with an empty list (bare lit scene).
 */
export function setCsmOverlayMode(mode: CsmOverlayMode): boolean {
  if (activeRenderer === null) return false;
  const postEffects = mode === 'off' ? [] : [postProcessId(mode)];
  const res = activeRenderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: URP_PIPELINE_ID,
    config: { postEffects },
  });
  if (!res.ok) {
    console.error('[learn-render 5.3.3 csm] installPipeline(urp+overlay) failed:', res.error.code);
    return false;
  }
  return true;
}
