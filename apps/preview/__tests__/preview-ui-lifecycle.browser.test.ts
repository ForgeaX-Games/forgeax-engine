// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { createPreviewUiRun } from '../src/ui-root';

describe('preview UI run lifecycle', () => {
  it('removes the root and runs cleanup in reverse order', () => {
    const parent = document.createElement('main');
    document.body.append(parent);
    const run = createPreviewUiRun(parent);
    const order: string[] = [];
    run.registerCleanup(() => order.push('first'));
    run.registerCleanup(() => order.push('second'));
    run.uiRoot.append(document.createElement('button'));

    run.cleanup();
    run.cleanup();

    expect(order).toEqual(['second', 'first']);
    expect(run.uiRoot.childElementCount).toBe(0);
    expect(parent.querySelector('[data-forgeax-ui-root]')).toBeNull();
    parent.remove();
  });
});
