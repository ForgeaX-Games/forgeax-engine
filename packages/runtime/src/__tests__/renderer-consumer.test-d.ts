import type { Renderer } from '@forgeax/engine-render/internal';

const consume = (renderer: Renderer): Promise<boolean> =>
  renderer.ready.then((result) => result.ok);
void consume;
