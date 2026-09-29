import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  assertCapsuleShadowEvidence,
  CAPSULE_SHADOW_SIZE,
  verifyCapsuleShadow,
} from './capsule-shadow.fixture';

it('capsule shadows survive the browser manifest and WebGPU validation', {
  timeout: 120_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = CAPSULE_SHADOW_SIZE;
  canvas.height = CAPSULE_SHADOW_SIZE;
  document.body.append(canvas);
  const result = await constructRuntimeRendererHost(canvas);
  if (!result.ok) throw result.error;
  try {
    assertCapsuleShadowEvidence(await verifyCapsuleShadow(result.value.renderer));
  } finally {
    result.value.renderer.dispose();
    canvas.remove();
  }
});
