import { describe, expect, it } from 'vitest';
import { createUiRefreshState, enumerateUiDependencyConsumers } from '../import-products.js';

describe('UI full refresh transport state', () => {
  it('replaces the prior instance instead of stacking hosts', () => {
    const state = createUiRefreshState();
    expect(state.replace('ui-guid', 'first')).toEqual({ previous: undefined, current: 'first' });
    expect(state.replace('ui-guid', 'second')).toEqual({ previous: 'first', current: 'second' });
    expect(state.snapshot()).toEqual([['ui-guid', 'second']]);
  });

  it('keeps refresh inventory explicit for all three dependency channels', () => {
    const inventory = enumerateUiDependencyConsumers({
      typescriptImports: ['screen.ui.html'],
      scriptLiterals: ['screen.ui.css'],
      manifestEntries: ['screen.png'],
    });
    expect(inventory.map(({ channel, kind }) => `${channel}:${kind}`)).toEqual([
      'typescript-import:html',
      'script-literal:css',
      'json-pack-manifest:companion',
    ]);
  });
});
