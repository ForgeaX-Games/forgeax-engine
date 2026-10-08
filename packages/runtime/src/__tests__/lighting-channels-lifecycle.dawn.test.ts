import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { CHANNEL_SIZE } from './lighting-channels.fixture';
import { channelHostLoss, verifyChannelLifecycle } from './lighting-channels-lifecycle.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it('retains channel facts across mutations, World replacement and host recovery', {
  timeout: 300_000,
}, async () => {
  const target = offscreenCanvas(CHANNEL_SIZE);
  const recorder = attachRecorder(webgpu).unwrap();
  const loss = channelHostLoss(recorder);
  const host = renderValue(
    await constructRuntimeRendererHost(
      target.canvas,
      { rhi: recorder.backend.rhi, rhiInstrumentation: loss.instrumentation },
      {
        shaderManifestUrl: shaderManifestUrl(
          await buildEngineShaderManifest({ pointShadows: true }),
        ),
      },
    ),
  );
  const directory = 'artifacts/lighting-channels/dawn-lifecycle';
  mkdirSync(directory, { recursive: true });
  try {
    await verifyChannelLifecycle(host.renderer, recorder, loss, (name, bytes) =>
      writeFileSync(`${directory}/${name}`, bytes),
    );
  } finally {
    renderValue(await host.renderer.dispose());
    target.destroy();
    (await recorder.dispose()).unwrap();
  }
});
