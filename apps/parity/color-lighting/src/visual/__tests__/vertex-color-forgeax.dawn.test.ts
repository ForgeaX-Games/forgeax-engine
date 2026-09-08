import { writeFileSync } from 'node:fs';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { runVertexColorProducerEntry, vertexColorProducerIsScheduled } from '../vertex-color-producer-entry';

const VERTEX_COLOR_BATCH_TIMEOUT_MS = 120_000;

it.skipIf(!vertexColorProducerIsScheduled())('runs the ForgeaX Dawn vertex-color producer', () => {
  globalThis.__forgeaxVertexColorPublish = (path, output) => {
    writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
  };
  return buildEngineShaderManifest().then((manifest) => runVertexColorProducerEntry('forgeax', 'dawn', {
    shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`,
  }));
}, VERTEX_COLOR_BATCH_TIMEOUT_MS);
