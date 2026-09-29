import { mkdirSync, writeFileSync } from 'node:fs';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { verifyMaterialMrt } from './material-mrt.fixture';
import { startMaterialMrtServer } from './material-mrt.server';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it('captures and replays every public material MRT attachment on Dawn', async () => {
  const server = await startMaterialMrtServer();
  const directory = 'artifacts/material-mrt/dawn';
  mkdirSync(directory, { recursive: true });
  try {
    await verifyMaterialMrt({
      ...server,
      shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()),
      save: (name, bytes) => {
        writeFileSync(`${directory}/${name}`, bytes);
      },
    });
  } finally {
    await server.close();
  }
}, 120_000);
