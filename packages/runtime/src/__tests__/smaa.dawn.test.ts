import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { verifySmaa } from './smaa.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
it('verifies spatial AA, lifecycle and real RHI Debug replay', {
  timeout: 180_000,
  retry: 0,
}, async () => {
  let target: GPUTexture | undefined;
  let configuration: GPUCanvasConfiguration;
  const canvas = {
    width: 128,
    height: 128,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        configuration = options;
      },
      unconfigure() {},
      getCurrentTexture() {
        if (
          target === undefined ||
          target.width !== canvas.width ||
          target.height !== canvas.height
        ) {
          target?.destroy();
          target = configuration.device.createTexture({
            size: [canvas.width, canvas.height],
            format: configuration.format,
            usage: 0x11,
            viewFormats: [
              configuration.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb',
            ],
          });
        }
        return target;
      },
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const result = await constructRuntimeRendererHost(
    canvas,
    { rhi: recorder.backend.rhi },
    { shaderManifestUrl: manifestUrl },
  );
  if (!result.ok) throw result.error;
  const renderer = result.value.renderer;
  const root = 'artifacts/smaa/dawn';
  mkdirSync(root, { recursive: true });
  try {
    await verifySmaa(renderer, recorder, canvas, (name, bytes) => {
      writeFileSync(`${root}/${name}`, bytes);
    });
  } finally {
    await renderer.dispose();
    target?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
