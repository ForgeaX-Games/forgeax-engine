import { _internal_getRawDevice } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { verifyIndependentMaps } from './standard-independent-maps.fixture';

it('reads Standard scalar maps and replays the captured bindings and pixels in Chromium', async () => {
  await verifyIndependentMaps((device) => {
    const raw = _internal_getRawDevice(device);
    const errors: string[] = [];
    raw?.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    return () => {
      raw?.destroy();
      expect(errors).toEqual([]);
    };
  });
}, 60_000);
