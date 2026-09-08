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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('HostAudioConsumer', () => {
  it('decodes the complete bytes payload without using mediaType as a decoder selector', async () => {
    const engine = new WebAudioEngine();
    const buffer = {} as AudioBuffer;
    const decode = vi.spyOn(engine, 'decode').mockResolvedValue(buffer);
    vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);

    consumer.consume({
      kind: 'play',
      entityId: 7,
      sourceKey: 'typed',
      bytes: Uint8Array.of(1, 2, 3, 4),
      options: PLAY_OPTIONS,
    });
    await flushDecode();

    expect(decode).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3, 4));
    expect(decode.mock.calls[0]).toHaveLength(1);
  });

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

  it('invalidates stale decode authority when same sourceKey bytes churn', async () => {
    const engine = new WebAudioEngine();
    const decodeA = deferred<AudioBuffer>();
    const decodeB = deferred<AudioBuffer>();
    const decodeC = deferred<AudioBuffer>();
    const decodes = [decodeA, decodeB, decodeC];
    const bufferA = {} as AudioBuffer;
    const bufferC = {} as AudioBuffer;
    const decode = vi.spyOn(engine, 'decode').mockImplementation(() => {
      const next = decodes.shift();
      if (next === undefined) throw new Error('unexpected decode');
      return next.promise;
    });
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);

    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'laser',
      bytes: Uint8Array.of(1, 2, 3),
      options: PLAY_OPTIONS,
    });
    consumer.consume({
      kind: 'play',
      entityId: 2,
      sourceKey: 'laser',
      bytes: Uint8Array.of(1, 2, 4),
      options: PLAY_OPTIONS,
    });

    expect(decode).toHaveBeenNthCalledWith(1, Uint8Array.of(1, 2, 3));
    expect(decode).toHaveBeenNthCalledWith(2, Uint8Array.of(1, 2, 4));

    decodeA.resolve(bufferA);
    await flushDecode();
    expect(play).not.toHaveBeenCalled();

    decodeB.reject(new Error('unsupported replacement bytes'));
    await flushDecode();
    expect(consumer.state().lastError?.code).toBe('decode-failed');

    consumer.consume({
      kind: 'play',
      entityId: 3,
      sourceKey: 'laser',
      bytes: Uint8Array.of(5, 6, 7),
      options: PLAY_OPTIONS,
    });
    expect(decode).toHaveBeenNthCalledWith(3, Uint8Array.of(5, 6, 7));

    decodeC.resolve(bufferC);
    await flushDecode();

    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(3, bufferC, PLAY_OPTIONS);
    expect(consumer.state().lastError).toBeNull();
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

  it('keeps a missing Host publication as a recoverable capability error', () => {
    const consumer = createHostAudioConsumer(new WebAudioEngine());
    consumer.consume({
      kind: 'play',
      entityId: 8,
      sourceKey: 'not-published',
      options: PLAY_OPTIONS,
    });
    const error = consumer.state().lastError;
    expect(error?.code).toBe('decode-failed');
    expect(error?.hint).toContain('source bytes');
    expect(error?.detail).toMatchObject({ code: 'decode-failed' });
  });
});
