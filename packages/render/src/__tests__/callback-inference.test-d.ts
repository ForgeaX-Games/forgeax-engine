import type { Renderer } from '../renderer';

const consume = (renderer: Renderer): Promise<boolean> =>
  renderer.ready.then((result) => result.ok);
void consume;
