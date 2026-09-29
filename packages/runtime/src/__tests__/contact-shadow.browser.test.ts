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
  try {
    assertContactShadowEvidence(await verifyContactShadow(result.value.renderer));
  } finally {
    result.value.renderer.dispose();
    canvas.remove();
  }
});
