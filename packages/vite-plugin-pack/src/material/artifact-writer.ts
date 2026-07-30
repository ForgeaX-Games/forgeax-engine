import type { MaterialCookResult } from './cook-finalizer.js';

export interface MaterialArtifactSink {
  write(path: string, bytes: Uint8Array): Promise<void>;
}

export async function writeMaterialCookResult(
  sink: MaterialArtifactSink,
  result: MaterialCookResult,
): Promise<void> {
  await sink.write(result.artifact.path, result.artifactBytes);
  await sink.write(`${result.artifact.path}.record.json`, result.recordBytes);
  await sink.write(`${result.artifact.path}.receipt.json`, result.receiptBytes);
}
