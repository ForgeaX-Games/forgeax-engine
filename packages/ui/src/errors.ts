import type { ImportDiagnostic } from '@forgeax/engine-types';

export type UiErrorCode =
  | 'invalid-environment'
  | 'invalid-root'
  | 'invalid-asset'
  | 'invalid-layer'
  | 'invalid-preview-rect'
  | 'preview-invalid-transition'
  | 'preview-disposed'
  | 'preview-stale-completion'
  | 'preview-load-failed'
  | 'preview-scenario-failed'
  | 'preview-scenario-missing-part'
  | 'preview-scenario-timeout'
  | 'capture-not-ready'
  | 'capture-failed';
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
    }
  | {
      readonly code: 'invalid-preview-rect';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly rect: string };
    }
  | {
      readonly code: 'preview-invalid-transition' | 'preview-disposed' | 'preview-stale-completion';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly state: string };
    }
  | {
      readonly code: 'preview-load-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly message: string;
        readonly guid: string;
        readonly diagnostics?: readonly ImportDiagnostic[];
      };
    }
  | {
      readonly code: 'preview-scenario-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly scenario: string };
    }
  | {
      readonly code: 'preview-scenario-missing-part';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly part: string };
    }
  | {
      readonly code: 'preview-scenario-timeout';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly timeoutMs: number };
    }
  | {
      readonly code: 'capture-not-ready';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly unmet: readonly string[] };
    }
  | {
      readonly code: 'capture-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly stage: string };
    };
export type UiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: UiError };

function detailFor(code: UiErrorCode, message: string): UiError['detail'] {
  switch (code) {
    case 'invalid-environment':
      return { message, environment: 'browser-like DOM' };
    case 'invalid-root':
      return { message, root: 'HTMLElement' };
    case 'invalid-layer':
      return { message, layer: -1 };
    case 'invalid-preview-rect':
      return { message, rect: 'preview rect' };
    case 'preview-invalid-transition':
    case 'preview-disposed':
    case 'preview-stale-completion':
      return { message, state: 'preview session' };
    case 'preview-load-failed':
      return { message, guid: 'preview GUID' };
    case 'preview-scenario-failed':
      return { message, scenario: 'preview scenario' };
    case 'preview-scenario-missing-part':
      return { message, part: 'required part' };
    case 'preview-scenario-timeout':
      return { message, timeoutMs: 0 };
    case 'capture-not-ready':
      return { message, unmet: [] };
    case 'capture-failed':
      return { message, stage: 'screenshot' };
    case 'invalid-asset':
      return { message, asset: 'UiAsset' };
  }
}

export function uiError(code: UiErrorCode, detail: string): UiResult<never> {
  const expected: Record<UiErrorCode, string> = {
    'invalid-environment': 'a browser-like DOM environment',
    'invalid-root': 'an HTMLElement root owned by the caller',
    'invalid-asset': 'a UiAsset with non-empty guid, html, and css strings',
    'invalid-layer': 'a non-negative integer layer',
    'invalid-preview-rect': 'a finite preview rectangle with positive width and height',
    'preview-invalid-transition': 'a legal preview session state transition',
    'preview-disposed': 'a preview session that has not been disposed',
    'preview-stale-completion': 'the current preview generation',
    'preview-load-failed': 'the preview GUID to load successfully',
    'preview-scenario-failed': 'the scenario prepare hook to complete successfully',
    'preview-scenario-missing-part': 'all parts declared by the scenario',
    'preview-scenario-timeout': 'the scenario to report ready before its timeout',
    'capture-not-ready': 'all capture readiness gates to be satisfied',
    'capture-failed': 'the browser screenshot operation to succeed',
  };
  const hints: Record<UiErrorCode, string> = {
    'invalid-environment': 'Call mountUi in a browser-like DOM environment.',
    'invalid-root': 'Provide an HTMLElement root owned by the caller.',
    'invalid-asset': 'Load a UiAsset with non-empty guid, html, and css strings.',
    'invalid-layer': 'Layer must be a non-negative integer.',
    'invalid-preview-rect': 'Provide finite x/y values and positive width/height.',
    'preview-invalid-transition': 'Call the operation from its documented session state.',
    'preview-disposed': 'Create a new preview session after disposal.',
    'preview-stale-completion': 'Ignore stale async work and await the current generation.',
    'preview-load-failed': 'Repair the imported asset, then call retry().',
    'preview-scenario-failed': 'Fix the scenario prepare hook before retrying.',
    'preview-scenario-missing-part': 'Restore the required data-ui-part element before retrying.',
    'preview-scenario-timeout':
      'Make scenario.prepare resolve ready or increase scenarioTimeoutMs.',
    'capture-not-ready': 'Satisfy every reported readiness fact, then capture again.',
    'capture-failed': 'Inspect the reported capture stage and retry in the same browser.',
  };
  const narrowedDetail = detailFor(code, detail);
  return {
    ok: false,
    error: { code, expected: expected[code], hint: hints[code], detail: narrowedDetail } as UiError,
  };
}

export function uiPreviewLoadFailed(
  message: string,
  guid: string,
  diagnostics?: readonly ImportDiagnostic[],
): UiResult<never> {
  const result = uiError('preview-load-failed', message);
  if (result.ok) return result;
  const baseError = result.error as Extract<UiError, { code: 'preview-load-failed' }>;
  return {
    ok: false,
    error: {
      ...baseError,
      detail: {
        message,
        guid,
        ...(diagnostics === undefined ? {} : { diagnostics }),
      },
    },
  };
}
