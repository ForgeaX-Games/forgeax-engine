import { describe, expect, it, vi } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';

const PLAY_OPTIONS = {
  loop: false,
  volume: 1,
  spatialBlend: 0,
  bus: 'sfx' as const,
};

async function flushDecode(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('HostAudioConsumer', () => {
  it('decodes each sourceKey once and plays repeated intents from the cache', async () => {
    const engine = new WebAudioEngine();
    const buffer = {} as AudioBuffer;
    const decode = vi.spyOn(engine, 'decode').mockResolvedValue(buffer);
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);

    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'laser',
      bytes: new Uint8Array([1]),
      options: PLAY_OPTIONS,
    });
    consumer.consume({
      kind: 'play',
      entityId: 2,
      sourceKey: 'laser',
      options: PLAY_OPTIONS,
    });
    await flushDecode();

    expect(decode).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('does not start a source whose entity was stopped while decode was pending', async () => {
    const engine = new WebAudioEngine();
    let resolveDecode: ((buffer: AudioBuffer) => void) | undefined;
    vi.spyOn(engine, 'decode').mockReturnValue(
      new Promise((resolve) => {
        resolveDecode = resolve;
      }),
    );
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    vi.spyOn(engine, 'stop').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);

    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'slow',
      bytes: new Uint8Array([1]),
      options: PLAY_OPTIONS,
    });
    consumer.consume({ kind: 'stop', entityId: 1 });
    resolveDecode?.({} as AudioBuffer);
    await flushDecode();

    expect(play).not.toHaveBeenCalled();
  });

  it('reports structured decode failure without throwing into simulation', async () => {
    const engine = new WebAudioEngine();
    vi.spyOn(engine, 'decode').mockRejectedValue(new Error('unsupported codec'));
    const consumer = createHostAudioConsumer(engine);

    expect(() =>
      consumer.consume({
        kind: 'play',
        entityId: 1,
        sourceKey: 'broken',
        bytes: new Uint8Array([0]),
        options: PLAY_OPTIONS,
      }),
    ).not.toThrow();
    await flushDecode();

    const error = consumer.state().lastError;
    expect(error?.code).toBe('decode-failed');
    if (error?.code === 'decode-failed') {
      expect((error.detail as { reason: string }).reason).toContain('unsupported codec');
    }
  });
});
