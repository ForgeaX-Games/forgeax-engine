import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { type CookMeshLightingFixture, verifyVfxMeshLighting } from './vfx-mesh-lighting.fixture';

declare module 'vitest/browser' {
  interface BrowserCommands {
    cookVfxMeshLighting: CookMeshLightingFixture;
  }
}

it('verifies Mesh Point/IBL parity and depth-dependent shadow latency on WebGPU', async () => {
  await verifyVfxMeshLighting({
    shaderManifestUrl: '/shaders/manifest.json',
    cook: commands.cookVfxMeshLighting,
  });
}, 120_000);

it('keeps clustered Mesh/IBL lighting valid with exactly 16 sampled textures', async () => {
  await verifyVfxMeshLighting({
    shaderManifestUrl: '/shaders/manifest.json',
    cook: commands.cookVfxMeshLighting,
    sampledTextureLimit: 16,
  });
}, 120_000);
