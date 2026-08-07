import { Update, type World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { inState } from '@forgeax/engine-state';
import type { GameplayAudio } from '../gameplay-audio';
import type { CustomProjectileMesh } from '../custom-projectile-mesh';
import type { MeshHandleSwap } from '../mesh-handle-swap';
import type { FbxMeshSwap } from '../fbx-mesh-swap';
import type { GltfMeshSwap } from '../gltf-mesh-swap';
import type { JpegTextureSwap } from '../jpeg-texture-swap';
import type { VideoTexturePanel } from '../video-texture-panel';
import type { TargetProfileLoop } from '../target-profile-loop';
import type { SpriteAtlasLoop } from '../sprite-atlas-loop';
import type { WorldScoreTextHandle } from '../world-score-text';
import { GameState } from '../gameplay-state';
import type { ProjectileVisual } from '../components/gameplay';

export type InputActionsSystemContext = {
  readonly world: World;
  readonly readInput: () => InputSnapshot;
  readonly gameplayAudio: GameplayAudio | undefined;
  readonly customProjectile: CustomProjectileMesh | undefined;
  readonly setProjectileVisual: (visual: ProjectileVisual) => void;
  readonly meshHandleSwap: MeshHandleSwap | undefined;
  readonly fbxMeshSwap: FbxMeshSwap | undefined;
  readonly gltfMeshSwap: GltfMeshSwap | undefined;
  readonly jpegTextureSwap: JpegTextureSwap | undefined;
  readonly videoTexturePanel: VideoTexturePanel | undefined;
  readonly targetProfile: TargetProfileLoop | undefined;
  readonly toggleProfile: () => void;
  readonly spriteAtlasLoop: SpriteAtlasLoop | undefined;
  readonly worldScoreText: WorldScoreTextHandle | undefined;
  readonly toggleCustomProjectileMesh: (state: CustomProjectileMesh) => void;
  readonly resetMeshHandleSwap: (state: MeshHandleSwap | undefined) => void;
  readonly resetFbxMeshSwap: (state: FbxMeshSwap | undefined) => void;
  readonly resetGltfMeshSwap: (state: GltfMeshSwap | undefined) => void;
  readonly resetJpegTextureSwap: (state: JpegTextureSwap | undefined) => void;
  readonly toggleJpegTextureSwap: (state: JpegTextureSwap) => void;
};

/** Maps the frozen InputSnapshot to named feature/plugin actions. */
export function installInputActionsSystem(ctx: InputActionsSystemContext): void {
  ctx.world.addSystem(Update, {
    name: 'game-input-actions',
    runIf: inState(GameState, 'Play'),
    queries: [],
    fn: () => {
      const snap = ctx.readInput();
      ctx.gameplayAudio?.setMusicPlaying(true);
      ctx.gameplayAudio?.rearm();
      if (ctx.customProjectile !== undefined && snap.action('meshUv').justPressed()) ctx.toggleCustomProjectileMesh(ctx.customProjectile);
      if (ctx.jpegTextureSwap !== undefined && snap.action('jpegTexture').justPressed()) {
        if (ctx.jpegTextureSwap.active === 'original') {
          ctx.resetMeshHandleSwap(ctx.meshHandleSwap);
          ctx.resetFbxMeshSwap(ctx.fbxMeshSwap);
          ctx.resetGltfMeshSwap(ctx.gltfMeshSwap);
        }
        ctx.toggleJpegTextureSwap(ctx.jpegTextureSwap);
      }
      if (ctx.videoTexturePanel !== undefined && snap.action('videoTexture').justPressed()) ctx.videoTexturePanel.toggle();
      if (ctx.targetProfile !== undefined && snap.action('targetProfile').justPressed()) ctx.toggleProfile();
      if (ctx.spriteAtlasLoop !== undefined && snap.action('spriteAtlas').justPressed()) {
        if (ctx.spriteAtlasLoop.toggle()) ctx.setProjectileVisual('sprite');
      }
      if (ctx.worldScoreText !== undefined && snap.action('fontSource').justPressed()) ctx.worldScoreText.toggleFontSource();
    },
  }).unwrap();
}
