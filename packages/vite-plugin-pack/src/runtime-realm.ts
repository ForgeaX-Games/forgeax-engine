import type { RuntimeAssetBinding, RuntimeScopeStatus } from '@forgeax/engine-types';

export interface PackRuntimeScope {
  readonly binding: RuntimeAssetBinding;
  readonly roots: readonly string[];
}

/**
 * Small lifecycle owner for the dev pack producer.
 *
 * The catalog implementation has a large amount of importer/finalizer state;
 * keeping the binding and its monotonically increasing token in one object
 * gives every async publication a cheap stale-generation check. A disposed
 * token may finish its filesystem work, but it can never become current again.
 */
export class PackRuntimeRealm {
  private token = 0;
  private current: PackRuntimeScope | undefined;

  beginBind(binding: RuntimeAssetBinding, roots: readonly string[]): number {
    if (!Number.isSafeInteger(binding.generation) || binding.generation < 1) {
      throw new Error('forgeax: runtime generation must be a positive safe integer');
    }
    if (binding.scopeId.trim().length === 0 || binding.gameId.trim().length === 0) {
      throw new Error('forgeax: runtime gameId and scopeId are required');
    }
    this.token += 1;
    this.current = {
      binding: Object.freeze({ ...binding, status: 'transitioning' }),
      roots: Object.freeze([...roots]),
    };
    return this.token;
  }

  publish(
    token: number,
    status: Exclude<RuntimeScopeStatus, 'unbound' | 'transitioning'>,
    authority?: 'authoritative' | 'degraded',
    diagnostics?: RuntimeAssetBinding['diagnostics'],
  ): RuntimeAssetBinding | undefined {
    if (token !== this.token || this.current === undefined) return undefined;
    const next = Object.freeze({
      ...this.current.binding,
      status,
      ...(authority === undefined ? {} : { authority }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    });
    this.current = { ...this.current, binding: next };
    return next;
  }

  snapshot(): PackRuntimeScope | undefined {
    return this.current;
  }

  isCurrent(token: number): boolean {
    return token === this.token && this.current !== undefined;
  }

  matches(scopeId: string, generation: number): boolean {
    return (
      this.current?.binding.scopeId === scopeId && this.current.binding.generation === generation
    );
  }

  clear(): void {
    this.token += 1;
    this.current = undefined;
  }
}
