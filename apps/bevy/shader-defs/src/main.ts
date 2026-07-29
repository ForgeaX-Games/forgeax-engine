import { createApp } from '@forgeax/engine-app';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import shaderDefs from './shader-defs.wgsl';

const SHADER_ID = 'bevy::shader_defs';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-shader-defs: missing <canvas id="app">');

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appResult.ok) {
    console.error('[bevy-shader-defs] createApp failed:', appResult.error);
    return;
  }

  const app = appResult.value;
  const shader = app.renderer.shader;
  if (shader === null) {
    console.error('[bevy-shader-defs] renderer.shader is null');
    return;
  }
  if (!shader.lookupMaterialShader(SHADER_ID).ok) {
    shader.registerMaterialShader(SHADER_ID, {
      source: shaderDefs.wgsl,
      paramSchema: [
        { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
        { name: 'time', type: 'f32', default: 0 },
        { name: 'speed', type: 'f32', default: 1 },
        { name: 'baseColorTexture', type: 'texture2d' },
      ],
    });
  }

  const geometry = createBoxGeometry(1, 1, 1);
  if (!geometry.ok) {
    console.error('[bevy-shader-defs] createBoxGeometry failed:', geometry.error);
    return;
  }
  const mesh = app.world.allocSharedRef('MeshAsset', geometry.value);
  const texture = app.world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', {
    kind: 'texture',
    width: 2,
    height: 2,
    format: 'rgba8unorm',
    data: new Uint8Array([
      255, 255, 255, 255,
      255, 255, 255, 255,
      255, 255, 255, 255,
      255, 255, 255, 255,
    ]),
    colorSpace: 'linear',
    mipmap: false,
  });
  const blue = makeMaterial(app.world, [0.05, 0.25, 1], false, texture);
  const greenWithRedDefine = makeMaterial(app.world, [0.05, 1, 0.1], true, texture);

  app.world.spawn(
    { component: Transform, data: { pos: [-0.9, 0, 0] } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [blue] } },
  );
  app.world.spawn(
    { component: Transform, data: { pos: [0.9, 0, 0] } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [greenWithRedDefine] } },
  );
  app.world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: target.width / Math.max(target.height, 1), near: 0.1, far: 100 }) },
  );
  app.world.spawn({
    component: DirectionalLight,
    data: { direction: [0.5, -1, -0.5], color: [1, 1, 1], intensity: 1, castShadow: false },
  });

  app.onError((error) => console.error('[bevy-shader-defs] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) console.error('[bevy-shader-defs] app.start failed:', started.error);
}

function makeMaterial(
  world: import('@forgeax/engine-ecs').World,
  baseColor: readonly [number, number, number],
  isRed: boolean,
  texture: import('@forgeax/engine-types').Handle<'TextureAsset', 'shared'>,
): import('@forgeax/engine-types').Handle<'MaterialAsset', 'shared'> {
  const material: MaterialAsset = {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: SHADER_ID,
        tags: { LightMode: 'Forward' },
        queue: 2000,
        defines: { IS_RED: String(isRed) },
      },
    ],
    paramValues: { baseColor, time: 0, speed: 1, baseColorTexture: texture },
  };
  return world.allocSharedRef('MaterialAsset', material);
}
