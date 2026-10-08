import { it } from 'vitest';
import { verifySamplerResidency } from './sampler-residency.gpu-fixture';

it('replaces same-handle sampler filtering while previous bindings stay valid', async () => {
  await verifySamplerResidency();
}, 60_000);
