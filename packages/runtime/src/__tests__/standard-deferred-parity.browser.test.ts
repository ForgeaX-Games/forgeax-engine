import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyStandardDeferredParity } from './standard-deferred-parity.fixture';

it.each([
  false,
  true,
])('preserves Standard lighting through the browser manifest and deferred graph (skin=%s)', {
  timeout: 120_000,
}, async (skinned) => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  document.body.append(canvas);
  const result = await constructRuntimeRendererHost(canvas);
  if (!result.ok) throw result.error;
  const host = result.value;
  try {
    await verifyStandardDeferredParity(host.renderer, { skinned });
  } finally {
    host.renderer.dispose();
    canvas.remove();
  }
});
