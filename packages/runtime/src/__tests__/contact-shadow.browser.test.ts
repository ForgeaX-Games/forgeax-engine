import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  assertContactShadowEvidence,
  CONTACT_SHADOW_SIZE,
  verifyContactShadow,
} from './contact-shadow.fixture';

it('contact shadows survive the browser manifest and WebGPU validation', {
  timeout: 120_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = CONTACT_SHADOW_SIZE;
  canvas.height = CONTACT_SHADOW_SIZE;
  document.body.append(canvas);
  const result = await constructRuntimeRendererHost(canvas);
  if (!result.ok) throw result.error;
  let disposed: Awaited<ReturnType<typeof result.value.renderer.dispose>>;
  try {
    assertContactShadowEvidence(await verifyContactShadow(result.value.renderer));
  } finally {
    try {
      disposed = await result.value.renderer.dispose();
    } finally {
      canvas.remove();
    }
  }
  if (!disposed.ok) throw disposed.error;
});
