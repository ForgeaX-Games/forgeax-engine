import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { createBarrelRendererFixture } from '../../../runtime/src/__tests__/barrel-distortion-gpu-fixture';
import { SKIN_PICK_SIZE, verifySkinnedPicking } from './skinned-triangle-gpu.fixture';

it('matches current skin triangle picks to Standard GPU pixels and inspects/replays its palette on a fresh Dawn device', {
  timeout: 240_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const fixture = await createBarrelRendererFixture({
    width: SKIN_PICK_SIZE,
    height: SKIN_PICK_SIZE,
    rhi: recorder.backend.rhi,
  });
  const directory = 'artifacts/skinned-triangle-picking/dawn';
  mkdirSync(directory, { recursive: true });
  try {
    await verifySkinnedPicking(
      fixture.renderer,
      recorder,
      (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
      undefined,
      'skin',
      process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1',
    );
  } finally {
    await fixture.renderer.dispose();
    fixture.renderTarget.destroy();
    (await recorder.dispose()).unwrap();
  }
});
