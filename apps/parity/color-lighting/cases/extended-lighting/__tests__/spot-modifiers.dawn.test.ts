import { shaderManifestUrl as createShaderManifestUrl } from '../../../../../../packages/runtime/src/__tests__/shader-manifest-url.fixture';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { describe, expect, it } from 'vitest';
import fixture from '../spot-modifiers.json' with { type: 'json' };
import {
  runExtendedLightingCarrier,
  runExtendedLightingCookieContrast,
} from '../../../src/compare/extended-case-carrier';
import type { SceneCase } from '../../../src/contracts/types';
const sceneCase = fixture as unknown as SceneCase;

describe('extended-lighting Spot Dawn consumer', () => {
  it('renders the real IES × Cookie × shadow Spot composition', async () => {
    expect(navigator.gpu).toBeDefined();
    const manifest = await buildEngineShaderManifest();
    const receipt = await runExtendedLightingCarrier({
      fixture: sceneCase,
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
    expect(receipt).toMatchObject({ caseId: 'spot-modifiers', status: 'ready', verdict: 'passed' });
    expect(receipt.referenceKinds).toEqual(['three-r184-native-webgpu-spot-ies-cookie-shadow-combined']);
    expect(receipt.inspection.extendedLighting.resourceCount).toBeGreaterThan(0);
    expect(receipt.inspection.extendedLighting.uploadBytes).toBeGreaterThan(0);
    expect(receipt.linearHdr.byteLength).toBeGreaterThan(0);
    expect(receipt.finalDisplay.nonBlackPixels).toBeGreaterThan(0);
  });

  it('changes the Dawn pixels when the Cookie texture changes', { timeout: 120_000 }, async () => {
    expect(navigator.gpu).toBeDefined();
    const manifest = await buildEngineShaderManifest();
    const receipt = await runExtendedLightingCookieContrast({
      fixture: sceneCase,
      exactProductHead: 'dawn-exact-head',
      bundler: { shaderManifestUrl: createShaderManifestUrl(manifest) },
    });
    if (receipt.status === 'unsupported') {
      expect(receipt.reason).toBeTruthy();
      return;
    }
    expect(receipt.maxChannelDelta).toBeGreaterThan(8);
    expect(receipt.changedPixels).toBeGreaterThan(receipt.pixelCount * 0.02);
  });
});
