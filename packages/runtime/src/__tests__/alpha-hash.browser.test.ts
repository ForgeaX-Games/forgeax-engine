import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { ALPHA_HASH_SIZE, verifyAlphaHash } from './alpha-hash.fixture';

it.each([
  'standard',
  'unlit',
  'skin',
] as const)('alpha hash %s survives the browser manifest path', {
  timeout: 180_000,
}, async (kind) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ALPHA_HASH_SIZE;
  document.body.append(canvas);
  const constructed = await constructRuntimeRendererHost(canvas);
  if (!constructed.ok) throw new Error(JSON.stringify(constructed.error));
  const host = constructed.value;
  try {
    await verifyAlphaHash(host.renderer, { kind });
  } finally {
    host.renderer.dispose();
    canvas.remove();
  }
});
