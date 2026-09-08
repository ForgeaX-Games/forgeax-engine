import { createFullscreenRenderFeature } from '@forgeax/engine-app';

export const FOG_POSTPROCESS_ID = 'bevy-fog::distance';
const FOG_PARAMS_BYTES = 16;

const FOG_MODE_VALUE = {
  linear: 0,
  exponential: 1,
  'exponential-squared': 2,
} as const;

export type FogFalloffMode = keyof typeof FOG_MODE_VALUE;

export function createFogFeatureFromSource(source: string) {
  return createFullscreenRenderFeature({
    identity: FOG_POSTPROCESS_ID,
    source,
    reads: [{ key: 'sceneColor' }, { key: 'depth', sampleType: 'depth' }],
    // A registered fullscreen feature remains in the graph even when its
    // provider entity is detached. Zero exponential density is the explicit
    // pass-through default for that no-provider state.
    params: { byteSize: FOG_PARAMS_BYTES, defaultValue: packFogParams('exponential', 0, 20) },
  });
}

export function packFogParams(mode: FogFalloffMode, startOrDensity: number, end = 20): Uint8Array {
  const bytes = new ArrayBuffer(FOG_PARAMS_BYTES);
  const values = new Float32Array(bytes);
  values[0] = FOG_MODE_VALUE[mode];
  values[1] = startOrDensity;
  values[2] = end;
  values[3] = 0;
  return new Uint8Array(bytes);
}
