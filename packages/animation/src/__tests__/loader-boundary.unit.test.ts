import { animationGraphLoader } from '@forgeax/engine-assets-runtime';
import { expect, it } from 'vitest';

it('keeps graph payload decoding in assets-runtime', () => {
  expect(animationGraphLoader.kind).toBe('animation-graph');
});
