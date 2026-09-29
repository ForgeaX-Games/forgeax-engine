import { AssetGuid } from '@forgeax/engine-pack/guid';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import type { MaterialAsset, RuntimeAssetBinding } from '@forgeax/engine-types';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyClippingPlanes } from './clipping-planes.fixture';
import { gbufferReplayIdentity, renderValue } from './standard-gbuffer-replay.fixture';

declare module 'vitest/browser' {
  interface BrowserCommands {
    startClippingPlanes(): Promise<{ id: string; binding: RuntimeAssetBinding; guids: string[] }>;
    stopClippingPlanes(id: string): Promise<void>;
  }
}

it('verifies clipping color, depth, shadows and replay through Browser WebGPU', {
  timeout: 180_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const server = await commands.startClippingPlanes();
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        ssrIdentity: gbufferReplayIdentity,
      },
      { importTransport: createDevImportTransport(server.binding) },
    ),
  );
  host.assets.configureRuntimeBinding(server.binding);
  const save = (scope: string) => async (name: string, bytes: Uint8Array) => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    await commands.writeFile(
      `artifacts/clipping-planes/rhi-debug/browser/${scope}/${name}`,
      btoa(binary),
      'base64',
    );
  };
  try {
    await verifyClippingPlanes(host.renderer, recorder, save('view'));
    const materials = await Promise.all(
      server.guids.map(async (guid) =>
        renderValue(
          await host.assets.loadByGuid<MaterialAsset>(renderValue(AssetGuid.parse(guid))),
        ),
      ),
    );
    await verifyClippingPlanes(host.renderer, recorder, save('material'), materials);
  } finally {
    await commands.stopClippingPlanes(server.id);
    renderValue(await host.renderer.dispose());
    canvas.remove();
    (await recorder.dispose()).unwrap();
  }
});
