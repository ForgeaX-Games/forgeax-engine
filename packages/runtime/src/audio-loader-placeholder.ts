// @forgeax/engine-runtime - audio loader placeholder
// (feat-20260603-asset-import-loader-injection M1 / w8, plan-strategy D-3).
//
// D-3 decision: research Finding 2 falsified the requirements assumption that
// audio flows through `AssetRegistry.loadByGuid`. It does not — audio is decoded
// app-side by `loadAudioClipByGuid` (packages/audio-webaudio/src/clip-loader.ts)
// via `AudioContext.decodeAudioData`. M1 is a zero-behaviour-change refactor
// (AC-03), so it does NOT move audio onto the loadByGuid path.
//
// But AC-02 wants `registry.get('audio')` to be non-undefined (audio is part of
// the unified import-entry story that M3's audioImporter completes). So we
// register a PLACEHOLDER whose `load` body is a structured fail-fast — NOT
// `return undefined`. Charter P3 (explicit failure > silent behaviour): if a
// future caller mis-routes an audio GUID into `loadByGuid` before the M3
// unification lands, the structured `err` with a pointed `.hint` tells the AI
// user exactly what happened, instead of a silent `undefined` parse miss. The
// placeholder NEVER calls `loadAudioClipByGuid` — audio's real path is untouched
// in M1.
//
// Lives in its own module (no `asset-registry` import) so both the
// `AssetRegistry` default-registry factory and `wireDefaultLoaders` can include
// it without an import cycle.

import { AssetError, type Loader, type LoaderAsyncResult } from '@forgeax/engine-types';

/**
 * Placeholder audio loader (D-3). Registered so `registry.get('audio')` is
 * non-undefined (AC-02), but its `load` is a structured fail-fast — it does not
 * load audio (audio stays on its app-side path in M1, AC-03).
 */
export const audioLoaderPlaceholder: Loader = {
  kind: 'audio',
  load(): Promise<LoaderAsyncResult> {
    return Promise.resolve({
      ok: false,
      error: new AssetError({
        code: 'loader-not-registered',
        expected: 'audio loaded through its app-side path, not AssetRegistry.loadByGuid',
        hint: 'audio currently loads via the app-side loadAudioClipByGuid (Web Audio decodeAudioData), not loadByGuid; the unified import entry lands with the M3 audioImporter. Do not route audio GUIDs through loadByGuid yet.',
        detail: { kind: 'audio' },
      }),
    });
  },
};
