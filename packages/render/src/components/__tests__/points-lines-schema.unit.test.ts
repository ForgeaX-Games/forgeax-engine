import { World } from '@forgeax/engine-ecs';
import type { PointShape } from '@forgeax/engine-render';
import { Lines, PointShapeValue, Points, pointShapeFromU32 } from '@forgeax/engine-render';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('Points and Lines public schema', () => {
  it('creates both components through the public import and inserts them in World', () => {
    const world = new World();
    const pointEntity = world
      .spawn({
        component: Points,
        data: { sizePx: 8, shape: PointShapeValue.circle },
      })
      .unwrap();
    const lineEntity = world.spawn({ component: Lines, data: { widthPx: 4 } }).unwrap();

    expect(world.get(pointEntity, Points).unwrap()).toMatchObject({
      sizePx: 8,
      shape: PointShapeValue.circle,
    });
    expect(world.get(lineEntity, Lines).unwrap()).toMatchObject({ widthPx: 4 });
  });

  it('keeps the frozen defaults and closed point shape decoder', () => {
    const world = new World();
    const pointEntity = world.spawn({ component: Points, data: {} }).unwrap();
    const lineEntity = world.spawn({ component: Lines, data: {} }).unwrap();

    expect(world.get(pointEntity, Points).unwrap()).toMatchObject({
      sizePx: 4,
      shape: PointShapeValue.square,
    });
    expect(world.get(lineEntity, Lines).unwrap().widthPx).toBe(1);
    expect(Points.fields).toEqual({
      sizePx: expect.objectContaining({ type: 'f32', default: 4 }),
      shape: expect.objectContaining({
        type: 'enum',
        default: PointShapeValue.square,
        labels: PointShapeValue,
      }),
    });
    expect(Lines.fields).toEqual({
      widthPx: expect.objectContaining({ type: 'f32', default: 1 }),
    });
    expect(pointShapeFromU32(PointShapeValue.square)).toBe('square');
    expect(pointShapeFromU32(PointShapeValue.circle)).toBe('circle');
    expect(pointShapeFromU32(99)).toBeUndefined();
  });

  it('exposes only the three first-release style fields', () => {
    type PublicPointShape = PointShape;
    expectTypeOf<PublicPointShape>().toEqualTypeOf<'square' | 'circle'>();
    expectTypeOf<keyof typeof Points.fields>().toEqualTypeOf<'sizePx' | 'shape'>();
    expectTypeOf<keyof typeof Lines.fields>().toEqualTypeOf<'widthPx'>();
  });
});
