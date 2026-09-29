import { shaderManifestUrl as createShaderManifestUrl } from '../../../../../../packages/runtime/src/__tests__/shader-manifest-url.fixture';
import { describe, expect, it } from 'vitest';
import { EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES } from '@forgeax/engine-render/internal';
import fixture from '../recovery.json' with { type: 'json' };
import { validateSceneCase } from '../../../src/contracts/load-scene-case';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { runExtendedLightingCarrier } from '../../../src/compare/extended-case-carrier';
import type { SceneCase } from '../../../src/contracts/types';

describe('extended-lighting recovery Dawn carrier', () => {
  it('recovers the live Dawn carrier across three destroyed devices', { timeout: 90_000 }, async () => {
    const validation = validateSceneCase(fixture);
    expect(validation.ok).toBe(true);
    expect(navigator.gpu).toBeDefined();
    const adapter = await navigator.gpu?.requestAdapter();
    const adapterSupportsExtendedLighting =
      (adapter?.limits.maxSampledTexturesPerShaderStage ?? 0) >=
      EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES;
    const manifest = await buildEngineShaderManifest();
    const receipt = await runExtendedLightingCarrier({
      fixture: fixture as unknown as SceneCase,
      exactProductHead: 'dawn-exact-head',
      bundler: { shaderManifestUrl: createShaderManifestUrl(manifest) },
    });
    if (adapterSupportsExtendedLighting) {
      expect(receipt.status).toBe('recovered');
      expect(receipt.capability.admitted).toBe(true);
      expect(receipt.capability.maxSampledTexturesPerShaderStage).toBeGreaterThanOrEqual(
        EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES,
      );
    }
    if (receipt.status === 'unsupported') {
      expect(receipt.verdict).toBe('notRun');
      expect(receipt.capability.admitted).toBe(false);
      expect(receipt.unavailable?.topology).toBe('extendedLighting');
      expect(receipt.unavailable?.reason).toBe(receipt.capability.reason);
      return;
    }
    expect(receipt).toMatchObject({ caseId: 'recovery', status: 'recovered', verdict: 'passed' });
    expect(receipt.recovery?.cycles).toBe(3);
    expect(receipt.recovery?.generations).toHaveLength(4);
    expect(receipt.recovery?.terminalState).toBe('alive');
    expect(receipt.inspection.extendedLighting.lastKnownGood).toBeDefined();
    expect(receipt.finalDisplay.nonBlackPixels).toBeGreaterThan(0);
  });
});
