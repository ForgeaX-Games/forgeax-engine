export type UiErrorCode =
  | 'invalid-environment'
  | 'invalid-root'
  | 'invalid-asset'
  | 'invalid-layer';
export type UiError =
  | {
      readonly code: 'invalid-environment';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly environment: string };
    }
  | {
      readonly code: 'invalid-root';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly root: string };
    }
  | {
      readonly code: 'invalid-asset';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly asset: string };
    }
  | {
      readonly code: 'invalid-layer';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly layer: number };
    };
export type UiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: UiError };

export function uiError(code: UiErrorCode, detail: string): UiResult<never> {
  const expected: Record<UiErrorCode, string> = {
    'invalid-environment': 'a browser-like DOM environment',
    'invalid-root': 'an HTMLElement root owned by the caller',
    'invalid-asset': 'a UiAsset with non-empty guid, html, and css strings',
    'invalid-layer': 'a non-negative integer layer',
  };
  const hints: Record<UiErrorCode, string> = {
    'invalid-environment': 'Call mountUi in a browser-like DOM environment.',
    'invalid-root': 'Provide an HTMLElement root owned by the caller.',
    'invalid-asset': 'Load a UiAsset with non-empty guid, html, and css strings.',
    'invalid-layer': 'Layer must be a non-negative integer.',
  };
  const narrowedDetail =
    code === 'invalid-environment'
      ? { message: detail, environment: 'browser-like DOM' }
      : code === 'invalid-root'
        ? { message: detail, root: 'HTMLElement' }
        : code === 'invalid-layer'
          ? { message: detail, layer: -1 }
          : { message: detail, asset: 'UiAsset' };
  return {
    ok: false,
    error: { code, expected: expected[code], hint: hints[code], detail: narrowedDetail } as UiError,
  };
}
