import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import {
  gbufferReplayIdentity,
  renderValue,
  verifyStandardGBufferReplay,
} from './standard-gbuffer-replay.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
it('replays real packed GBuffer, HDR accumulation, SSAO and SSR on fresh Dawn devices', {
  timeout: 120_000,
}, async () => {
  let target: GPUTexture | undefined;
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        target?.destroy();
        target = options.device.createTexture({
          size: [64, 64],
          format: options.format,
          usage: 0x11,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      { rhi: recorder.backend.rhi, ssrIdentity: gbufferReplayIdentity },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  const directory = 'artifacts/ue-gbuffer-verification/rhi-debug/dawn';
  mkdirSync(directory, { recursive: true });
  try {
    await verifyStandardGBufferReplay(host.renderer, recorder, (name, bytes) => {
      writeFileSync(`${directory}/${name}`, bytes);
    });
  } finally {
    renderValue(await host.renderer.dispose());
    target?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
