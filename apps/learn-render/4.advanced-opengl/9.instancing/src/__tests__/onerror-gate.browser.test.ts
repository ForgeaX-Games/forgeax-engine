import { afterEach, describe, expect, it } from 'vitest';

import { SUT_ATTRIBUTABLE_CODES } from '@forgeax/apps-shared/onerror-gate';

describe('learn-render 4.9 instancing onerror-gate (reverse expectation)', () => {
  let canvas: HTMLCanvasElement | undefined;

  afterEach(() => {
    if (canvas !== undefined && canvas.parentNode !== null) {
      canvas.parentNode.removeChild(canvas);
    }
    canvas = undefined;
    delete (globalThis as unknown as { __learnRenderErrors?: unknown }).__learnRenderErrors;
    delete (globalThis as unknown as { __learnRenderBootstrapComplete?: unknown })
      .__learnRenderBootstrapComplete;
  });

  // OOS-1 gap CLOSED (feat-learn-render-5.9 ssao): the engine-side
  // vite-plugin-pack mesh DDC import arm is now wired in the shared test
  // harness (vitest.config.ts browser project gained the learn-opengl/objects
  // root + `importers: [imageImporter, gltfImporter]`, mirroring each demo's
  // own vite.config). The instancing demo's real `pnpm build` already
  // pre-imports planet/rock mesh+material+scene+texture into pack-index.json
  // (10 entries), so under the shipped path the demo now bootstraps cleanly
  // (no SUT-attributable error, __learnRenderBootstrapComplete=true). Per the
  // prior it.fails contract, this flip from it.fails(...) to it(...) is the
  // expected reaction once the gap closed.
  //
  // Flake guard (post-merge #426): wait for EITHER a SUT error OR the
  // bootstrap-complete marker (full 15s budget), never a quiet timeout, so a
  // slow / device-lost-storming CI runner cannot end the wait before bootstrap
  // resolves.
  it('SUT bootstrap fires no SUT-attributable error', async () => {
    if (typeof navigator.gpu === 'undefined') {
      throw new Error(
        "[learn-render 4.9 instancing.onerror-gate] code: 'webgpu-unavailable'; vitest.config.ts launches chrome-beta with WebGPU flags",
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
      await new Promise((r) => setTimeout(r, 50));
    }

    const sutErrors = errors.filter((e) => SUT_ATTRIBUTABLE_CODES.has(e.code));
    if (sutErrors.length === 0 && !bootstrapComplete()) {
      // Bootstrap neither failed with a SUT error nor ran to completion within
      // 15s — disrupted (e.g. device-lost storm) before the planet load.
      // Inconclusive on a flaky runner; throw with what was captured so the
      // failure is a clear "rerun" signal rather than a silent assert.
      throw new Error(
        '[learn-render 4.9 instancing.onerror-gate] bootstrap inconclusive within 15s ' +
          `(no SUT error, not complete); captured codes=[${errors.map((e) => e.code).join(', ')}] ` +
          '-> runner instability, rerun',
      );
    }
    // Forward assertion (gap closed): bootstrap completed clean -> sutErrors
    // empty -> GREEN. A real regression that reintroduces a SUT-attributable
    // bootstrap error makes this RED.
    expect(sutErrors).toEqual([]);
  });
});
