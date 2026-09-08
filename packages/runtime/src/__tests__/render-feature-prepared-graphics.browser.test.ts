import type { Renderer } from '@forgeax/engine-render';
import { afterEach, describe, expect, it } from 'vitest';
import {
  frameRequest,
  preparedFeature,
  preparedWorld,
} from './render-feature-prepared-graphics.fixture';
import { requireRenderer } from './renderer-test-utils';

describe('prepared graphics browser contract', () => {
  let renderer: Renderer | undefined;

  afterEach(() => {
    renderer?.dispose();
    renderer = undefined;
  });

  it('records a prepared operation through real WebGPU and returns a receipt', async () => {
    if (typeof navigator?.gpu?.requestAdapter !== 'function') {
      throw new Error('WebGPU is unavailable');
    }
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    document.body.append(canvas);
    renderer = await requireRenderer(
      canvas,
      { features: [preparedFeature('synthetic.browser.prepared')] },
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    const errors: string[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error.code);
    });
    const world = preparedWorld();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update(1 / 60).ok).toBe(true);
    const frame = renderer.draw(frameRequest(attached.value));
    expect(frame.ok).toBe(true);
    if (frame.ok)
      expect((await renderer.observe(frame.value, { include: ['draws'] })).ok).toBe(true);
    expect(errors).not.toContain('render-feature-prepared-state-mismatch');
    canvas.remove();
  });

  // This negative path intentionally exercises a real WebGPU pipeline before
  // the renderer reports the structured stage error. Its cold lavapipe start
  // has exceeded Vitest's 15s default in CI; keep the assertion bounded at the
  // owner rather than weakening the global browser timeout.
  it('reports forged prepared state through subscribe without renderer diagnostics getters', async () => {
    if (typeof navigator?.gpu?.requestAdapter !== 'function') {
      throw new Error('WebGPU is unavailable');
    }
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    document.body.append(canvas);
    renderer = await requireRenderer(
      canvas,
      { features: [preparedFeature('synthetic.browser.mismatch', 'mismatch')] },
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    const errors: Array<{ code: string; causeCode?: string }> = [];
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      errors.push({
        code: event.error.code,
        ...(event.error.code === 'device-operation-failed'
          ? { causeCode: event.error.detail.cause.code }
          : {}),
      });
    });
    const world = preparedWorld();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update(1 / 60).ok).toBe(true);
    expect(renderer.draw(frameRequest(attached.value)).ok).toBe(true);
    expect(errors).toContainEqual({
      code: 'device-operation-failed',
      causeCode: 'render-feature-stage-failed',
    });
    expect(renderer).not.toHaveProperty('renderFeatureDiagnostics');
    canvas.remove();
  }, 30_000);
});
