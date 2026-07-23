import { createUiAuthoringHost, type UiAuthoringHostHandle } from './ui-authoring';

export interface PreviewUiRun {
  readonly uiRoot: HTMLElement;
  readonly registerCleanup: (fn: () => void) => void;
  readonly cleanup: () => void;
  readonly authoring: UiAuthoringHostHandle;
}

export function createPreviewUiRun(parent: HTMLElement): PreviewUiRun {
  const uiRoot = document.createElement('div');
  uiRoot.dataset.forgeaxUiRoot = 'true';
  parent.appendChild(uiRoot);
  const authoring = createUiAuthoringHost(parent);
  (window as Window & { __forgeaxUiAuthoring?: UiAuthoringHostHandle }).__forgeaxUiAuthoring =
    authoring;
  const cleanups: Array<() => void> = [];
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (let i = cleanups.length - 1; i >= 0; i -= 1) cleanups[i]?.();
    cleanups.length = 0;
    authoring.dispose();
    const globalWindow = window as Window & { __forgeaxUiAuthoring?: UiAuthoringHostHandle };
    if (globalWindow.__forgeaxUiAuthoring === authoring) delete globalWindow.__forgeaxUiAuthoring;
    uiRoot.replaceChildren();
    uiRoot.remove();
  };
  return {
    uiRoot,
    authoring,
    registerCleanup: (fn) => {
      if (cleaned) {
        fn();
        return;
      }
      cleanups.push(fn);
    },
    cleanup,
  };
}
