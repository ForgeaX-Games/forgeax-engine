import { SUT_ATTRIBUTABLE_CODES } from '@forgeax/apps-shared/onerror-gate';
import { afterEach, describe, expect, it } from 'vitest';

describe('learn-render 1.2 hello-triangle onerror-gate', () => {
  let canvas: HTMLCanvasElement | undefined;

  afterEach(() => {
    if (canvas !== undefined && canvas.parentNode !== null) {
      canvas.parentNode.removeChild(canvas);
    }
    canvas = undefined;
    delete (globalThis as unknown as { __learnRenderErrors?: unknown }).__learnRenderErrors;
    delete (globalThis as unknown as { __learnRenderTriangleClearOnly?: unknown })
      .__learnRenderTriangleClearOnly;
    delete (globalThis as unknown as { __learnRenderTriangleDrawCalls?: unknown })
      .__learnRenderTriangleDrawCalls;
    delete (globalThis as unknown as { __learnRenderBootstrapComplete?: unknown })
      .__learnRenderBootstrapComplete;
    delete (globalThis as unknown as { __captureHelloTriangle?: unknown }).__captureHelloTriangle;
  });

  it('bootstraps a non-clear-only triangle and draws', async () => {
    if (typeof navigator.gpu === 'undefined') {
      throw new Error(
        "[learn-render 1.2 hello-triangle.onerror-gate] code: 'webgpu-unavailable'; vitest.config.ts launches chrome-beta with WebGPU flags",
      );
    }
    canvas = document.createElement('canvas');
    canvas.id = 'app';
    canvas.width = 256;
    canvas.height = 256;
    document.body.appendChild(canvas);

    const errors: Array<{ code: string; hint?: string }> = [];
    (globalThis as unknown as { __learnRenderErrors: typeof errors }).__learnRenderErrors = errors;

    await import('../index.ts');

    const bootstrapComplete = (): boolean =>
      (globalThis as unknown as { __learnRenderBootstrapComplete?: boolean })
        .__learnRenderBootstrapComplete === true;
    const hasSutError = (): boolean => errors.some((e) => SUT_ATTRIBUTABLE_CODES.has(e.code));
    for (let elapsed = 0; elapsed < 15000 && !hasSutError() && !bootstrapComplete(); elapsed += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const sutErrors = errors.filter((e) => SUT_ATTRIBUTABLE_CODES.has(e.code));
    if (sutErrors.length === 0 && !bootstrapComplete()) {
      throw new Error(
        '[learn-render 1.2 hello-triangle.onerror-gate] bootstrap inconclusive within 15s ' +
          `(no SUT error, not complete); captured codes=[${errors.map((e) => e.code).join(', ')}] ` +
          '-> runner instability, rerun',
      );
    }

    expect(sutErrors).toEqual([]);
    expect(Reflect.get(globalThis, '__learnRenderBootstrapComplete')).toBe(true);
    expect(Reflect.get(globalThis, '__learnRenderTriangleClearOnly')).toBe(false);
    const drawCalls = Reflect.get(globalThis, '__learnRenderTriangleDrawCalls');
    expect(typeof drawCalls).toBe('function');
    if (typeof drawCalls === 'function') expect(drawCalls()).toBeGreaterThan(0);
  });
});
