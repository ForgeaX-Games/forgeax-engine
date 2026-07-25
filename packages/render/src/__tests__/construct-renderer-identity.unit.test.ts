import * as render from '@forgeax/engine-render';
import { constructRenderer as internalConstructRenderer } from '@forgeax/engine-render/internal/construct-renderer';
import { describe, expect, it } from 'vitest';

describe('construct-renderer internal entry', () => {
  it('keeps construction out of the public barrel', () => {
    expect('constructRenderer' in render).toBe(false);
    expect(internalConstructRenderer).toEqual(expect.any(Function));
  });
});
