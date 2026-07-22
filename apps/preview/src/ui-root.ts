export interface PreviewUiRun {
  readonly uiRoot: HTMLElement;
  readonly registerCleanup: (fn: () => void) => void;
  readonly cleanup: () => void;
}

export function createPreviewUiRun(parent: HTMLElement): PreviewUiRun {
  const uiRoot = document.createElement('div');
  uiRoot.dataset.forgeaxUiRoot = 'true';
  parent.appendChild(uiRoot);
  const cleanups: Array<() => void> = [];
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (let i = cleanups.length - 1; i >= 0; i -= 1) cleanups[i]?.();
    cleanups.length = 0;
    uiRoot.replaceChildren();
    uiRoot.remove();
  };
  return {
    uiRoot,
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
