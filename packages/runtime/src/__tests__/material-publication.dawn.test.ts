import { writeFileSync } from 'node:fs';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { verifyMaterialPublication } from './material-publication.fixture';
import { startMaterialPublicationServer } from './material-publication.server';
import { shaderManifestUrl as createShaderManifestUrl } from './shader-manifest-url.fixture';

it('loads independent material programs through real Vite transport and rebuilds raw WGSL on Dawn', async () => {
  const server = await startMaterialPublicationServer();
  try {
    const manifest = await buildEngineShaderManifest();
    await verifyMaterialPublication({
      ...server,
      shaderManifestUrl: createShaderManifestUrl(manifest),
      ...(process.env.FORGEAX_MATERIAL_TAPE === undefined
        ? {}
        : {
            saveTape: (bytes: Uint8Array) =>
              writeFileSync(process.env.FORGEAX_MATERIAL_TAPE as string, bytes),
          }),
    });
  } finally {
    await server.close();
  }
}, 120_000);
