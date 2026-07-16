import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AudioClipAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioLoader } from '../audio-loader';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const AUDIO_GUID = 'db30f00d-0000-4000-8000-000000000001';
const PACK_INDEX_URL = '/pack-index.json';
const AUDIO_URL = '/audio/test.wav';

describe('audio loadByGuid', () => {
  const originalFetch = globalThis.fetch;
  const originalAudioContext = globalThis.AudioContext;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.AudioContext = originalAudioContext;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads and catalogues an audio GUID through the injected catalog-entry loader', async () => {
    const audioData = new ArrayBuffer(16);
    const buffer = { length: 4, sampleRate: 48_000 } as AudioBuffer;
    const decodeAudioData = vi.fn().mockResolvedValue(buffer);
    const close = vi.fn().mockResolvedValue(undefined);
    const audioContext = vi.fn().mockImplementation(function AudioContextMock() {
      return { decodeAudioData, close } as unknown as AudioContext;
    });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ guid: AUDIO_GUID, relativeUrl: AUDIO_URL, kind: 'audio' }],
        });
      }
      if (url === AUDIO_URL) {
        return Promise.resolve({ ok: true, arrayBuffer: async () => audioData });
      }
      return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    globalThis.AudioContext = audioContext as unknown as typeof AudioContext;

    const registry = new AssetRegistry(makeMockShaderRegistry(), undefined, [audioLoader]);
    registry.configurePackIndex(PACK_INDEX_URL);
    const parsed = AssetGuid.parse(AUDIO_GUID);
    if (!parsed.ok) throw new Error('test GUID must be valid');

    const first = await registry.loadByGuid<AudioClipAsset>(parsed.value);
    const second = await registry.loadByGuid<AudioClipAsset>(parsed.value);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok) throw first.error;
    if (!second.ok) throw second.error;
    expect(first.value).toEqual({ kind: 'audio', buffer });
    expect(second.value).toBe(first.value);
    expect(registry.lookup(parsed.value)).toBe(first.value);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decodeAudioData).toHaveBeenCalledWith(audioData);
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps Web Audio decode failures to an asset parse failure', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ guid: AUDIO_GUID, relativeUrl: AUDIO_URL, kind: 'audio' }],
        });
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    globalThis.AudioContext = vi.fn().mockImplementation(function AudioContextMock() {
      return {
        decodeAudioData: vi.fn().mockRejectedValue(new Error('bad audio')),
        close: vi.fn(),
      } as unknown as AudioContext;
    }) as unknown as typeof AudioContext;

    const registry = new AssetRegistry(makeMockShaderRegistry(), undefined, [audioLoader]);
    registry.configurePackIndex(PACK_INDEX_URL);
    const parsed = AssetGuid.parse(AUDIO_GUID);
    if (!parsed.ok) throw new Error('test GUID must be valid');

    const result = await registry.loadByGuid<AudioClipAsset>(parsed.value);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('asset-parse-failed');
      expect(result.error.hint).toContain('valid wav/mp3/ogg/flac');
    }
  });
});
