import * as render from '@forgeax/engine-render';
import {
  constructRendererHost as internalConstructRendererHost,
  type RendererHostAssembly,
} from '@forgeax/engine-render/internal/construct-renderer';
import { describe, expect, it } from 'vitest';
import type { RenderError } from '../errors/render';
import type { RenderResult } from '../render-contract';

describe('construct-renderer internal entry', () => {
  it('keeps construction out of the public barrel', () => {
    expect('constructRenderer' in render).toBe(false);
    expect(internalConstructRendererHost).toEqual(expect.any(Function));
  });

  it('freezes the only construct seam as a structured Result factory', () => {
    type Return = ReturnType<typeof internalConstructRendererHost>;
    type Expected = Promise<RenderResult<RendererHostAssembly, RenderError>>;
    // This assertion is intentionally red until construction stops rejecting
    // and returns the narrow Result contract.
    expect(null as unknown as Return satisfies Expected).toBeNull();
  });
});
