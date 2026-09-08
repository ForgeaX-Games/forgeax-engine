import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Time, Update, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

describe('callback consumer migration', () => {
  it('registers character-style per-frame work as an Update system reading Time', () => {
    const world = new World();
    let observed = 0;
    world
      .addSystem(Update, {
        name: 'character-drive',
        queries: [],
        fn: () => {
          observed = world.getResource(Time).delta;
        },
      })
      .unwrap();

    world.update(1 / 60).unwrap();
    expect(observed).toBeCloseTo(1 / 60);
  });

  it('uses the receipt-bound renderer host contract', () => {
    const source = [
      readFileSync(resolve(process.cwd(), 'packages/app/src/create-app.ts'), 'utf8'),
      readFileSync(resolve(process.cwd(), 'packages/app/src/internal/frame-loop.ts'), 'utf8'),
    ].join('\n');
    expect(source).toContain('renderer.attach(');
    expect(source).toContain('renderer.draw({');
    expect(source).not.toContain('renderer.ready');
    expect(source).not.toContain('renderer.device');
  });
});
