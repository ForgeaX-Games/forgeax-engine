import { _internal_getRawDevice } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { digestMaterialSourceClosure } from '../../../shader-compiler/src/material/compose';
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

it('preserves the material closure digest in the browser compilation realm', () => {
  expect(digestMaterialSourceClosure({})).toBe(
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  const a = '// accented \u00e9 and unpaired \ud800\nfn a() {}';
  const z = '// emoji \ud83d\ude00\nfn z() {}';
  const expected = 'sha256:673ff555e10e412d082c5a8f5683355b36ec3408b12139c757eecae9ea319339';
  expect(digestMaterialSourceClosure({ 'game::z': z, 'game::a': a })).toBe(expected);
  expect(digestMaterialSourceClosure({ 'game::a': a, 'game::z': z })).toBe(expected);
});
