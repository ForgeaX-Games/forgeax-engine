import { shaderManifestUrl as createShaderManifestUrl } from '../../../../../../packages/runtime/src/__tests__/shader-manifest-url.fixture';
import { describe, expect, it } from 'vitest';
import fixture from '../rect-area.json' with { type: 'json' };
import falsificationManifest from '../falsification/manifest.json' with { type: 'json' };
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { runExtendedLightingCarrier } from '../../../src/compare/extended-case-carrier';
import type { SceneCase } from '../../../src/contracts/types';

describe('extended-lighting RectArea Dawn consumer', () => {
  it('keeps the required native evidence contract explicit', () => {
    expect(fixture.scene.width).toBe(64);
    expect(fixture.scene.height).toBe(64);
    expect(fixture.budget.analyticMax).toBe(0.05);
    expect(fixture.budget.roiMax).toBe(0.05);
    expect(falsificationManifest.required).toBe(true);
  });

  it('captures live RectArea Dawn linear-HDR and final-display evidence', async () => {
    expect(navigator.gpu).toBeDefined();
    const manifest = await buildEngineShaderManifest();
    const receipt = await runExtendedLightingCarrier({
      fixture: fixture as unknown as SceneCase,
      exactProductHead: 'dawn-exact-head',
      bundler: { shaderManifestUrl: createShaderManifestUrl(manifest) },
    });
    if (receipt.status === 'unsupported') {
      expect(receipt.verdict).toBe('notRun');
      expect(receipt.capability.admitted).toBe(false);
      expect(receipt.unavailable?.topology).toBe('extendedLighting');
      expect(receipt.unavailable?.reason).toBe(receipt.capability.reason);
      return;
    }
    expect(receipt).toMatchObject({ caseId: 'rect-area', status: 'ready', verdict: 'passed' });
    expect(receipt.referenceKinds).toEqual(['three-r184-native-webgl2-rect-area-plus-finite-range-adapter']);
    expect(receipt.linearHdr.format).toBe('rgba16float');
    expect(receipt.linearHdr.byteLength).toBeGreaterThan(0);
    expect(receipt.finalDisplay.byteLength).toBe(64 * 64 * 4);
    expect(receipt.finalDisplay.nonBlackPixels).toBeGreaterThan(0);
  });
});
