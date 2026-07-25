import type { RenderExtract } from '../extract/schema-readers';

export interface PreparedRenderSchemas {
  readonly meshAssetHandle: unknown;
  readonly lightDirection: unknown;
  readonly cameraProjection: number;
  readonly cameraNear: number;
  readonly cameraFar: number;
}

/** Prepare the extracted fields for record without substituting provisional defaults. */
export function prepareRenderSchemas(frame: RenderExtract): PreparedRenderSchemas {
  return {
    meshAssetHandle: frame.mesh.assetHandle,
    lightDirection: frame.light.direction,
    cameraProjection: frame.camera.projection,
    cameraNear: frame.camera.near,
    cameraFar: frame.camera.far,
  };
}
