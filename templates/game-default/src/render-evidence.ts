import type { EntityHandle } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import type { InputSnapshot } from '@forgeax/engine-input';
import { HIT_FLASH_SHADER_ID, HIT_FLASH_SHADER_SOURCE } from './hit-flash-material';
import { ANIMATED_TARGET_SHADER_ID, ANIMATED_TARGET_SHADER_SOURCE, animatedShaderEnabled, animatedShaderTime, type AnimatedMaterialTarget } from './animated-target-material';
import type { GameplayStateHandle, GameplayStateWitness } from './gameplay-state';
import type { GameplayChangeDetectionHandle, GameplayChangeDetectionWitness } from './change-detection';
import type { TargetHealthWitness } from './target-health';
import type { TargetDisablingWitness } from './target-disabling';
import type { DepthOfFieldHandle, DepthOfFieldSnapshot } from './depth-of-field';
import type { ChromaticAberrationHandle, ChromaticAberrationSnapshot } from './chromatic-aberration';

export const GAME_DEFAULT_RENDER_EVIDENCE_KEY = '__forgeaxGameDefaultRenderEvidence';

export type GameDefaultRenderEvidence = {
  readonly renderer: Renderer;
  readonly shaderId: string;
  readonly shaderSource: string;
  readonly animatedShaderId: string;
  readonly animatedShaderSource: string;
  readonly triggerFlash: () => void;
  readonly triggerScore: () => void;
  readonly hitFlashBlendEnabled: () => boolean;
  readonly bloomEnabled: () => boolean;
  readonly toggleBloom: () => void;
  readonly depthOfFieldEnabled: () => boolean;
  readonly toggleDepthOfField: () => void;
  readonly chromaticAberration: () => ChromaticAberrationSnapshot;
  readonly toggleCustomProjectileMesh?: () => void;
  readonly toggleMeshHandleSwap?: () => void;
  readonly gamepad: () => GamepadEvidence;
  readonly setViewMode: (mode: 'topdown' | 'orbit' | 'fps' | 'pan') => void;
  readonly reset: () => void;
  readonly state?: Pick<GameplayStateHandle, 'requestReset' | 'requestInvalid'>;
  readonly snapshot: () => {
    readonly activeFlashCount: number;
    readonly hitFlashBlendEnabled: boolean;
    readonly bloomEnabled: boolean;
    readonly depthOfField: DepthOfFieldSnapshot;
    readonly chromaticAberration: ChromaticAberrationSnapshot;
    readonly viewMode: 'topdown' | 'orbit' | 'fps' | 'pan';
    readonly cameraProjection: 'perspective' | 'orthographic';
    readonly cameraPerspectiveFov: number;
    readonly cameraOrthoHalfHeight: number;
    readonly cameraRadius: number;
    readonly cameraPosition: readonly [number, number, number] | null;
    readonly animatedShaderEnabled: boolean;
    readonly animatedShaderTime: number;
    readonly clearcoatMaterial: { readonly enabled: boolean; readonly strength: number; readonly roughness: number } | null;
    readonly deferredCommands: { readonly spawned: number; readonly despawned: number };
    readonly customProjectileMesh: { readonly available: boolean; readonly uvMode: 'upper' | 'lower'; readonly toggles: number };
    readonly meshHandleSwap: { readonly available: boolean; readonly active: 'original' | 'alternate'; readonly swaps: number };
    readonly gamepad: GamepadEvidence;
    readonly targetHealth: TargetHealthWitness;
    readonly targetDisabling: TargetDisablingWitness;
    readonly materialShaderIdentifiers: readonly string[];
    readonly state?: GameplayStateWitness;
    readonly changeDetection?: GameplayChangeDetectionWitness;
  };
};

export type GamepadEvidence = {
  readonly connected: boolean;
  readonly standardMapping: boolean;
  readonly southHeld: boolean;
  readonly southJustPressed: boolean;
  readonly southJustReleased: boolean;
  readonly rightTrigger: number;
  readonly leftStick: readonly [number, number];
};

function readGamepadEvidence(input?: () => InputSnapshot): GamepadEvidence {
  const pad = input?.().gamepad(0);
  if (pad === undefined) return { connected: false, standardMapping: false, southHeld: false, southJustPressed: false, southJustReleased: false, rightTrigger: 0, leftStick: [0, 0] };
  return {
    connected: pad.connected,
    standardMapping: pad.standardMapping,
    southHeld: pad.button(0),
    southJustPressed: pad.justPressed(0),
    southJustReleased: pad.justReleased(0),
    rightTrigger: pad.buttonValue(7),
    leftStick: [pad.axis(0), pad.axis(1)],
  };
}

type RenderEvidenceArgs = {
  readonly renderer: Renderer | undefined;
  readonly flashables: readonly { readonly e: EntityHandle }[];
  readonly triggerFlash: () => void;
  readonly triggerScore: () => void;
  readonly hitFlashBlendEnabled: () => boolean;
  readonly bloomEnabled: () => boolean;
  readonly toggleBloom: () => void;
  readonly depthOfField?: DepthOfFieldHandle;
  readonly chromaticAberration?: ChromaticAberrationHandle;
  readonly customProjectileMesh?: () => { readonly available: boolean; readonly uvMode: 'upper' | 'lower'; readonly toggles: number };
  readonly toggleCustomProjectileMesh?: () => void;
  readonly meshHandleSwap?: () => { readonly active: 'original' | 'alternate'; readonly swaps: number };
  readonly toggleMeshHandleSwap?: () => void;
  readonly input?: () => InputSnapshot;
  readonly viewMode: () => 'topdown' | 'orbit' | 'fps' | 'pan';
  readonly setViewMode: (mode: 'topdown' | 'orbit' | 'fps' | 'pan') => void;
  readonly cameraProjection: () => 'perspective' | 'orthographic';
  readonly cameraPerspectiveFov: () => number;
  readonly cameraOrthoHalfHeight: () => number;
  readonly cameraRadius: () => number;
  readonly cameraPosition: () => readonly [number, number, number] | null;
  readonly animatedMaterial?: AnimatedMaterialTarget;
  readonly clearcoatMaterial?: () => { readonly enabled: boolean; readonly strength: number; readonly roughness: number } | null;
  readonly deferredCommands?: () => { readonly spawned: number; readonly despawned: number };
  readonly targetHealth?: () => TargetHealthWitness;
  readonly targetDisabling?: () => TargetDisablingWitness;
  readonly isFlashed: (entity: EntityHandle) => boolean;
  readonly reset: () => void;
  readonly state?: GameplayStateHandle;
  readonly changeDetection?: GameplayChangeDetectionHandle;
  readonly registerCleanup?: (cleanup: () => void) => void;
};

/** Install a query-gated, disposable browser witness for the render-evidence smoke. */
export function installRenderEvidence(args: RenderEvidenceArgs): void {
  if (args.renderer === undefined || typeof location === 'undefined') return;
  if (!new URLSearchParams(location.search).has('render-evidence')) return;

  const evidence: GameDefaultRenderEvidence = {
    renderer: args.renderer,
    shaderId: HIT_FLASH_SHADER_ID,
    shaderSource: HIT_FLASH_SHADER_SOURCE,
    animatedShaderId: ANIMATED_TARGET_SHADER_ID,
    animatedShaderSource: ANIMATED_TARGET_SHADER_SOURCE,
    triggerFlash: args.triggerFlash,
    triggerScore: args.triggerScore,
    hitFlashBlendEnabled: args.hitFlashBlendEnabled,
    bloomEnabled: args.bloomEnabled,
    toggleBloom: args.toggleBloom,
    depthOfFieldEnabled: () => args.depthOfField?.snapshot().enabled ?? false,
    toggleDepthOfField: () => args.depthOfField?.setEnabled(!(args.depthOfField?.snapshot().enabled ?? false)),
    chromaticAberration: () => args.chromaticAberration?.snapshot() ?? { active: false, intensity: 0, effect: 'unavailable' },
    ...(args.toggleCustomProjectileMesh ? { toggleCustomProjectileMesh: args.toggleCustomProjectileMesh } : {}),
    ...(args.toggleMeshHandleSwap ? { toggleMeshHandleSwap: args.toggleMeshHandleSwap } : {}),
    gamepad: () => readGamepadEvidence(args.input),
    setViewMode: args.setViewMode,
    reset: args.reset,
    ...(args.state ? { state: { requestReset: args.state.requestReset, requestInvalid: args.state.requestInvalid } } : {}),
    snapshot: () => ({
      activeFlashCount: args.flashables.filter((target) => args.isFlashed(target.e)).length,
      hitFlashBlendEnabled: args.hitFlashBlendEnabled(),
      bloomEnabled: args.bloomEnabled(),
      depthOfField: args.depthOfField?.snapshot() ?? { enabled: false, mode: 'off', focalDistance: 0, aperture: 0, effect: 'unavailable' },
      chromaticAberration: args.chromaticAberration?.snapshot() ?? { active: false, intensity: 0, effect: 'unavailable' },
      viewMode: args.viewMode(),
      cameraProjection: args.cameraProjection(),
      cameraPerspectiveFov: args.cameraPerspectiveFov(),
      cameraOrthoHalfHeight: args.cameraOrthoHalfHeight(),
      cameraRadius: args.cameraRadius(),
      cameraPosition: args.cameraPosition(),
      animatedShaderEnabled: animatedShaderEnabled(args.animatedMaterial),
      animatedShaderTime: animatedShaderTime(args.animatedMaterial),
      clearcoatMaterial: args.clearcoatMaterial?.() ?? null,
      deferredCommands: args.deferredCommands?.() ?? { spawned: 0, despawned: 0 },
      customProjectileMesh: args.customProjectileMesh?.() ?? { available: false, uvMode: 'upper', toggles: 0 },
      meshHandleSwap: args.meshHandleSwap?.() === undefined
        ? { available: false, active: 'original', swaps: 0 }
        : { available: true, ...args.meshHandleSwap()! },
      gamepad: readGamepadEvidence(args.input),
      targetHealth: args.targetHealth?.() ?? { contiguousSupported: false, contiguousCalls: 0, rows: 0, lengthsEqual: true, totalCurrent: 0, totalMax: 0, damageEvents: 0 },
      targetDisabling: args.targetDisabling?.() ?? { activeCount: 0, disabledCount: 0, disableEvents: 0 },
      materialShaderIdentifiers: [...args.renderer!.shader.materialShaderIdentifiers()],
      ...(args.state ? { state: args.state.snapshot() } : {}),
      ...(args.changeDetection ? { changeDetection: args.changeDetection.snapshot() } : {}),
    }),
  };
  const host = globalThis as unknown as Record<string, unknown>;
  host[GAME_DEFAULT_RENDER_EVIDENCE_KEY] = evidence;
  args.registerCleanup?.(() => {
    if (host[GAME_DEFAULT_RENDER_EVIDENCE_KEY] === evidence) {
      delete host[GAME_DEFAULT_RENDER_EVIDENCE_KEY];
    }
  });
}
