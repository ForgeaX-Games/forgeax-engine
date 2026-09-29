import { SkyboxBackground, Skylight, TONEMAP_ACES_FILMIC } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, standard } from '../../lab/stage';
import { proceduralEquirect } from './support/scene';

export default defineFeature({
  title: 'Cubemap Skybox',
  catalog: 'Cubemap Skybox',
  kind: 'visual',
  summary:
    'SkyboxBackground shares the Skylight equirect handle and draws it as a full-screen cubemap background before scene geometry.',
  expect:
    'ON: the background is the procedural sky: blue above, a white horizon band, orange below. OFF: the SkyboxBackground entity is despawned; the sphere keeps its IBL lighting but the background falls back to the camera clear color.',
  setup({ world }) {
    spawnCamera(world, {
      eye: [0, 0, 4],
      target: [0, 0, 0],
      data: { tonemap: TONEMAP_ACES_FILMIC },
    });
    const equirect = world.allocSharedRef('EquirectAsset', proceduralEquirect());
    world.spawn({ component: Skylight, data: { equirect, intensity: 1 } as never }).unwrap();
    spawnMesh(
      world,
      MESH.sphere,
      standard(world, { baseColor: [1, 1, 1, 1], metallic: 1, roughness: 0.1 }),
      { pos: [0, 0, 0], scale: [0.6, 0.6, 0.6] },
    );
    let skybox = world.spawn({ component: SkyboxBackground, data: { equirect } as never }).unwrap();
    return {
      toggle(on) {
        if (on)
          skybox = world
            .spawn({ component: SkyboxBackground, data: { equirect } as never })
            .unwrap();
        else world.despawn(skybox).unwrap();
      },
    };
  },
});
