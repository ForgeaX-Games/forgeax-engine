import type { CookProduct, MaterialAsset } from '@forgeax/engine-types';
import { materialCookPublication } from './cook-finalizer.js';

export interface MaterialArtifactSink {
  write(path: string, bytes: Uint8Array): Promise<void>;
}

export async function writeMaterialCookResult(
  sink: MaterialArtifactSink,
  result: CookProduct<MaterialAsset>,
): Promise<void> {
  const publication = materialCookPublication(result);
  if (publication === undefined) {
    throw new Error('material cook result is not owned by a material finalizer');
  }
  await sink.write(publication.artifact.path, publication.artifactBytes);
  await sink.write(`${publication.artifact.path}.record.json`, publication.recordBytes);
  await sink.write(`${publication.artifact.path}.receipt.json`, publication.receiptBytes);
}
