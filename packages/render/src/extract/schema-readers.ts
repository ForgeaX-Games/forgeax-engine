import type { Camera, DirectionalLight } from '../components';

export interface RenderExtract {
  readonly mesh: { readonly assetHandle: unknown };
  readonly light: { readonly direction: unknown; readonly intensity: number };
  readonly camera: { readonly projection: number; readonly near: number; readonly far: number };
}

/** Project the canonical render component rows without copying or adapting their shape. */
export function readRenderSchemas(
  mesh: Record<string, unknown>,
  light: Record<string, unknown>,
  camera: Record<string, unknown>,
): RenderExtract {
  return {
    mesh: { assetHandle: mesh.assetHandle },
    light: { direction: light.direction, intensity: Number(light.intensity ?? 1) },
    camera: {
      projection: Number(camera.projection ?? 0),
      near: Number(camera.near),
      far: Number(camera.far),
    },
  };
}

export type RenderCameraSchema = typeof Camera;
export type RenderDirectionalLightSchema = typeof DirectionalLight;
