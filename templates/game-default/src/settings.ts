import { mountUi, type UiAsset, type UiError, type UiInstance } from '@forgeax/engine-ui';

export const SETTINGS_UI_GUID = '019f8354-6386-4387-849d-f2ab4b9622a0';

export interface GameSettingsState { music: number; highContrast: boolean }
export const DEFAULT_GAME_SETTINGS: Readonly<GameSettingsState> = Object.freeze({ music: 70, highContrast: false });
export function createGameSettingsState(): GameSettingsState { return { ...DEFAULT_GAME_SETTINGS }; }
export function applyGameSetting(state: GameSettingsState, name: 'music' | 'highContrast', value: number | boolean): void {
  if (name === 'music' && typeof value === 'number') state.music = Math.max(0, Math.min(100, value));
  if (name === 'highContrast' && typeof value === 'boolean') state.highContrast = value;
}
export function restoreFocus(target: HTMLElement | null, fallback: HTMLElement): void {
  const candidate = target && target.isConnected && !target.hasAttribute('disabled') ? target : fallback;
  candidate.focus();
}
export interface SettingsHandle { readonly instance: UiInstance | null; readonly state: GameSettingsState; readonly error?: UiError; open(): void; close(): void; dispose(): void }

function failedSettings(state: GameSettingsState, error: UiError): SettingsHandle {
  return { instance: null, state, error, open() {}, close() {}, dispose() {} };
}

export function mountSettings(asset: UiAsset | null, root: HTMLElement, state: GameSettingsState, fallbackFocus: HTMLElement, loadError?: UiError): SettingsHandle {
  if (!asset) return failedSettings(state, loadError ?? { code: 'invalid-asset', expected: 'a loaded settings UiAsset', hint: 'Load the settings UI asset before mounting it.', detail: { message: 'Settings asset is missing', asset: 'settings UiAsset' } });
  const mounted = mountUi(asset, { root, layer: 70 });
  if (!mounted.ok) return failedSettings(state, mounted.error);
  const instance = mounted.value;
  const shadow = instance.host.shadowRoot;
  const dialog = shadow?.querySelector<HTMLElement>('[role="dialog"]');
  const panel = shadow?.querySelector<HTMLElement>('[role="document"]');
  if (!shadow || !dialog || !panel) {
    instance.dispose();
    return failedSettings(state, {
      code: 'invalid-asset',
      expected: 'a settings UI containing dialog and document regions',
      hint: 'Check the settings UI asset markup.',
      detail: { message: 'Settings UI is missing required dialog or document region', asset: 'settings dialog/document regions' },
    });
  }
  let previousFocus: HTMLElement | null = null;
  let inertSiblings: Array<{ element: HTMLElement; value: boolean }> = [];
  const focusables = (): HTMLElement[] => [...shadow.querySelectorAll<HTMLElement>('button,input,[tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.hasAttribute('disabled') && !node.hidden);
  const setOpen = (open: boolean): void => {
    dialog.hidden = !open;
    if (open) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      inertSiblings = [...root.children].filter((child): child is HTMLElement => child !== instance.host)
        .map((element) => ({ element, value: element.inert }));
      for (const sibling of inertSiblings) sibling.element.inert = true;
      panel.focus();
    } else {
      for (const sibling of inertSiblings) sibling.element.inert = sibling.value;
      inertSiblings = [];
      restoreFocus(previousFocus, fallbackFocus);
    }
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (dialog.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) { event.preventDefault(); panel.focus(); return; }
    const current = shadow.activeElement as HTMLElement | null;
    const index = current ? items.indexOf(current) : -1;
    const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
    event.preventDefault();
    items[next]?.focus();
  };
  const onInput = (event: Event): void => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const name = input?.dataset.uiSetting;
    if (name === 'music' && input) applyGameSetting(state, 'music', Number(input.value));
    if (name === 'high-contrast' && input) applyGameSetting(state, 'highContrast', input.checked);
  };
  shadow.addEventListener('click', (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-ui-action]') : null;
    if (target?.dataset.uiAction === 'close-settings') setOpen(false);
  }, { signal: instance.signal });
  shadow.addEventListener('keydown', onKeyDown as EventListener, { signal: instance.signal });
  shadow.addEventListener('input', onInput, { signal: instance.signal });
  shadow.addEventListener('change', onInput, { signal: instance.signal });
  setOpen(false);
  const dispose = (): void => {
    setOpen(false);
    instance.dispose();
  };
  return { instance, state, open: () => setOpen(true), close: () => setOpen(false), dispose };
}
