import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PostProcessParams,
  URP_PIPELINE_ID,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import { quat } from '@forgeax/engine-math';
import type { World } from '@forgeax/engine-ecs';
import fogShader from './fog.wgsl';

export const FOG_POSTPROCESS_ID = 'bevy-fog::distance';
const FOG_PARAMS_BYTES = 16;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 80.0;

export type FogFalloffMode = 'linear' | 'exponential' | 'exponential-squared';

const FOG_MODE_VALUE: Readonly<Record<FogFalloffMode, number>> = {
  linear: 0,
  exponential: 1,
  'exponential-squared': 2,
};

export function packFogParams(mode: FogFalloffMode, startOrDensity: number, end = 20): Uint8Array {
  const bytes = new ArrayBuffer(FOG_PARAMS_BYTES);
  const values = new Float32Array(bytes);
  values[0] = FOG_MODE_VALUE[mode];
  values[1] = startOrDensity;
  values[2] = end;
  values[3] = 0;
  return new Uint8Array(bytes);
}

export interface FogRenderer {
  postProcess: {
    register(
      id: string,
      entry: {
        source: string;
        reads: readonly ({ key: string; sampleType?: 'depth' } | string)[];
        params: { byteSize: number; defaultValue: Uint8Array };
      },
    ): void;
  };
  installPipeline(asset: {
    kind: 'render-pipeline';
    pipelineId: string;
    config: { postEffects: string[] };
  }): { ok: true } | { ok: false; error: { code: string; hint?: string } };
}

export function installFogPostProcess(renderer: FogRenderer, world: World): void {
  const initialParams = packFogParams('linear', 5, 20);
  renderer.postProcess.register(FOG_POSTPROCESS_ID, {
    source: fogShader.wgsl,
    reads: [{ key: 'sceneColor' }, { key: 'depth', sampleType: 'depth' }],
    params: { byteSize: FOG_PARAMS_BYTES, defaultValue: initialParams },
  });

  world.spawn({
    component: PostProcessParams,
    data: { shader: FOG_POSTPROCESS_ID, data: initialParams },
  }).unwrap();

  const installed = renderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: URP_PIPELINE_ID,
    config: { postEffects: [FOG_POSTPROCESS_ID] },
  });
  if (!installed.ok) {
    throw new Error(`bevy-fog: installPipeline failed: ${installed.error.code}`);
  }
}

export function buildFogWorld(world: World, aspect = 16 / 9): void {
  const stone = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.16, 0.13, 0.1, 1], roughness: 1 }),
  );
  const green = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.03, 0.38, 0.03, 1], metallic: 0.5, roughness: 0.05 }),
  );

  for (const [x, z] of [[-1.5, -1.5], [1.5, -1.5], [1.5, 1.5], [-1.5, 1.5]] as const) {
    world.spawn(
      { component: Transform, data: { pos: [x, 1.5, z], scale: [1, 3, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [stone] } },
    ).unwrap();
  }

  world.spawn(
    { component: Transform, data: { pos: [0, 4, 0], scale: [1.75, 1.75, 1.75] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [green] } },
  ).unwrap();

  for (let i = 0; i < 50; i += 1) {
    const halfSize = i / 2 + 3;
    world.spawn(
      {
        component: Transform,
        data: { pos: [0, -i / 2 + 0.25, 0], scale: [2 * halfSize, 0.5, 2 * halfSize] },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [stone] } },
    ).unwrap();
  }

  world.spawn(
    { component: Transform, data: { pos: [4, 8, 4] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 100 } },
  ).unwrap();

  const cameraPosition: [number, number, number] = [8, 8, 0];
  const cameraTarget: [number, number, number] = [0, 0, 0];
  world.spawn(
    {
      component: Transform,
      data: { pos: cameraPosition, quat: quat.fromLookAt(quat.create(), cameraPosition, cameraTarget, [0, 1, 0]) },
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect, near: CAMERA_NEAR, far: CAMERA_FAR }),
        clearColor: [0.25, 0.25, 0.25, 1],
      },
    },
  ).unwrap();
}
