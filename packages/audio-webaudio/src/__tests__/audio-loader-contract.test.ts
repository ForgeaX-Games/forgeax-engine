import { describe, expect, it } from 'vitest';
import { audioLoader } from '../audio-loader';

describe('audio Pack v2 loader contract', () => {
  it('requires asset-local source input instead of a catalog URL row', async () => {
    const result = (await audioLoader.load(
      {
        guid: 'audio-guid',
        kind: 'audio',
        payload: { kind: 'audio' },
        refs: [],
        artifacts: {
          source: {
            descriptor: { path: 'audio.ogg', mediaType: 'audio/ogg' },
            bytes: Uint8Array.of(1, 2),
          },
        },
      } as never,
      {} as never,
      {} as never,
    )) as {
      readonly ok: boolean;
      readonly error?: unknown;
    };
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });
});
