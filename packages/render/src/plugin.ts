import type { Component, World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { Camera } from './components/camera';
import { DirectionalLight } from './components/directional-light';
import { Instances } from './components/instances';
import { Layer } from './components/layer';
import { Lines } from './components/lines';
import { MeshFilter } from './components/mesh-filter';
import { MeshRenderer } from './components/mesh-renderer';
import { PointLight } from './components/point-light';
import { PointLightShadow } from './components/point-light-shadow';
import { Points } from './components/points';
import { PostProcessParams } from './components/post-process-params';
import { SceneInstance } from './components/scene-instance';
import { SkyboxBackground } from './components/skybox-background';
import { Skylight } from './components/skylight';
import { SortKey } from './components/sort-key';
import { SpotLight } from './components/spot-light';
import { SpriteAnimation } from './components/sprite-animation';
import { SpriteInstances } from './components/sprite-instances';
import { SpriteRegionOverride } from './components/sprite-region-override';
import { TileLayer } from './components/tile-layer';
import { Tilemap } from './components/tilemap';
import { Visibility } from './components/visibility';

const RENDER_COMPONENTS: readonly Component[] = [
  Camera,
  DirectionalLight,
  Instances,
  Layer,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  Points,
  Lines,
  PostProcessParams,
  SceneInstance,
  SkyboxBackground,
  Skylight,
  SortKey,
  SpotLight,
  SpriteAnimation,
  SpriteInstances,
  SpriteRegionOverride,
  TileLayer,
  Tilemap,
  Visibility,
];

function registerRenderComponents(world: World): () => void {
  const leases = RENDER_COMPONENTS.map((component) =>
    world.components.register(component).unwrap(),
  );
  return () => {
    for (let index = leases.length - 1; index >= 0; index -= 1) leases[index]?.dispose();
  };
}

/** Install the built-in render ECS vocabulary in one World. */
export function renderComponentsPlugin(): Plugin {
  return {
    name: 'render-components',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => registerRenderComponents(ctx.world), 'render/components');
    },
  };
}
