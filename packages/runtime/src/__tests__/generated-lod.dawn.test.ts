import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import {
  type BarrelRendererFixture,
  createBarrelRendererFixture,
} from './barrel-distortion-gpu-fixture';
import { verifyGeneratedLods } from './generated-lod.fixture';
import { startGeneratedLodServer } from './generated-lod.server';

it('renders generated Mesh LODs through HTTP/Catalog and verifies fresh RHI replay on Dawn', async () => {
  const server = await startGeneratedLodServer();
  const recorder = attachRecorder(webgpu).unwrap();
  let fixture: BarrelRendererFixture | undefined;
  try {
    fixture = await createBarrelRendererFixture({
      width: 128,
      height: 128,
      rhi: recorder.backend.rhi,
    });
    const root = 'artifacts/generated-lod/dawn';
    mkdirSync(root, { recursive: true });
    await verifyGeneratedLods(fixture.renderer, fixture.assets, recorder, server, (name, bytes) => {
      writeFileSync(`${root}/${name}`, bytes);
    });
  } finally {
    await fixture?.renderer.dispose();
    fixture?.renderTarget.destroy();
    (await recorder.dispose()).unwrap();
    await server.close();
  }
}, 600_000);
