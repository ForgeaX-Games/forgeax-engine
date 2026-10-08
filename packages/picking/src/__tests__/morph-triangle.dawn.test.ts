import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { createBarrelRendererFixture } from '../../../runtime/src/__tests__/barrel-distortion-gpu-fixture';
import { SKIN_PICK_SIZE, verifySkinnedPicking } from './skinned-triangle-gpu.fixture';

it.each([
  'morph',
  'skin-morph',
  'morph-instances',
] as const)('matches current %s triangle picks to Standard GPU pixels and inspects/replays its palette on a fresh Dawn device', {
  timeout: 240_000,
}, async (deformation) => {
  const recorder = attachRecorder(webgpu).unwrap();
  const fixture = await createBarrelRendererFixture({
    width: SKIN_PICK_SIZE,
    height: SKIN_PICK_SIZE,
    rhi: recorder.backend.rhi,
  });
  const directory = `artifacts/morph-triangle-picking/dawn/${deformation}`;
  mkdirSync(directory, { recursive: true });
  try {
    await verifySkinnedPicking(
      fixture.renderer,
      recorder,
      (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
      undefined,
      deformation,
      process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1',
    );
  } finally {
    await fixture.renderer.dispose();
    fixture.renderTarget.destroy();
    (await recorder.dispose()).unwrap();
  }
});
