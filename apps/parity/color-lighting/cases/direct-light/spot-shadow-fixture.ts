import type { SceneCase } from '../../src/contracts/types';

import { decodeLinearHdrRgba16Float } from '../../src/capture/attachment-readback';
export {
  SPOT_SHADOW_SCENES,
  type SpotShadowFalsifier,
  type SpotShadowFalsifierId,
  type SpotShadowReceiverVariant,
  type SpotShadowRoi,
  type SpotShadowScene,
} from '../../src/spot-shadow-scene';
import {
  SPOT_SHADOW_SCENES,
  type SpotShadowFalsifierId,
  type SpotShadowScene,
} from '../../src/spot-shadow-scene';

/**
 * The parity runner still consumes the existing direct-light case identity.
 * Keeping this adapter here makes the camera/ROI/light authority shared by
 * Dawn and Browser while the current runner remains the execution owner.
 */
export function asSceneCase(scene: SpotShadowScene, pipeline: 'urp' | 'hdrp'): SceneCase {
  return {
    caseId: scene.caseId,
    required: true,
    colorDomain: 'linearHdr',
    pipeline: {
      identity: pipeline,
      engineId: pipeline === 'urp' ? 'forgeax::urp' : 'forgeax::hdrp',
    },
    light: {
      authorityId: 'threeR184SquaredWindow',
      kind: 'spot',
      color: scene.light.color,
      intensity: scene.light.intensity,
      range: scene.light.range,
      direction: scene.light.direction,
      innerConeDeg: scene.light.innerConeDeg,
      outerConeDeg: scene.light.outerConeDeg,
    },
    import: {
      source: 'none',
      intensityScale: 1,
      rangeZero: 'no-cutoff',
      cone: 'radians-to-degrees',
    },
    scene: scene.scene,
    budget: { analyticMax: 0.05, roiMax: 0.05, byteMax: 400 * 300 * 8 },
  };
}
export function meanLinearHdrLuminance(
  bytes: Uint8Array,
  width: number,
  roi: SpotShadowRoi,
): number {
  const pixels = decodeLinearHdrRgba16Float(bytes, width, Math.ceil(bytes.byteLength / (width * 8)));
  let sum = 0;
  let count = 0;
  for (let y = roi.y; y < roi.y + roi.height; y += 1) {
    for (let x = roi.x; x < roi.x + roi.width; x += 1) {
      const offset = (y * width + x) * 4;
      const r = pixels[offset] ?? 0;
      const g = pixels[offset + 1] ?? 0;
      const b = pixels[offset + 2] ?? 0;
      sum += (r * 0.2126 + g * 0.7152 + b * 0.0722);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

export function measureSpotShadowDelta(
  bytes: Uint8Array,
  scene: SpotShadowScene,
): { readonly lit: number; readonly shadow: number; readonly delta: number } {
  const lit = meanLinearHdrLuminance(bytes, scene.scene.width, scene.roi.lit);
  const shadow = meanLinearHdrLuminance(bytes, scene.scene.width, scene.roi.shadow);
  return { lit, shadow, delta: lit - shadow };
}
