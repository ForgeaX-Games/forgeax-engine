// game-default gameplay audio: one loaded spatial SFX and its ECS edge state.

import { AudioSource } from '@forgeax/engine-audio';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AudioClipAsset, Handle } from '@forgeax/engine-types';

/** SSOT: forgeax-engine-assets/sfx/dragon-studio-correct-472358.mp3.meta.json. */
export const HIT_SFX_GUID = '019e7535-5e5e-75fe-a328-0b08e3a72744';

type ClipHandle = Handle<'AudioClipAsset', 'shared'>;
const HANDLE_NONE = 0 as unknown as ClipHandle;

interface AudioRegistry {
  loadByGuid<T>(guid: AssetGuid): Promise<
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string } }
  >;
}

export interface GameplayAudio {
  rearm(): void;
  reset(): void;
  triggerHit(): void;
}

const setSource = (world: World, player: EntityHandle, clip: ClipHandle, playing: boolean): void => {
  const result = world.set(player, AudioSource, {
    clip, playing, loop: false, volume: 0.8, spatialBlend: 1, bus: 'sfx',
  });
  if (!result.ok) console.warn('[game] gameplay AudioSource update failed:', result.error.code, result.error.hint);
};

/** Attach the player source and resolve the clip through the normal GUID path. */
export async function installGameplayAudio(
  world: World,
  player: EntityHandle,
  assets: AudioRegistry | undefined,
): Promise<GameplayAudio> {
  world.addComponent(player, { component: AudioSource, data: { clip: HANDLE_NONE } }).unwrap();
  setSource(world, player, HANDLE_NONE, false);
  let clip = HANDLE_NONE;
  let armed = false;

  if (!assets) {
    console.warn('[game] gameplay SFX unavailable: AssetRegistry is unavailable');
  } else {
    const parsed = AssetGuid.parse(HIT_SFX_GUID);
    if (!parsed.ok) {
      console.error('[game] gameplay SFX unavailable: invalid GUID', HIT_SFX_GUID);
    } else {
      const loaded = await assets.loadByGuid<AudioClipAsset>(parsed.value);
      if (loaded.ok) {
        clip = world.allocSharedRef('AudioClipAsset', loaded.value);
        setSource(world, player, clip, false);
      } else {
        console.warn('[game] gameplay SFX unavailable:', loaded.error.code, loaded.error.hint);
      }
    }
  }

  return {
    rearm() {
      if (!armed) return;
      setSource(world, player, clip, false);
      armed = false;
    },
    reset() {
      setSource(world, player, clip, false);
      armed = false;
    },
    triggerHit() {
      if (clip === HANDLE_NONE) return;
      setSource(world, player, clip, true);
      armed = true;
    },
  };
}
