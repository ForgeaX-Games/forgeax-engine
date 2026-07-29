import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { Handle, MaterialAsset } from '@forgeax/engine-runtime';

export type AnimatedMaterialTarget = {
  e: EntityHandle;
  mat: Handle<'MaterialAsset', 'shared'>;
  baseHue: number;
  baseColor: readonly [number, number, number, number];
};

export function createAnimatedMaterialTarget(
  world: World,
  source: Omit<AnimatedMaterialTarget, 'baseHue' | 'baseColor'>,
  baseHue: number,
): AnimatedMaterialTarget {
  const result = world.sharedRefs.resolve<'MaterialAsset', MaterialAsset>(source.mat);
  const values = result.ok ? result.value.paramValues as Record<string, unknown> | undefined : undefined;
  const rawColor = values?.baseColor;
  const color: [number, number, number, number] = Array.isArray(rawColor) && rawColor.length === 4
    ? [Number(rawColor[0]), Number(rawColor[1]), Number(rawColor[2]), Number(rawColor[3])]
    : [1, 1, 1, 1];
  return { ...source, baseHue, baseColor: color };
}

function hueToRgb(p: number, q: number, t: number): number {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

function hslToRgb(hue: number): readonly [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 360;
  const saturation = 0.86;
  const lightness = 0.5;
  const q = lightness * (1 + saturation);
  const p = 2 * lightness - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

export function stepAnimatedMaterial(world: World, target: AnimatedMaterialTarget, elapsed: number): void {
  const result = world.sharedRefs.resolve<'MaterialAsset', MaterialAsset>(target.mat);
  if (!result.ok) return;
  const values = result.value.paramValues as Record<string, unknown> | undefined;
  if (values === undefined) return;
  values.baseColor = [...hslToRgb(target.baseHue + elapsed * 38), 1];
}

export function resetAnimatedMaterial(world: World, target: AnimatedMaterialTarget): void {
  const result = world.sharedRefs.resolve<'MaterialAsset', MaterialAsset>(target.mat);
  if (!result.ok) return;
  const values = result.value.paramValues as Record<string, unknown> | undefined;
  if (values !== undefined) values.baseColor = [...target.baseColor];
}
