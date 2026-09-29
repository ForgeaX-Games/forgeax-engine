import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { startSurfaceMaterialPublicationServer } from './material-publication.server';
import { shaderManifestUrl as createShaderManifestUrl } from './shader-manifest-url.fixture';
import { verifySurfaceMaterialPublication } from './surface-material-publication.fixture';

it('recooks one authored Surface GUID without mixing publication or dynamic schema versions on Dawn', async () => {
  const server = await startSurfaceMaterialPublicationServer();
  try {
    const manifest = await buildEngineShaderManifest();
    const evidence = await verifySurfaceMaterialPublication({
      ...server,
      lane: 'gpu-driven',
      shaderManifestUrl: createShaderManifestUrl(manifest),
    });
    // biome-ignore lint/suspicious/noConsole: receipt-bound publication overlap evidence is the test artifact.
    console.log(
      JSON.stringify({
        kind: 'surface-publication-overlap',
        backend: 'dawn',
        lane: evidence.lane,
        directBaselineFrameId: evidence.directBaselineFrameId,
        ...evidence.overlap,
      }),
    );
  } finally {
    await server.close();
  }
}, 120_000);
