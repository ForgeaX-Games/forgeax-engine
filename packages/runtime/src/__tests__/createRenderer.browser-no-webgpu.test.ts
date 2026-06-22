// feat-20260525-rhi-delete-webgl2-stub M4 / w17:
// Browser-no-webgpu fallback test — verifies that when navigator.gpu is absent
// (chromium launched without --enable-unsafe-webgpu), createRenderer does NOT
// silently return a no-op renderer (the deleted channel 4 WebGL2 stub behavior).
//
// Acceptable outcomes:
//   A. createRenderer succeeds (channel 3 rhi-wgpu wasm webgl backend works)
//   B. createRenderer throws EngineEnvironmentError (channel 3 wasm load/init
//      failed in headless CI — loud failure, not silent)
//
// The test's primary assertion: "no silent no-op renderer" — if createRenderer
// resolves, the returned renderer must have backend === 'webgpu' and
// rhiAvailable must not be false (the old channel 4 shape).

import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';

describe('createRenderer without navigator.gpu (browser-no-webgpu)', () => {
  it('navigator.gpu is absent or non-functional in this browser environment', async () => {
    const nav = globalThis.navigator as { gpu?: GPU };
    if (nav.gpu === undefined) return;
    const adapter = await nav.gpu.requestAdapter();
    expect(adapter).toBeNull();
  });

  it('createRenderer either succeeds (channel 3) or throws EngineEnvironmentError — never returns a no-op renderer', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;

    try {
      const renderer = await createRenderer(canvas);
      // Channel 3 succeeded (rhi-wgpu wasm with internal webgl backend).
      // Verify it is a real renderer, not the deleted channel 4 no-op stub.
      expect(renderer.backend).toBe('webgpu');
      // The old channel 4 stub would have set rhiAvailable=false on the
      // renderer — verify that property does not exist or is not false.
      const rendererAny = renderer as unknown as Record<string, unknown>;
      expect(rendererAny.rhiAvailable).not.toBe(false);
      renderer.dispose();
    } catch (error: unknown) {
      // Channel 3 failed — acceptable in headless CI without a real GPU
      // context. The critical assertion: the error MUST be an
      // EngineEnvironmentError (loud, structured failure), not a silent
      // swallow that returns a no-op renderer.
      expect(error).toBeInstanceOf(EngineEnvironmentError);
      if (error instanceof EngineEnvironmentError) {
        // Verify the structured detail is populated so AI consumers can
        // diagnose the failure (charter P4 explicit failure).
        expect(error.reason).toBeTruthy();
        // w22 / M4: detail must never be empty — at least one of webgpuError
        // or wgpuError must be present.
        const hasWebgpu = error.detail.webgpuError !== undefined;
        const hasWgpu = error.detail.wgpuError !== undefined;
        expect(hasWebgpu || hasWgpu).toBe(true);
      }
    }
  });
});
