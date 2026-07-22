import { describe, expect, it } from 'vitest';
import { createUiRefreshState } from '../import-products.js';

describe('UI full refresh transport state', () => {
  it('replaces the prior instance instead of stacking hosts', () => {
    const state = createUiRefreshState();
    expect(state.replace('ui-guid', 'first')).toEqual({ previous: undefined, current: 'first' });
    expect(state.replace('ui-guid', 'second')).toEqual({ previous: 'first', current: 'second' });
    expect(state.snapshot()).toEqual([['ui-guid', 'second']]);
  });
});
