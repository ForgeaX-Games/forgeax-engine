import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { verifyTaaStabilityFeedback } from './taa-stability-feedback';

it('preserves temporal metadata and accumulates cyclic radiance without biased half-float feedback', async () => {
  const source = readFileSync(resolve('packages/shader/src/taa-resolve.wgsl'), 'utf8').replace(
    /^#define_import_path.*$/gm,
    '',
  );
  await verifyTaaStabilityFeedback(source);
  const premature = source.replace(
    'mix(0.95, 0.99, smoothstep(64.0, TAA_HISTORY_SETTLE_FRAMES, stableAge))',
    '0.99',
  );
  expect(premature).not.toBe(source);
  await expect(verifyTaaStabilityFeedback(premature)).rejects.toThrow(
    'TAA must follow delayed accumulation',
  );
});

it('invalidates final TAA for secondary source motion without changing receiver velocity', async () => {
  const source = readFileSync(resolve('packages/shader/src/taa-resolve.wgsl'), 'utf8').replace(
    /^#define_import_path.*$/gm,
    '',
  );
  await verifyTaaStabilityFeedback(source, 'secondary-motion');
  const ignored = source.replace(
    /fn sampleSecondaryReactivity\([\s\S]*?\n}/,
    'fn sampleSecondaryReactivity(uv : vec2<f32>) -> f32 { return 0.0; }',
  );
  expect(ignored).not.toBe(source);
  await expect(verifyTaaStabilityFeedback(ignored, 'secondary-motion')).rejects.toThrow(
    'secondary motion must reject old radiance',
  );
});

it('preserves phase-local coverage while rejecting persistent unmarked color changes', async () => {
  const source = readFileSync(resolve('packages/shader/src/taa-resolve.wgsl'), 'utf8').replace(
    /^#define_import_path.*$/gm,
    '',
  );
  await verifyTaaStabilityFeedback(source, 'clipping-recovery');
  const resetFootprint = source.replace(
    'return TaaClipDecision(clipped, TAA_HISTORY_SETTLE_FRAMES / 255.0);',
    'return TaaClipDecision(clipped, 0.0);',
  );
  expect(resetFootprint).not.toBe(source);
  await expect(verifyTaaStabilityFeedback(resetFootprint, 'clipping-recovery')).rejects.toThrow(
    'color clipping must not discard the accepted stationary reconstruction footprint',
  );
  const delayedRelease = source.replace(
    'smoothstep(TAA_STABILITY_FRAMES, 64.0, age)',
    '0.9 * smoothstep(64.0, TAA_HISTORY_SETTLE_FRAMES, age)',
  );
  expect(delayedRelease).not.toBe(source);
  await expect(verifyTaaStabilityFeedback(delayedRelease, 'clipping-recovery')).rejects.toThrow(
    'coverage must converge before increasing the stationary history weight',
  );
  const frozen = source.replace(
    /fn resolveTaaClipping\([\s\S]*?\n}/,
    'fn resolveTaaClipping(clipped : vec3<f32>, history : vec3<f32>, previous : f32, age : f32) -> TaaClipDecision { return TaaClipDecision(history, age / 255.0); }',
  );
  expect(frozen).not.toBe(source);
  await expect(verifyTaaStabilityFeedback(frozen, 'clipping-recovery')).rejects.toThrow(
    'persistent unmarked color change must recover within one jitter cycle',
  );
});
