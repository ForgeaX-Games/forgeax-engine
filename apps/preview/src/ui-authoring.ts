import type { UiAsset } from '@forgeax/engine-ui';
import { type UiAuthoringResult, validateUiAuthoring } from '@forgeax/engine-ui/authoring';
import {
  captureUiPreview,
  createDomPartScenario,
  createUiPreviewSession,
  type UiPreviewAssetSource,
  type UiPreviewCaptureAdapter,
  type UiPreviewScenario,
  type UiPreviewSession,
} from '@forgeax/engine-ui/preview';

export const PREVIEW_UI_GUID = 'ui-preview-default';

const defaultAsset: UiAsset = {
  guid: PREVIEW_UI_GUID,
  html: '<section data-ui-part="root" aria-label="Preview HUD"><strong data-ui-part="score">Score 0</strong><span data-ui-part="stress-meter">Ready</span></section>',
  css: ':host { display: block; color: white; font: 16px sans-serif; } section { padding: 12px; }',
};

export interface UiAuthoringHostHandle {
  readonly guid: string;
  readonly root: HTMLElement;
  readonly discover: () => readonly { readonly guid: string; readonly kind: 'ui' }[];
  readonly validate: (source?: {
    readonly html: string;
    readonly css: string;
  }) => Promise<UiAuthoringResult>;
  readonly open: (scenario?: 'default' | 'extreme') => ReturnType<UiPreviewSession['open']>;
  readonly capture: (adapter: UiPreviewCaptureAdapter) => Promise<UiPreviewCaptureResult>;
  readonly repair: (source: {
    readonly html: string;
    readonly css: string;
  }) => Promise<UiAuthoringResult>;
  readonly dispose: () => void;
  readonly getSession: () => UiPreviewSession | null;
}

export type UiPreviewCaptureResult = Awaited<ReturnType<typeof captureUiPreview>>;

function sourceFrom(asset: UiAsset): UiPreviewAssetSource {
  return {
    invalidate: () => {},
    loadByGuid: async (guid) =>
      guid === asset.guid
        ? { ok: true, value: asset }
        : {
            ok: false,
            error: {
              code: 'invalid-asset',
              expected: 'a registered preview UI asset',
              hint: 'Discover a valid UI GUID before opening preview.',
              detail: { message: `Unknown UI GUID: ${guid}`, asset: guid },
            },
          },
  };
}

export function createUiAuthoringHost(parent: HTMLElement): UiAuthoringHostHandle {
  const root = document.createElement('div');
  root.dataset.uiAuthoringRoot = 'true';
  root.style.position = 'absolute';
  root.style.inset = '0';
  root.style.pointerEvents = 'none';
  parent.append(root);
  let asset = defaultAsset;
  let session: UiPreviewSession | null = null;
  const scenarioFor = (name: 'default' | 'extreme' = 'default'): UiPreviewScenario =>
    createDomPartScenario({
      requiredParts: name === 'extreme' ? ['root', 'score', 'stress-meter'] : ['root', 'score'],
    });
  const validate = async (
    source: Pick<UiAsset, 'html' | 'css'> = asset,
  ): Promise<UiAuthoringResult> =>
    validateUiAuthoring({
      sourcePath: 'ui-preview-default.ui.html',
      html: source.html,
      css: source.css,
    });
  const handle: UiAuthoringHostHandle = {
    guid: PREVIEW_UI_GUID,
    root,
    discover: () => [{ guid: PREVIEW_UI_GUID, kind: 'ui' }],
    validate,
    async repair(source) {
      asset = { ...asset, ...source };
      return validate();
    },
    async open(name = 'default') {
      session?.dispose();
      session = createUiPreviewSession({
        guid: asset.guid,
        assets: sourceFrom(asset),
        root,
        rect: { width: 320, height: 180 },
        scenario: scenarioFor(name),
      });
      return session.open();
    },
    async capture(adapter) {
      if (!session) {
        return {
          ok: false,
          error: {
            code: 'capture-not-ready',
            expected: 'an opened preview session',
            hint: 'Call open() before capture().',
            detail: { message: 'No preview session is open.', unmet: ['session'] },
          },
        };
      }
      return captureUiPreview(session, adapter);
    },
    getSession: () => session,
    dispose() {
      session?.dispose();
      session = null;
      root.replaceChildren();
      root.remove();
    },
  };
  return handle;
}
