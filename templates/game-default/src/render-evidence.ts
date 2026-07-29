import type { EntityHandle } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { HIT_FLASH_SHADER_ID, HIT_FLASH_SHADER_SOURCE } from './hit-flash-material';
import type { GameplayStateHandle, GameplayStateWitness } from './gameplay-state';

export const GAME_DEFAULT_RENDER_EVIDENCE_KEY = '__forgeaxGameDefaultRenderEvidence';

export type GameDefaultRenderEvidence = {
  readonly renderer: Renderer;
  readonly shaderId: string;
  readonly shaderSource: string;
  readonly triggerFlash: () => void;
  readonly hitFlashBlendEnabled: () => boolean;
  readonly bloomEnabled: () => boolean;
  readonly toggleBloom: () => void;
  readonly setViewMode: (mode: 'topdown' | 'orbit' | 'fps') => void;
  readonly reset: () => void;
  readonly state?: Pick<GameplayStateHandle, 'requestReset' | 'requestInvalid'>;
  readonly snapshot: () => {
    readonly activeFlashCount: number;
    readonly hitFlashBlendEnabled: boolean;
    readonly bloomEnabled: boolean;
    readonly viewMode: 'topdown' | 'orbit' | 'fps';
    readonly cameraRadius: number;
    readonly cameraPosition: readonly [number, number, number] | null;
    readonly materialShaderIdentifiers: readonly string[];
    readonly state?: GameplayStateWitness;
  };
};

type RenderEvidenceArgs = {
  readonly renderer: Renderer | undefined;
  readonly flashables: readonly { readonly e: EntityHandle }[];
  readonly triggerFlash: () => void;
  readonly hitFlashBlendEnabled: () => boolean;
  readonly bloomEnabled: () => boolean;
  readonly toggleBloom: () => void;
  readonly viewMode: () => 'topdown' | 'orbit' | 'fps';
  readonly setViewMode: (mode: 'topdown' | 'orbit' | 'fps') => void;
  readonly cameraRadius: () => number;
  readonly cameraPosition: () => readonly [number, number, number] | null;
  readonly isFlashed: (entity: EntityHandle) => boolean;
  readonly reset: () => void;
  readonly state?: GameplayStateHandle;
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
    triggerFlash: args.triggerFlash,
    hitFlashBlendEnabled: args.hitFlashBlendEnabled,
    bloomEnabled: args.bloomEnabled,
    toggleBloom: args.toggleBloom,
    setViewMode: args.setViewMode,
    reset: args.reset,
    ...(args.state ? { state: { requestReset: args.state.requestReset, requestInvalid: args.state.requestInvalid } } : {}),
    snapshot: () => ({
      activeFlashCount: args.flashables.filter((target) => args.isFlashed(target.e)).length,
      hitFlashBlendEnabled: args.hitFlashBlendEnabled(),
      bloomEnabled: args.bloomEnabled(),
      viewMode: args.viewMode(),
      cameraRadius: args.cameraRadius(),
      cameraPosition: args.cameraPosition(),
      materialShaderIdentifiers: [...args.renderer!.shader.materialShaderIdentifiers()],
      ...(args.state ? { state: args.state.snapshot() } : {}),
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
