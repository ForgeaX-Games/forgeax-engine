import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, type World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { MeshFilter } from '@forgeax/engine-render';
import { GlyphText } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { FontAsset, Handle } from '@forgeax/engine-types';

/** The shared, license-safe font shipped by forgeax-engine-assets. */
export const GAME_DEFAULT_FONT_GUID = '019eb276-4d96-7f2c-9ecf-5124a020eebb';
const GAME_DEFAULT_FONT_SAMPLER_GUID = '019eb276-4d96-7313-b4f0-f5d55536acd2';
const WORLD_SCORE_FONT_SIZE = 0.024;
const WORLD_SCORE_LIFETIME = 0.9;
const WORLD_SCORE_RISE = 0.7;

export interface WorldScoreTextSnapshot {
  readonly available: boolean;
  readonly baked: boolean;
  readonly active: boolean;
  readonly text: string;
  readonly age: number;
  readonly position: readonly [number, number, number];
}

export interface WorldScoreTextHandle {
  readonly show: (text: string, position: readonly [number, number, number]) => void;
  readonly step: (delta: number, camera: EntityHandle) => void;
  readonly reset: () => void;
  readonly snapshot: () => WorldScoreTextSnapshot;
  readonly dispose: () => void;
}

/**
 * Build one reusable world-space score label from the public FontAsset ->
 * GlyphText path. The label is deliberately pooled: hit feedback changes one
 * authoring component instead of spawning a new mesh every hit.
 */
export async function createWorldScoreText(
  world: World,
  assets: AssetRegistry | undefined,
): Promise<WorldScoreTextHandle | undefined> {
  if (assets === undefined) return undefined;

  const fontGuid = AssetGuid.parse(GAME_DEFAULT_FONT_GUID);
  const samplerGuid = AssetGuid.parse(GAME_DEFAULT_FONT_SAMPLER_GUID);
  if (!fontGuid.ok || !samplerGuid.ok) return undefined;
  assets.catalog(samplerGuid.value, {
    kind: 'sampler',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'nearest',
  });
  const loaded = await assets.loadByGuid<FontAsset>(fontGuid.value);
  if (!loaded.ok) {
    console.warn(`[game] world score text unavailable (${loaded.error.code}): ${loaded.error.hint}`);
    return undefined;
  }

  const fontHandle: Handle<'FontAsset', 'shared'> = world.allocSharedRef('FontAsset', loaded.value);
  const entity = world.spawn(
    { component: Transform, data: { pos: [0, -100, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    // A non-empty seed gives the renderer a resident mesh before the first hit;
    // the label is parked off-world until `show` supplies the real score.
    { component: GlyphText, data: { fontHandle, text: '+0', fontSize: WORLD_SCORE_FONT_SIZE, color: [1, 0.8, 0.2, 1] } },
  ).unwrap();

  let active = false;
  let text = '';
  let age = 0;
  let basePosition: [number, number, number] = [0, -100, 0];
  let disposed = false;

  const clear = (): void => {
    active = false;
    text = '';
    age = 0;
    world.set(entity, GlyphText, { text: '+0' });
    world.set(entity, Transform, { pos: [0, -100, 0] });
  };

  return {
    show: (nextText, position) => {
      if (disposed || nextText.length === 0) return;
      active = true;
      text = nextText;
      age = 0;
      basePosition = [position[0] ?? 0, position[1] ?? 0, position[2] ?? 0];
      world.set(entity, GlyphText, { text: nextText });
      world.set(entity, Transform, { pos: basePosition });
    },
    step: (delta, camera) => {
      if (disposed) return;
      const cameraTransform = world.get(camera, Transform);
      if (cameraTransform.ok) {
        world.set(entity, Transform, {
          quat: [
            cameraTransform.value.quat[0] ?? 0,
            cameraTransform.value.quat[1] ?? 0,
            cameraTransform.value.quat[2] ?? 0,
            cameraTransform.value.quat[3] ?? 1,
          ],
          ...(active ? { pos: [basePosition[0], basePosition[1] + age * WORLD_SCORE_RISE, basePosition[2]] } : {}),
        });
      }
      if (!active) return;
      age += Math.max(0, delta);
      if (age >= WORLD_SCORE_LIFETIME) clear();
    },
    reset: clear,
    snapshot: () => {
      const transform = world.get(entity, Transform);
      return {
        available: !disposed,
        baked: world.get(entity, MeshFilter).ok,
        active,
        text,
        age,
        position: transform.ok
          ? [transform.value.pos[0] ?? 0, transform.value.pos[1] ?? 0, transform.value.pos[2] ?? 0]
          : [0, 0, 0],
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      world.despawn(entity);
      world.sharedRefs.release(fontHandle);
    },
  };
}
