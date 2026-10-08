import { mkdirSync, writeFileSync } from 'node:fs';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  summarizeFrame,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { constructRuntimeRendererHost } from '../renderer-host';
import { luminancePng, offscreenCanvas } from './hdr-evidence.fixture';
import {
  CHANNEL_SIZE,
  type ChannelReceiver,
  verifyLightingChannels,
} from './lighting-channels.fixture';
import { channelHostLoss } from './lighting-channels-lifecycle.fixture';
import { verifyChannelReplay } from './lighting-channels-replay.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

export async function runChannelDawnCase(
  mode: 'world' | 'publication',
  receiver: ChannelReceiver,
  path: 'forward' | 'deferred' | 'both',
) {
  const paths = path === 'both' ? (['forward', 'deferred'] as const) : [path];
  const target = offscreenCanvas(CHANNEL_SIZE);
  const recorder = attachRecorder(webgpu).unwrap();
  const loss =
    mode === 'publication' && receiver === 'rigid' ? channelHostLoss(recorder) : undefined;
  const identity = { source: 'lighting-channels', epoch: 1 };
  const host = renderValue(
    await constructRuntimeRendererHost(
      target.canvas,
      {
        rhi: recorder.backend.rhi,
        ...(loss === undefined ? {} : { rhiInstrumentation: loss.instrumentation }),
        ...(mode === 'publication' ? { publicationSource: identity } : {}),
      },
      { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    ),
  );
  const directory = `artifacts/lighting-channels/dawn-${mode}-${receiver}`;
  mkdirSync(directory, { recursive: true });
  const devices: GPUDevice[] = [];
  try {
    const samples = await verifyLightingChannels(host.renderer, {
      receiver,
      paths,
      ...(receiver === 'skin' ? { captureLights: ['directional'] as const } : {}),
      ...(mode === 'publication' ? { publication: { assets: host.assets, identity } } : {}),
      recorder,
      ...(loss === undefined ? {} : { recover: () => loss.recover(host.renderer) }),
      async capture(name, tape, image) {
        writeFileSync(`${directory}/${name}.rhitape`, tape.bytes);
        writeFileSync(`${directory}/${name}-live.luminance-f32`, new Uint8Array(image.buffer));
        writeFileSync(`${directory}/${name}.png`, luminancePng(image, CHANNEL_SIZE));
        await verifyChannelReplay(name, tape, image, devices, (file, bytes) =>
          writeFileSync(`${directory}/${file}`, bytes),
        );
        const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
        writeFileSync(
          `${directory}/${name}.json`,
          JSON.stringify({ digest: tape.digest, ...summarizeFrame(model) }, null, 2),
        );
      },
    });
    writeFileSync(`${directory}/${path}-samples.json`, JSON.stringify(samples, null, 2));
  } finally {
    renderValue(await host.renderer.dispose());
    target.destroy();
    (await recorder.dispose()).unwrap();
    for (const device of devices) device.destroy();
  }
}
