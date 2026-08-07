import { Camera } from '@forgeax/engine-render';
import type { BootstrapContext } from '@forgeax/engine-app';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { HitFlash } from './components/gameplay';
import { toggleCustomProjectileMesh } from './custom-projectile-mesh';
import { resetFbxMeshSwap } from './fbx-mesh-swap';
import { resetGltfMeshSwap } from './gltf-mesh-swap';
import { resetJpegTextureSwap, toggleJpegTextureSwap } from './jpeg-texture-swap';
import { resetMeshHandleSwap } from './mesh-handle-swap';
import { installGameplayProjection } from './gameplay-projection';
import { installGameplayRenderEvidence } from './gameplay-render-evidence';
import { installFallbackSystems } from './fallback-systems';
import { installGameplaySystems } from './systems/gameplay';
import { installPresentationSystems } from './systems/presentation';
import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import type { GameplaySession } from './gameplay-session';
import type { GameplayTargetFeatures } from './gameplay-targets';
import { GAME_DEFAULT_MATERIAL_ELAPSED_ORIGIN, recordGameplayCommand } from './resources/gameplay';
import { TOP_DOWN_OFFSET_Z, TOP_DOWN_Y } from './camera-controller';

export type GameplayWiringArgs = {
  readonly world: World;
  readonly host: BootstrapContext | undefined;
  readonly assetEvidenceMode: boolean;
  readonly targets: GameplayTargetFeatures;
  readonly session: GameplaySession;
};

/** Register ECS systems and optional inspection bridges after feature assembly. */
export function installGameplayWiring(args: GameplayWiringArgs): void {
  const { world, host, targets, session } = args;
  const { cameraController, projectilePresentation } = session;
  const { camera, topQuaternion, settingsState, depthOfField, chromaticAberration, getMode, setMode, applyPanCamera } = cameraController;
  const { projectileMesh, projectileMaterial, customProjectile, spriteAtlasLoop, flashMaterial, getProjectileVisual, setProjectileVisual, materialsForCurrentMesh, triggerFlash, multiMaterial } = projectilePresentation;
  const toggleProfile = () => {
    const snapshot = targets.toggleProfile();
    cameraController.hud.setTargetProfileActive(snapshot.active === 'profile');
    return snapshot;
  };

  if (host !== undefined) {
    installGameplayProjection({
      host,
      world,
      camera,
      getMode,
      setMode,
      gameplayState: session.gameplayState,
      targetHealth: targets.targetHealth,
      targetDisabling: targets.targetDisabling,
      visibilityLoop: targets.visibilityLoop,
      jpegTextureSwap: targets.jpegTextureSwap,
      videoTexturePanel: targets.videoTexturePanel,
      targetProfile: targets.targetProfile,
      toggleProfile,
      spriteAtlasLoop,
      multiWorldOverlay: session.multiWorldOverlay,
      worldScoreText: session.worldScoreText,
      fbxSkinnedTarget: targets.fbxSkinnedTarget,
      vfxHitLoop: session.vfxHitLoop,
      triggerFlash: () => triggerFlash(),
      triggerScore: session.triggerScore,
      resetMeshHandleSwap: (state) => resetMeshHandleSwap(world, state),
      meshHandleSwap: targets.meshHandleSwap,
      fbxMeshSwap: targets.fbxMeshSwap,
      gltfMeshSwap: targets.gltfMeshSwap,
      resetFbxMeshSwap: (state) => resetFbxMeshSwap(world, state),
      resetGltfMeshSwap: (state) => resetGltfMeshSwap(world, state),
      setProjectileVisual,
      visibilitySnapshot: () => targets.visibilityLoop.snapshot(host.renderer),
    });
  }

  if (targets.player !== undefined) {
    const root = targets.player;
    installGameplaySystems({
      world,
      root,
      camera,
      readInput: session.readInput,
      getMode,
      gameplayAudio: session.gameplayAudio,
      customProjectile,
      getProjectileVisual,
      setProjectileVisual,
      meshHandleSwap: targets.meshHandleSwap,
      fbxMeshSwap: targets.fbxMeshSwap,
      gltfMeshSwap: targets.gltfMeshSwap,
      jpegTextureSwap: targets.jpegTextureSwap,
      videoTexturePanel: targets.videoTexturePanel,
      targetProfile: targets.targetProfile,
      toggleProfile: () => { toggleProfile(); },
      spriteAtlasLoop,
      worldScoreText: session.worldScoreText,
      vfxHitLoop: session.vfxHitLoop,
      toggleCustomProjectileMesh,
      resetMeshHandleSwap: (state) => resetMeshHandleSwap(world, state),
      resetFbxMeshSwap: (state) => resetFbxMeshSwap(world, state),
      resetGltfMeshSwap: (state) => resetGltfMeshSwap(world, state),
      resetJpegTextureSwap: (state) => resetJpegTextureSwap(world, state),
      toggleJpegTextureSwap: (state) => toggleJpegTextureSwap(world, state),
      targetQuery: targets.targetQuery,
      projectileEntities: session.projectileEntities,
      recordCommand: (kind) => recordGameplayCommand(world, kind),
      damageTarget: targets.damageTarget,
      spawnPopup: session.spawnPopup,
      triggerFlash,
      materialsForCurrentMesh,
      changeDetection: session.changeDetection,
      chromaticAberration,
      physics: session.physics,
      projectileMesh,
      projectileMaterial,
      handleQuad: HANDLE_QUAD,
      setPerspectiveFov: (fov) => world.set(camera, Camera, { fov }),
      applyPanCamera,
    });

    installGameplayRenderEvidence({
      host,
      world,
      root,
      camera,
      player: root,
      initX: targets.initX,
      initZ: targets.initZ,
      targetQuery: targets.targetQuery,
      targetEntities: targets.targetEntities,
      triggerFlash,
      triggerScore: () => { session.triggerScore(); },
      flashMaterial,
      settingsState,
      depthOfField,
      chromaticAberration,
      getMode,
      setMode,
      animatedMaterial: targets.animatedMaterial,
      multiMaterial,
      multiWorldOverlay: session.multiWorldOverlay,
      customProjectile,
      getProjectileVisual,
      setProjectileVisual,
      meshHandleSwap: targets.meshHandleSwap,
      fbxMeshSwap: targets.fbxMeshSwap,
      gltfMeshSwap: targets.gltfMeshSwap,
      jpegTextureSwap: targets.jpegTextureSwap,
      videoTexturePanel: targets.videoTexturePanel,
      toggleJpegTexture: () => {
        if (targets.jpegTextureSwap === undefined) return;
        if (targets.jpegTextureSwap.active === 'original') {
          resetMeshHandleSwap(world, targets.meshHandleSwap);
          resetFbxMeshSwap(world, targets.fbxMeshSwap);
          resetGltfMeshSwap(world, targets.gltfMeshSwap);
        }
        toggleJpegTextureSwap(world, targets.jpegTextureSwap);
      },
      fbxSkinnedTarget: targets.fbxSkinnedTarget,
      targetHealth: targets.targetHealth,
      targetDisabling: targets.targetDisabling,
      visibilityLoop: targets.visibilityLoop,
      worldScoreText: session.worldScoreText,
      isFlashed: (entity: EntityHandle) => {
        const flash = world.get(entity, HitFlash);
        return flash.ok && flash.value.remaining > 0;
      },
      reset: session.resetGameplay,
      state: session.gameplayState,
      changeDetection: session.changeDetection,
      input: session.readInput,
    });

    installPresentationSystems({
      world,
      camera,
      debugAxes: session.debugAxes,
      animatedMaterial: targets.animatedMaterial,
      assetEvidenceMode: args.assetEvidenceMode,
      materialElapsedOriginKey: GAME_DEFAULT_MATERIAL_ELAPSED_ORIGIN,
      initX: targets.initX,
      initZ: targets.initZ,
      topDownY: TOP_DOWN_Y,
      topDownOffsetZ: TOP_DOWN_OFFSET_Z,
      topQuaternion,
    });
  }

  installFallbackSystems({ world, camera, player: targets.player, initX: targets.initX, initZ: targets.initZ, getMode, worldScoreText: session.worldScoreText, videoTexturePanel: targets.videoTexturePanel });
}
