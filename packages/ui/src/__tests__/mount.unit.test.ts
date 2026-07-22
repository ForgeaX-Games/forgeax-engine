import { describe, expect, it, vi } from 'vitest';
import type { UiAsset } from '../asset.js';
import { mountUi } from '../mount.js';

const asset: UiAsset = {
  guid: 'ui-main',
  html: '<button data-ui-action="save">Save</button>',
  css: '.x{}',
};

describe('mountUi lifecycle', () => {
  it('uses an open shadow root, delegates one action, and disposes idempotently', () => {
    const root = document.createElement('div');
    const action = vi.fn();
    const instance = mountUi(asset, { root, layer: 1, onAction: action });
    expect(instance.ok).toBe(true);
    if (!instance.ok) return;
    expect(instance.value.host.shadowRoot).toBeTruthy();
    instance.value.host.shadowRoot
      ?.querySelector('button')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(action).toHaveBeenCalledWith('save', expect.any(Event));
    instance.value.dispose();
    instance.value.dispose();
    expect(root.childElementCount).toBe(0);
  });
  it('does not mutate DOM on invalid input', () => {
    const root = document.createElement('div');
    const result = mountUi(asset, { root, layer: -1 });
    expect(result.ok).toBe(false);
    expect(root.childElementCount).toBe(0);
  });
});
