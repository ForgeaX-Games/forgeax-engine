import { afterEach, expect, it, vi } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';

function silentWav(): Uint8Array {
  const bytes = new Uint8Array(1644);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, 1600, true);
  return bytes;
}

afterEach(() => vi.restoreAllMocks());
it('applies pre-play bus control and latest pending volume through native decoding and gains', async () => {
  const gains = vi.spyOn(AudioContext.prototype, 'createGain');
  const consumer = createHostAudioConsumer();
  try {
    consumer.consume({ kind: 'set-bus-volume', bus: 'sfx', volume: 0.4 });
    consumer.consume({ kind: 'set-bus-mute', bus: 'sfx', muted: true });
    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'silence',
      bytes: silentWav(),
      options: { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' },
    });
    consumer.consume({ kind: 'set-volume', entityId: 1, volume: 0.5 });
    consumer.consume({ kind: 'set-volume', entityId: 1, volume: 0.25 });
    await expect.poll(() => consumer.state().activeSourceCount).toBe(1);
    expect(gains.mock.results[1]?.value.gain.value).toBe(0);
    expect(gains.mock.results[3]?.value.gain.value).toBe(0.25);
    consumer.consume({ kind: 'stop', entityId: 1 });
    expect(consumer.state().activeSourceCount).toBe(0);
  } finally {
    consumer.dispose();
  }
});
