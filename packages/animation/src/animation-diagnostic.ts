import type { World } from '@forgeax/engine-ecs';

export type AnimationDiagnosticCode =
  | 'animation-target-missing'
  | 'animation-target-transform-missing'
  | 'animation-target-id-duplicate'
  | 'animation-target-owner-stale'
  | 'animation-channel-missing';

export interface AnimationDiagnosticDetail {
  readonly player: number;
  readonly clip: number;
  readonly channel: number;
  readonly targetId: string;
  readonly reason:
    | 'target-missing'
    | 'transform-missing'
    | 'target-id-duplicate'
    | 'target-stale'
    | 'channel-missing';
  readonly target?: number;
  readonly property?: 'translation' | 'rotation' | 'scale';
}

export interface AnimationDiagnostic {
  readonly code: AnimationDiagnosticCode;
  readonly hint: string;
  readonly detail: Readonly<AnimationDiagnosticDetail>;
}

const warnedKeysByWorld = new WeakMap<World, Set<string>>();

/** @internal */
export function isAnimationDevMode(): boolean {
  const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  if (proc?.env?.NODE_ENV === 'production') return false;
  return Boolean((import.meta as { env?: { DEV?: unknown } }).env?.DEV) || proc !== undefined;
}

export function emitAnimationDiagnostic(world: World, diagnostic: AnimationDiagnostic): void {
  if (!isAnimationDevMode()) return;
  let warned = warnedKeysByWorld.get(world);
  if (warned === undefined) {
    warned = new Set();
    warnedKeysByWorld.set(world, warned);
  }
  const { player, clip, channel, targetId, reason } = diagnostic.detail;
  const key = `${player}|${clip}|${channel}|${targetId}|${reason}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(Object.freeze({ ...diagnostic, detail: Object.freeze({ ...diagnostic.detail }) }));
}

/** @internal */
export function _resetAnimationWarnsForTests(world: World): void {
  warnedKeysByWorld.delete(world);
}
