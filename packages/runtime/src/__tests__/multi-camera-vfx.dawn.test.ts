import { mkdirSync, writeFileSync } from 'node:fs';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { verifyMultiCameraVfx } from './multi-camera-vfx.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it.each([false, true])('simulates shared VFX and replays two Dawn camera views (publication=%s)', {
  timeout: 180_000,
}, async (publication) => {
  let texture: GPUTexture | undefined;
  const canvas = {
    width: 128,
    height: 64,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        texture?.destroy();
        texture = config.device.createTexture({
          size: [128, 64],
          format: config.format,
          usage: 0x11,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      getCurrentTexture: () => texture,
      unconfigure() {},
    }),
  };
  const directory = `artifacts/multi-camera/${publication ? 'publication-dawn' : 'dawn'}`;
  mkdirSync(directory, { recursive: true });
  try {
    await verifyMultiCameraVfx({
      canvas,
      shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()),
      publication,
      cook: cookParticleCodeEffect,
      save: (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
    });
  } finally {
    texture?.destroy();
  }
});
