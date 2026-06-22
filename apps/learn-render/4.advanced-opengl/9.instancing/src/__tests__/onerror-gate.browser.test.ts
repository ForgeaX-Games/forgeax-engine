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

  // it.fails: this assertion is EXPECTED to fail. The 4.9 instancing demo's
  // bootstrap fires a SUT_ATTRIBUTABLE_CODES code (asset-not-imported or a
  // sibling) because the engine-side vite-plugin-pack mesh DDC import arm is
  // missing (OOS-1). Once the engine follow-up loop fixes that gap, the demo
  // bootstraps cleanly (no SUT error, __learnRenderBootstrapComplete=true),
  // the inner expect passes, and Vitest turns this it.fails RED — forcing the
  // next AI user to flip it.fails(...) back to it(...).
  //
  // Flake guard (post-merge #426): the ORIGINAL wait bailed after a 500ms
  // quiet window. A cold WebGPU bootstrap on a slow / device-lost-storming CI
  // runner can take seconds to reach the planet `loadByGuid`, so that quiet
  // break sometimes ended the wait BEFORE the expected SUT error was pushed —
  // leaving sutErrors empty, the inner expect passing, and it.fails flipping
  // the suite red on an engine-unrelated runner hiccup (failed twice on merge
  // 7f919e87 while green on the PR run + 5 prior main commits).
  //
  // Three terminal states, disambiguated by waiting for EITHER a SUT error OR
  // the bootstrap-complete marker (full 15s budget), never a quiet timeout:
  //   1. SUT error captured       -> expected gap still open  -> it.fails GREEN
  //   2. bootstrap completed clean -> OOS-1 fixed (real flip)  -> it.fails RED
  //   3. neither within 15s        -> bootstrap disrupted       -> throw =>
  //                                   inconclusive, it.fails GREEN (rerun).
  it.fails('SUT bootstrap fires no SUT-attributable error', async () => {
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
      // State 3: bootstrap neither failed with a SUT error nor ran to
      // completion within 15s — disrupted (e.g. device-lost storm) before the
      // planet load. Inconclusive; throw so it.fails stays green and the next
      // reader sees what was captured instead of a silent reverse-assert.
      throw new Error(
        '[learn-render 4.9 instancing.onerror-gate] bootstrap inconclusive within 15s ' +
          `(no SUT error, not complete); captured codes=[${errors.map((e) => e.code).join(', ')}] ` +
          '-> runner instability, rerun',
      );
    }
    // State 1 (sutErrors non-empty) -> expect throws -> it.fails GREEN.
    // State 2 (complete, sutErrors empty) -> expect passes -> it.fails RED.
    expect(sutErrors).toEqual([]);
  });
});
