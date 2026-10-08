import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { CHANNEL_SIZE } from './lighting-channels.fixture';
import { verifyChannelViews } from './lighting-channels-views.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it.each([
  'world',
  'publication',
] as const)('preserves lighting channels across independent views through %s', {
  timeout: 300_000,
}, async (mode) => {
  const target = offscreenCanvas(CHANNEL_SIZE);
  const recorder = attachRecorder(webgpu).unwrap();
  const identity = { source: 'lighting-channels-dawn-views', epoch: 1 };
  const host = renderValue(
    await constructRuntimeRendererHost(
      target.canvas,
      {
        rhi: recorder.backend.rhi,
        ...(mode === 'publication' ? { publicationSource: identity } : {}),
      },
      {
        shaderManifestUrl: shaderManifestUrl(
          await buildEngineShaderManifest({ pointShadows: true }),
        ),
      },
    ),
  );
  const directory = `artifacts/lighting-channels/dawn-views-${mode}`;
  mkdirSync(directory, { recursive: true });
  try {
    await verifyChannelViews(
      host.renderer,
      recorder,
      (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
      mode === 'publication' ? { assets: host.assets, identity } : undefined,
    );
  } finally {
    renderValue(await host.renderer.dispose());
    target.destroy();
    (await recorder.dispose()).unwrap();
  }
});
