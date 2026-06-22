import { afterEach, describe, expect, it } from 'vitest';

export const SUT_ATTRIBUTABLE_CODES: ReadonlySet<string> = new Set([
  // render-loop / runtime onError surface
  'shader-compile-failed',
  'feature-not-enabled',
  'limit-exceeded',
  'queue-submit-failed',
  'queue-write-buffer-out-of-bounds',
  'render-system-no-camera',
  'render-system-multi-camera',
  'render-system-multi-light',
  'asset-not-registered',
  'hierarchy-broken',
  'material-resolved-empty-passes',
  // Bootstrap-time AssetError codes routed into __learnRenderErrors by
  // the demo SUT itself (added 2026-06-08 after `asset-not-imported`
  // bypassed the gate by being filtered out as not-a-runtime-error).
  // The four-verb redesign (2026-06-06) made `loadByGuid<TextureAsset>`
  // a hard dependency on either build-time `.bin` import or a wired
  // ImportTransport — when neither is in place the runtime fails fast
  // with one of these codes, and a missing bus push from the SUT used
  // to leave the gate green. Demos must mirror their `console.warn` /
  // `console.error` resource-load paths into the bus for this to fire.
  'asset-not-imported',
  'texture-source-not-imported',
  'asset-not-found',
  'asset-fetch-failed',
  'loader-not-registered',
]);

export function onerrorGate(sectionName: string, importSut: () => Promise<unknown>): void {
  describe(`${sectionName} onerror-gate`, () => {
    let canvas: HTMLCanvasElement | undefined;

    afterEach(() => {
      if (canvas !== undefined && canvas.parentNode !== null) {
        canvas.parentNode.removeChild(canvas);
      }
      canvas = undefined;
      delete (globalThis as unknown as { __learnRenderErrors?: unknown }).__learnRenderErrors;
    });

    it('SUT bootstrap fires no SUT-attributable renderer.onError', async () => {
      if (typeof navigator.gpu === 'undefined') {
        throw new Error(
          `[${sectionName}.onerror-gate] code: 'webgpu-unavailable'; vitest.config.ts launches chrome-beta with WebGPU flags`,
        );
      }
      canvas = document.createElement('canvas');
      canvas.id = 'app';
      canvas.width = 256;
      canvas.height = 256;
      document.body.appendChild(canvas);

      const errors: Array<{ code: string; hint?: string }> = [];
      (globalThis as unknown as { __learnRenderErrors: typeof errors }).__learnRenderErrors =
        errors;

      await importSut();
      let prev = -1;
      for (let elapsed = 0; elapsed < 5000; elapsed += 50) {
        await new Promise((r) => setTimeout(r, 50));
        if (errors.length === prev) {
          if (elapsed >= 500) break;
        } else {
          prev = errors.length;
        }
      }

      const sutErrors = errors.filter((e) => SUT_ATTRIBUTABLE_CODES.has(e.code));
      expect(sutErrors).toEqual([]);
    });
  });
}
