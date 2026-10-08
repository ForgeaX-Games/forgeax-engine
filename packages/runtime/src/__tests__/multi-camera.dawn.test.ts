import { mkdirSync, writeFileSync } from 'node:fs';
import { RhiError } from '@forgeax/engine-rhi';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { beforeAll, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyMultiCamera } from './multi-camera.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { gbufferReplayIdentity, renderValue } from './standard-gbuffer-replay.fixture';

let manifestUrl = '';
beforeAll(async () => {
  manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
}, 300_000);

it.each([
  'world',
  'publication',
] as const)('renders independent camera views and validates Dawn replay through %s', {
  timeout: 120_000,
}, async (mode) => {
  const size = { width: 128, height: 64 };
  let texture: GPUTexture | undefined;
  const canvas = {
    ...size,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        texture?.destroy();
        texture = config.device.createTexture({
          size: [canvas.width, canvas.height],
          format: config.format,
          usage: 0x11,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      getCurrentTexture: () => texture,
      unconfigure() {},
    }),
  };
  const identity = { source: 'multi-camera', epoch: 1 };
  const recorder = attachRecorder(webgpu).unwrap();
  let rejectSubmit = false;
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        ssrIdentity: gbufferReplayIdentity,
        ...(mode === 'publication' ? { publicationSource: identity } : {}),
        rhiInstrumentation: {
          beforeSubmit: () => {
            if (!rejectSubmit) return undefined;
            rejectSubmit = false;
            return new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'injected submit failure',
              hint: 'retry the same camera frame',
            });
          },
        },
      },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  const directory = `artifacts/multi-camera/${mode === 'world' ? 'dawn' : 'publication-dawn'}`;
  mkdirSync(directory, { recursive: true });
  try {
    await verifyMultiCamera(
      host.renderer,
      recorder,
      (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
      size,
      () => {
        rejectSubmit = true;
      },
      mode === 'publication' ? { assets: host.assets, identity } : undefined,
      process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 16 : 60,
    );
  } finally {
    renderValue(await host.renderer.dispose());
    texture?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
