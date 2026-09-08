import type { Plugin } from '@forgeax/engine-plugin';
import { Camera, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const gameplay: Plugin = {
  name: 'game-empty',
  inject: ['world'],
  apply(ctx) {
    ctx.effect(() => {
      const camera = ctx.world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          {
            component: Camera,
            data: {
              ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }),
              clearColor: [0.015, 0.02, 0.035, 1],
            },
          },
        )
        .unwrap();
      return () => {
        void ctx.world.despawn(camera);
      };
    });
  },
};

export default gameplay;
