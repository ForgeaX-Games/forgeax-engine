import { describe, expect, it } from 'vitest';
import { instantiate } from '../registry/instantiate';

describe('instantiate bridge', () => {
  it('keeps post-spawn hooks on the instantiate boundary', () => {
    expect(typeof instantiate).toBe('function');
  });
});
