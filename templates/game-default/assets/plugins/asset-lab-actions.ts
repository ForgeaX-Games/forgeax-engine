import type { World } from '@forgeax/engine-ecs';
import type { FbxMeshSwap } from './fbx-mesh-swap';
import { resetFbxMeshSwap } from './fbx-mesh-swap';
import type { GltfMeshSwap } from './gltf-mesh-swap';
import { resetGltfMeshSwap } from './gltf-mesh-swap';
import type { JpegTextureSwap } from './jpeg-texture-swap';
import { toggleJpegTextureSwap } from './jpeg-texture-swap';
import type { MeshHandleSwap } from './mesh-handle-swap';
import { resetMeshHandleSwap } from './mesh-handle-swap';
import type { SpriteAtlasLoop } from './sprite-atlas-loop';
import type { TargetProfileLoop, TargetProfileSnapshot } from './target-profile-loop';
import type { VideoTexturePanel } from './video-texture-panel';
import type { WorldScoreTextHandle } from './world-score-text';
import { GAME_DEFAULT_TARGET_PROFILE_UNLOCK_SCORE } from './resources/gameplay';

/** The five retained format/plugin paths admitted by the M2 guided contract. */
export type AssetLabAction =
  | 'target-profile'
  | 'jpeg-texture'
  | 'video-texture'
  | 'sprite-atlas'
  | 'font-source';

export type AssetLabActionResult = {
  readonly text: string;
  readonly state: 'unavailable' | 'active' | 'restored';
};

export type AssetLabActionContext = {
  readonly world: World;
  readonly meshHandleSwap: MeshHandleSwap | undefined;
  readonly fbxMeshSwap: FbxMeshSwap | undefined;
  readonly gltfMeshSwap: GltfMeshSwap | undefined;
  readonly jpegTextureSwap: JpegTextureSwap | undefined;
  readonly videoTexturePanel: VideoTexturePanel | undefined;
  readonly targetProfile: TargetProfileLoop | undefined;
  readonly readScore: () => number;
  readonly toggleProfile: () => TargetProfileSnapshot;
  readonly spriteAtlasLoop: SpriteAtlasLoop | undefined;
  readonly worldScoreText: WorldScoreTextHandle | undefined;
  readonly setProjectileVisual: (visual: 'mesh' | 'sprite' | 'sprite-lit') => void;
};

function result(name: string, state: AssetLabActionResult['state'], detail?: string): AssetLabActionResult {
  return { state, text: `${name} ${state === 'active' ? 'active' : state === 'restored' ? 'restored' : 'unavailable'}${detail ? ` · ${detail}` : ''}` };
}

/** Apply one guided action from either the frozen keyboard input or the HUD. */
export function applyAssetLabAction(ctx: AssetLabActionContext, action: AssetLabAction): AssetLabActionResult {
  switch (action) {
    case 'target-profile': {
      if (ctx.targetProfile?.active !== 'profile' && ctx.readScore() < GAME_DEFAULT_TARGET_PROFILE_UNLOCK_SCORE) {
        return result('Target profile', 'unavailable', `score ${GAME_DEFAULT_TARGET_PROFILE_UNLOCK_SCORE} required`);
      }
      const snapshot = ctx.toggleProfile();
      if (!snapshot.available) return result('Target profile', 'unavailable');
      return result('Target profile', snapshot.active === 'profile' ? 'active' : 'restored', snapshot.title ?? 'GUID asset');
    }
    case 'jpeg-texture': {
      const swap = ctx.jpegTextureSwap;
      if (swap === undefined) return result('JPEG target texture', 'unavailable');
      if (swap.active === 'original') {
        resetMeshHandleSwap(ctx.world, ctx.meshHandleSwap);
        resetFbxMeshSwap(ctx.world, ctx.fbxMeshSwap);
        resetGltfMeshSwap(ctx.world, ctx.gltfMeshSwap);
      }
      toggleJpegTextureSwap(ctx.world, swap);
      return result('JPEG target texture', swap.active === 'jpeg' ? 'active' : 'restored', swap.name);
    }
    case 'video-texture': {
      const panel = ctx.videoTexturePanel;
      if (panel === undefined) return result('WebM target panel', 'unavailable');
      panel.toggle();
      return result('WebM target panel', panel.active === 'video' ? 'active' : 'restored', panel.snapshot().name ?? 'VideoAsset');
    }
    case 'sprite-atlas': {
      const atlas = ctx.spriteAtlasLoop;
      if (atlas === undefined) return result('PNG atlas projectile', 'unavailable');
      const active = atlas.toggle();
      if (active) ctx.setProjectileVisual('sprite');
      return result('PNG atlas projectile', active ? 'active' : 'restored', active ? 'fire to confirm the four-frame hit' : 'mesh projectile');
    }
    case 'font-source': {
      const scoreText = ctx.worldScoreText;
      if (scoreText === undefined) return result('TTF score text', 'unavailable');
      const source = scoreText.toggleFontSource();
      return result('TTF score text', source === 'ttf-plugin' ? 'active' : 'restored', source === 'ttf-plugin' ? 'imported glyph metrics on next hit' : 'legacy baked font');
  }
}
}
