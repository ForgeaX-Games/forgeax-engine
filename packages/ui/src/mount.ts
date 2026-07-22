import type { UiAsset, UiInstance } from './asset.js';
import type { UiResult } from './errors.js';
import { uiError } from './errors.js';

export interface MountOptions {
  readonly root: HTMLElement;
  readonly layer: number;
  readonly onAction?: (name: string, event: Event) => void;
}

export function mountUi(asset: UiAsset, options: MountOptions): UiResult<UiInstance> {
  if (typeof document === 'undefined' || typeof AbortController === 'undefined')
    return uiError('invalid-environment', 'DOM APIs are unavailable');
  if (!(options.root instanceof HTMLElement))
    return uiError('invalid-root', 'root is not an HTMLElement');
  if (!Number.isInteger(options.layer) || options.layer < 0)
    return uiError('invalid-layer', 'layer must be non-negative');
  if (!asset?.guid || typeof asset.html !== 'string' || typeof asset.css !== 'string')
    return uiError('invalid-asset', 'asset payload is malformed');
  const host = document.createElement('div');
  host.dataset.uiAsset = asset.guid;
  host.style.position = 'absolute';
  host.style.inset = '0';
  host.style.zIndex = String(options.layer);
  host.style.pointerEvents = 'none';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = asset.css;
  shadow.append(style);
  const content = document.createElement('div');
  content.innerHTML = asset.html;
  content.style.pointerEvents = 'auto';
  shadow.append(content);
  const controller = new AbortController();
  const onClick = (event: Event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-ui-action]')
        : null;
    const action = target?.dataset.uiAction;
    if (action) options.onAction?.(action, event);
  };
  shadow.addEventListener('click', onClick, { signal: controller.signal });
  options.root.append(host);
  let disposed = false;
  return {
    ok: true,
    value: {
      host,
      signal: controller.signal,
      dispose() {
        if (disposed) return;
        disposed = true;
        controller.abort();
        host.remove();
      },
    },
  };
}
