// plugin-inspector.test.ts — integration test for registerPluginInspector
// (feat-20260623-plugin-system-unify-build-world-protocol M4 / w19,
//  AC-09: inspector exposes plugin list as machine-readable {name}[]).
//
// Test cases:
//   - registerPluginInspector with 5-entry Map -> 'plugins' returns
//     [{name:'transform'}, {name:'time'}, ..., {name:'input'}] (length >= 5)
//   - Empty Map -> returns []
//   - Duplicate method name -> err('console-startup-failed')
//   - wireDefaultInspectors with registerPluginInspector injector ->
//     full chain passes, registry has 'plugins' method

import type { RegisterRootResult } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { InspectorError } from '../errors';
import { registerPluginInspector } from '../register-plugin-inspector';
import {
  type WireDefaultInspectorsContext,
  wireDefaultInspectors,
} from '../wire-default-inspectors';

/** Minimal stub that satisfies the Registry interface for unit tests. */
class FakeRegistry {
  private readonly methods = new Map<string, (...args: unknown[]) => unknown>();
  registerRoot(_name: string, _root: unknown): RegisterRootResult {
    return { ok: true, value: undefined };
  }

  registerMethod(method: string, handler: (...args: unknown[]) => unknown): RegisterRootResult {
    if (this.methods.has(method)) {
      return {
        ok: false,
        error: new InspectorError({
          code: 'console-startup-failed',
          expected: `method '${method}' registered once`,
          hint: `the inspector method '${method}' was already registered; create a new Registry() to retry`,
        }),
      };
    }
    this.methods.set(method, handler);
    return { ok: true, value: undefined };
  }

  lookupRoot(_name: string): unknown {
    return undefined;
  }

  lookupMethod(method: string): ((...args: unknown[]) => unknown) | undefined {
    return this.methods.get(method);
  }

  registerMutatingMethods(_names: ReadonlySet<string>): RegisterRootResult {
    return { ok: true, value: undefined };
  }

  lookupMutatingMethods(): ReadonlySet<string> {
    return new Set();
  }
}

/**
 * Build a Map<string, *> simulating the plugin registry produced by
 * runPlugins(). The values are opaque objects carrying { name } — the
 * inspector only reads keys() and never accesses the values.
 */
function makePluginRegistry(names: readonly string[]): Map<string, { name: string }> {
  const m = new Map<string, { name: string }>();
  for (const n of names) {
    m.set(n, { name: n });
  }
  return m;
}

describe('registerPluginInspector', () => {
  it('registers the "plugins" method and returns [] for an empty registry', () => {
    const reg = new FakeRegistry();
    const empty = new Map<string, unknown>();

    const r = registerPluginInspector(reg, empty);
    expect(r.ok).toBe(true);

    const handler = reg.lookupMethod('plugins');
    expect(handler).toBeDefined();
    const result = handler?.();
    expect(result).toEqual([]);
  });

  it('returns {name:string}[] for a 5-entry registry', () => {
    const reg = new FakeRegistry();
    const registry = makePluginRegistry(['transform', 'time', 'animation', 'state', 'input']);

    const r = registerPluginInspector(reg, registry);
    expect(r.ok).toBe(true);

    const handler = reg.lookupMethod('plugins');
    expect(handler).toBeDefined();
    const result = handler?.() as { name: string }[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(5);
    for (const entry of result) {
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
    }
    // Verify each expected name is present
    const names = result.map((e) => e.name);
    expect(names).toContain('transform');
    expect(names).toContain('time');
    expect(names).toContain('animation');
    expect(names).toContain('state');
    expect(names).toContain('input');
  });

  it('returns err on duplicate method name registration', () => {
    const reg = new FakeRegistry();
    const registry = makePluginRegistry(['transform']);

    // First registration succeeds
    const r1 = registerPluginInspector(reg, registry);
    expect(r1.ok).toBe(true);

    // Second registration with the same method name fails
    const r2 = registerPluginInspector(reg, registry);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.code).toBe('console-startup-failed');
    }
  });

  it('handles a registry with a single entry', () => {
    const reg = new FakeRegistry();
    const registry = makePluginRegistry(['physics']);

    const r = registerPluginInspector(reg, registry);
    expect(r.ok).toBe(true);

    const handler = reg.lookupMethod('plugins');
    expect(handler).toBeDefined();
    const result = handler?.() as { name: string }[];
    expect(result).toEqual([{ name: 'physics' }]);
  });
});

describe('wireDefaultInspectors with registerPluginInspector injector', () => {
  function makeStubInjectors() {
    return {
      registerEcsInspector(_reg: FakeRegistry, _world: unknown): RegisterRootResult {
        return { ok: true, value: undefined };
      },
      registerRuntimeInspector(_reg: FakeRegistry, _engine: unknown): RegisterRootResult {
        return { ok: true, value: undefined };
      },
      registerPluginInspector(reg: FakeRegistry, pluginRegistry: unknown): RegisterRootResult {
        // Use the real implementation
        const r = registerPluginInspector(reg, pluginRegistry);
        return r;
      },
    };
  }

  it('full chain passes and registry has "plugins" method', () => {
    const reg = new FakeRegistry();
    const registry = makePluginRegistry(['transform', 'time', 'animation', 'state', 'audio']);
    const ctx: WireDefaultInspectorsContext = {
      world: null,
      engine: null,
      assets: null,
      pluginRegistry: registry,
    };
    const injectors = makeStubInjectors();

    const r = wireDefaultInspectors(reg, ctx, injectors);
    expect(r.ok).toBe(true);

    // Verify 'plugins' method is registered
    const handler = reg.lookupMethod('plugins');
    expect(handler).toBeDefined();
    const result = handler?.() as { name: string }[];
    expect(result.length).toBeGreaterThanOrEqual(5);
    const names = result.map((e) => e.name);
    expect(names).toContain('audio');
  });

  it('still passes when pluginRegistry is omitted from context', () => {
    const reg = new FakeRegistry();
    const ctx: WireDefaultInspectorsContext = {
      world: null,
      engine: null,
      assets: null,
      // pluginRegistry intentionally omitted
    };
    // Use an injector that does NOT provide registerPluginInspector
    const injectors = {
      registerEcsInspector(_reg: FakeRegistry, _world: unknown): RegisterRootResult {
        return { ok: true, value: undefined };
      },
      registerRuntimeInspector(_reg: FakeRegistry, _engine: unknown): RegisterRootResult {
        return { ok: true, value: undefined };
      },
    };

    const r = wireDefaultInspectors(reg, ctx, injectors);
    expect(r.ok).toBe(true);

    // 'plugins' method was NOT registered (injector absent)
    expect(reg.lookupMethod('plugins')).toBeUndefined();
  });
});
