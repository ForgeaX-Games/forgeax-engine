import type { EntityHandle } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { HIT_FLASH_SHADER_ID, HIT_FLASH_SHADER_SOURCE } from './hit-flash-material';

export const GAME_DEFAULT_RENDER_EVIDENCE_KEY = '__forgeaxGameDefaultRenderEvidence';

export type GameDefaultRenderEvidence = {
  readonly renderer: Renderer;
  readonly shaderId: string;
  readonly shaderSource: string;
  readonly triggerFlash: () => void;
  readonly reset: () => void;
  readonly snapshot: () => {
    readonly activeFlashCount: number;
    readonly materialShaderIdentifiers: readonly string[];
  };
};

type RenderEvidenceArgs = {
  readonly renderer: Renderer | undefined;
  readonly flashables: readonly { readonly e: EntityHandle }[];
  readonly triggerFlash: () => void;
  readonly isFlashed: (entity: EntityHandle) => boolean;
  readonly reset: () => void;
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
    reset: args.reset,
    snapshot: () => ({
      activeFlashCount: args.flashables.filter((target) => args.isFlashed(target.e)).length,
      materialShaderIdentifiers: [...args.renderer!.shader.materialShaderIdentifiers()],
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
