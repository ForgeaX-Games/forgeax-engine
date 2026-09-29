import { shaderManifestUrl as createShaderManifestUrl } from '../../../../../../packages/runtime/src/__tests__/shader-manifest-url.fixture';
import { describe, expect, it } from 'vitest';
import fixture from '../probe.json' with { type: 'json' };
import { validateSceneCase } from '../../../src/contracts/load-scene-case';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { runExtendedLightingCarrier } from '../../../src/compare/extended-case-carrier';
import type { SceneCase } from '../../../src/contracts/types';

describe('extended-lighting Probe Dawn carrier', () => {
  it('matches live Dawn ProbeBlendRecord coverage to the independent oracle', async () => {
    const validation = validateSceneCase(fixture);
    expect(validation.ok).toBe(true);
    expect(navigator.gpu).toBeDefined();
    const manifest = await buildEngineShaderManifest();
    const receipt = await runExtendedLightingCarrier({
      fixture: fixture as unknown as SceneCase,
      exactProductHead: 'dawn-exact-head',
      bundler: { shaderManifestUrl: createShaderManifestUrl(manifest) },
    });
    expect(receipt).toMatchObject({ caseId: 'probe', status: 'ready', verdict: 'passed' });
    expect(receipt.probeComparison).toMatchObject({ recordCount: 9 });
    expect(receipt.probeComparison?.maxDelta).toBeLessThanOrEqual(1e-5);
    expect(receipt.inspection.renderScene.probeBlend?.finite).toBe(true);
    expect(receipt.linearHdr.byteLength).toBeGreaterThan(0);
    expect(receipt.finalDisplay.nonBlackPixels).toBeGreaterThan(0);
  });
});
