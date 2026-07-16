import { loadAudioClipByGuid } from '@forgeax/engine-audio-webaudio';
import { AssetError, type Loader, type LoaderAsyncResult } from '@forgeax/engine-types';

interface AudioCatalogEntry {
  readonly guidKey: string;
  readonly relativeUrl: string;
}

export const audioLoader: Loader = {
  kind: 'audio',
  fromCatalogEntry: true,
  async load(payload): Promise<LoaderAsyncResult> {
    const entry = payload as unknown as AudioCatalogEntry;
    const result = await loadAudioClipByGuid(entry.guidKey, entry.relativeUrl);
    if (result.ok) return result;
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: `a decodable audio asset at ${entry.relativeUrl}`,
        hint: result.error.hint,
        detail: { sourcePath: entry.relativeUrl },
      }),
    };
  },
};
