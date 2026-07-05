// apps/learn-render/5.advanced-lighting/3.3.csm/src/cascade-overlay.ts
// LearnOpenGL section 5.3 cascaded shadow maps -- demo-local cascade overlay
// debug-viz post-process.
//
// feat-20260702-postprocess-camera-depth-read M4 w17: rewrite from 5-variant
// regex-swap + re-installPipeline to single shader with structured reads
// ({key, sampleType:'depth'}) + uniform params (PostProcessParams ECS
// component). Mode switching goes from "re-install whole URP" to "write 16 B
// UBO" (D-8: params@2, always present for fullscreen-post-with-scene-depth).
//
// The overlay is wired through the engine M4' post-URP post-process hook:
// URP renders the full lit scene (shadow cascades + tonemap + bloom + fxaa)
// into the swap-chain, then composites the cascade-tint effect over the final
// image. The overlay pass is always active (installed once); 'off' mode
// writes tintMode=-1 to params, which the shader detects and passthroughs.

import { PostProcessParams, URP_PIPELINE_ID } from '@forgeax/engine-runtime';
import type { RenderPipelineAsset } from '@forgeax/engine-types';
import overlayShader from './cascade-overlay.wgsl';

/** Closed roster of overlay tint modes. */
export type CsmOverlayMode = 'off' | 'all' | 'c1' | 'c2' | 'c3' | 'c4';

const POSTPROCESS_ID = 'learn-render-5-3-3-csm::overlay';
const PARAMS_BYTE_SIZE = 16;

/**
 * PSSM split config baked into cascade-overlay.wgsl; asserted at install.
 * The engine PSSM range is [camera near, DirectionalLight.shadowDistance], so
 * CSM_NEAR must equal the demo camera near (CAMERA_NEAR=0.1) and CSM_FAR must
 * equal the light's shadowDistance (50) for the overlay bands to match the
 * engine's cascade selection.
 */
const CSM_NEAR = 0.1;
const CSM_FAR = 50;
const CSM_CASCADE_COUNT = 4;
const CSM_SPLIT_LAMBDA = 0.75;

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
 * Pack a CsmOverlayMode into 16 B of UBO data for the PostProcessParams struct
 * (tintMode: f32 @ offset 0, fakeDepth: f32 @ offset 4, _pad: vec2<f32> @ offset 8).
 */
function packModeBytes(mode: CsmOverlayMode): Uint8Array {
  const buf = new ArrayBuffer(PARAMS_BYTE_SIZE);
  const f32 = new Float32Array(buf);
  f32[0] = TINT_MODE_BY_MODE[mode];
  f32[1] = 0; // fakeDepth: 0 = real depth from engine channel
  f32[2] = 0; // pad
  f32[3] = 0; // pad
  return new Uint8Array(buf);
}

/**
 * Minimal renderer surface the overlay needs: register a post-process shader
 * id with structured reads + params, and install the URP pipeline with the
 * overlay post-effect.
 */
export interface CsmOverlayRenderer {
  postProcess: {
    register(
      id: string,
      entry: {
        source: string;
        reads?: readonly ({ key: string; sampleType?: 'depth' } | string)[];
        params?: { byteSize: number; defaultValue: Uint8Array };
      },
    ): void;
  };
  installPipeline(
    asset: RenderPipelineAsset,
  ): { ok: true } | { ok: false; error: { code: string; hint?: string } };
}

type WorldLike = {
  spawn: (...args: any[]) => { unwrap(): any };
  set: (...args: any[]) => void;
};

let activeWorld: WorldLike | null = null;
let activeParamsEntity: unknown = null;

/**
 * Register the single cascade-overlay shader with structured reads + params,
 * spawn a PostProcessParams entity for per-frame mode switching, and install
 * URP once with the overlay as a permanent post-effect. Call once after
 * app.start() resolves. Returns the recomputed PSSM splits (for logging /
 * smoke assertion); returns null on install error.
 */
export function installCsmOverlay(
  renderer: CsmOverlayRenderer,
  world: WorldLike,
): Float32Array | null {
  // Register one shader with depth-channel read (D-3 BGL kind
  // fullscreen-post-with-scene-depth) + uniform params.
  renderer.postProcess.register(POSTPROCESS_ID, {
    source: overlayShader.wgsl,
    reads: [{ key: 'sceneColor' }, { key: 'depth', sampleType: 'depth' }],
    params: { byteSize: PARAMS_BYTE_SIZE, defaultValue: packModeBytes('all') },
  });

  // Spawn PostProcessParams entity so the engine writes params UBO per-frame.
  // tintMode changes via world.set() in setCsmOverlayMode (D-8: UBO write
  // replaces re-installPipeline).
  activeParamsEntity = world.spawn({
    component: PostProcessParams,
    data: { shader: POSTPROCESS_ID, data: packModeBytes('all') },
  }).unwrap();

  // Install URP once with the overlay (always active pass; 'off' mode
  // handled via tintMode=-1 in params -- shader passthroughs).
  const res = renderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: URP_PIPELINE_ID,
    config: { postEffects: [POSTPROCESS_ID] },
  });
  if (!res.ok) {
    console.error(
      '[learn-render 5.3.3 csm] installPipeline(urp+overlay) failed:',
      res.error.code,
    );
    return null;
  }

  activeWorld = world;
  return computeCsmSplits();
}

/**
 * Hot-swap the overlay tint mode by writing to the PostProcessParams UBO.
 * No pipeline re-install -- the shader pass is always active (D-8).
 */
export function setCsmOverlayMode(mode: CsmOverlayMode): boolean {
  if (activeWorld === null || activeParamsEntity === null) return false;
  activeWorld.set(activeParamsEntity, PostProcessParams, { data: packModeBytes(mode) });
  return true;
}