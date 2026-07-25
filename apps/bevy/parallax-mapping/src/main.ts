import { createApp } from '@forgeax/engine-app';
import { HANDLE_QUAD, type AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import parallaxShader from './parallax.wgsl';

const SHADER_ID = 'bevy::parallax-mapping';
const TEXTURE_GUIDS = {
  diffuse: '019e3969-1d45-744f-8269-e1b1c6e6a8cf',
  normal: '019e3969-1d45-7020-8756-675a0f885532',
  height: '019e3969-1d45-7d3e-9bc8-55fcdc87beab',
} as const;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-parallax-mapping: missing <canvas id="app"> in index.html');

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appResult.ok) {
    console.error('[bevy-parallax-mapping] createApp failed:', appResult.error);
    return;
  }

  const app = appResult.value;
  const renderer = app.renderer;
  const shader = renderer.shader;
  if (shader === null) {
    console.error('[bevy-parallax-mapping] renderer.shader is null');
    return;
  }
  if (!shader.lookupMaterialShader(SHADER_ID).ok) {
    shader.registerMaterialShader(SHADER_ID, {
      source: parallaxShader.wgsl,
      paramSchema: [
        { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
        { name: 'heightScale', type: 'f32', default: 0.1 },
        { name: 'algoMode', type: 'f32', default: 0 },
        { name: 'baseColorTexture', type: 'texture2d' },
        { name: 'normalTexture', type: 'texture2d' },
        { name: 'heightTexture', type: 'texture2d' },
      ],
    });
  }

  renderer.assets.configurePackIndex('/pack-index.json');
  const textureHandles = await loadTextures(app.world, renderer.assets);
  if (textureHandles === null) return;

  const materials = [0, 1, 2].map((algoMode) => {
    const paramValues: Record<string, unknown> = {
      baseColor: [1, 1, 1, 1],
      heightScale: 0.1,
      algoMode,
      baseColorTexture: textureHandles.diffuse,
      normalTexture: textureHandles.normal,
      heightTexture: textureHandles.height,
    };
    return app.world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [{ name: 'Forward', shader: SHADER_ID, tags: { LightMode: 'Forward' } }],
      paramValues,
    });
  });

  const labels = ['basic', 'steep', 'POM'];
  for (let i = 0; i < materials.length; i += 1) {
    app.world.spawn(
      { component: Transform, data: { pos: [(i - 1) * 2.25, 0, 0], scale: [1.85, 1.85, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [materials[i]!] } },
    );
    console.info(`[bevy-parallax-mapping] panel=${labels[i]} heightScale=0.1`);
  }

  const eye: [number, number, number] = [0, 0, 8];
  app.world.spawn({
    component: DirectionalLight,
    data: { direction: [0.5, -0.5, -1], color: [1, 1, 1], intensity: 3, castShadow: false },
  });
  app.world.spawn(
    {
      component: Transform,
      data: { pos: eye, quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: target.width / Math.max(target.height, 1) }) },
  );

  app.onError((error) => console.error('[bevy-parallax-mapping] app error:', error.code, error.hint));
  console.info(`[bevy-parallax-mapping] backend=${renderer.backend}`);
  const started = app.start();
  if (!started.ok) console.error('[bevy-parallax-mapping] app.start failed:', started.error);
}

async function loadTextures(
  world: World,
  assets: AssetRegistry,
): Promise<{ diffuse: number; normal: number; height: number } | null> {
  const diffuseGuid = AssetGuid.parse(TEXTURE_GUIDS.diffuse);
  const normalGuid = AssetGuid.parse(TEXTURE_GUIDS.normal);
  const heightGuid = AssetGuid.parse(TEXTURE_GUIDS.height);
  if (!diffuseGuid.ok || !normalGuid.ok || !heightGuid.ok) {
    console.error('[bevy-parallax-mapping] texture GUID parse failed');
    return null;
  }

  const diffuse = await assets.loadByGuid<TextureAsset>(diffuseGuid.value);
  const normal = await assets.loadByGuid<TextureAsset>(normalGuid.value);
  const height = await assets.loadByGuid<TextureAsset>(heightGuid.value);
  if (!diffuse.ok || !normal.ok || !height.ok) {
    console.error('[bevy-parallax-mapping] texture loading failed');
    return null;
  }

  return {
    diffuse: unwrapHandle(world.allocSharedRef('TextureAsset', diffuse.value)),
    normal: unwrapHandle(world.allocSharedRef('TextureAsset', normal.value)),
    height: unwrapHandle(world.allocSharedRef('TextureAsset', height.value)),
  };
}
