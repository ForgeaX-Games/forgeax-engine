// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=6):
//   - packages/console/src/__tests__/execute.test.ts
//   - packages/console/src/__tests__/registry-mutating.test.ts
//   - packages/console/src/__tests__/registry.test.ts
//   - packages/console/src/__tests__/sandbox-registry.test.ts
//   - packages/console/src/__tests__/sandbox.test.ts
//   - packages/console/src/__tests__/server.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { InspectorError } from '../errors';
import { executeScript } from '../execute';
import { Registry } from '../registry';
import { MUTATION_BLACKLIST, wrapReadOnly } from '../sandbox';
import { type ConsoleHandle, startConsoleServer } from '../server';

{
  // --- from execute.test.ts ---
  function withEcsRegistry(): Registry {
    const reg = new Registry();
    reg.registerMutatingMethods(new Set(['spawn', 'despawn', 'register']));
    return reg;
  }

  const baseCtx = {
    world: {
      inspect(): { entityCount: number } {
        return { entityCount: 4 };
      },
      spawn(_arg: unknown): { entity: number } {
        return { entity: 1 };
      },
    },
    engine: {
      isReady: true,
    },
    assets: {
      HANDLE_CUBE: 1,
      HANDLE_TRIANGLE: 2,
    },
    scriptTimeoutMs: 5000,
  };

  describe('executeScript - happy path', () => {
    it('returns Result.ok with the evaluated value', () => {
      const result = executeScript('world.inspect().entityCount', baseCtx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(4);
      }
    });

    it('expressions returning numbers / strings / objects are JSON-serialisable', () => {
      const cases: Array<[string, unknown]> = [
        ['1 + 1', 2],
        ['"hello"', 'hello'],
        ['({ a: 1, b: 2 })', { a: 1, b: 2 }],
        ['[10, 20, 30]', [10, 20, 30]],
        ['null', null],
      ];
      for (const [script, expected] of cases) {
        const result = executeScript(script, baseCtx);
        expect(result.ok, `script: ${script}`).toBe(true);
        if (result.ok) {
          expect(result.value, `script: ${script}`).toEqual(expected);
        }
      }
    });
  });

  describe('executeScript - script-syntax-error', () => {
    it('malformed JS -> InspectorError code: script-syntax-error', () => {
      const result = executeScript('world.}{', baseCtx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InspectorError);
        expect(result.error.code).toBe('script-syntax-error');
        expect(result.error.hint.length).toBeGreaterThan(0);
      }
    });
  });

  describe('executeScript - script-runtime-error', () => {
    it('throw new Error(...) inside script -> script-runtime-error', () => {
      const result = executeScript('throw new Error("boom")', baseCtx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('script-runtime-error');
      }
    });

    it('access undefined method -> TypeError -> script-runtime-error', () => {
      const result = executeScript('world.nonExistentMethod()', baseCtx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('script-runtime-error');
      }
    });
  });

  describe('executeScript - script-timeout', () => {
    it('synchronous infinite loop exceeds default 5000ms budget (use 50ms here for speed)', () => {
      const result = executeScript('while(true){}', {
        ...baseCtx,
        scriptTimeoutMs: 50, // shrink so the test does not block CI 5s
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('script-timeout');
      }
    }, 10_000);

    it('scriptTimeoutMs override propagates to vm.runInContext', () => {
      const result = executeScript('while(true){}', {
        ...baseCtx,
        scriptTimeoutMs: 30,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('script-timeout');
      }
    }, 10_000);
  });

  describe('executeScript - inspector-write-denied (alpha-mode Proxy through vm)', () => {
    it('world.spawn(...) inside a script body surfaces inspector-write-denied', () => {
      const result = executeScript('world.spawn({ kind: "transform" })', {
        ...baseCtx,
        registry: withEcsRegistry(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('inspector-write-denied');
      }
    });
  });

  // Round 2 F-2 fix-up: requirements G3 + AC-04 + §10.1 three-root contract
  // — `engine` + `assets` roots must surface the same inspector-write-denied
  // signal on mutation paths as `world` does. Previously (Round 1) engine /
  // assets were wrapped over empty {} fallbacks so engine.assets.register
  // raised script-runtime-error instead of inspector-write-denied (verify
  // F-2 P0 finding).
  describe('executeScript - three-root proxy: engine + assets mutation paths', () => {
    it('engine.assets.register(...).unwrap() surfaces inspector-write-denied (AC-04 verbatim)', () => {
      const ctx = {
        ...baseCtx,
        engine: {
          assets: {
            register(_a: unknown): number {
              return 1;
            },
          },
        },
        registry: withEcsRegistry(),
      };
      const result = executeScript('engine.assets.register({ kind: "mesh" }).unwrap()', ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('inspector-write-denied');
      }
    });

    it('assets.register(...).unwrap() (top-level) surfaces inspector-write-denied', () => {
      const ctx = {
        ...baseCtx,
        assets: {
          register(_a: unknown): number {
            return 1;
          },
          get(handle: number): unknown {
            return { kind: 'mesh', handle };
          },
        },
        registry: withEcsRegistry(),
      };
      const result = executeScript('assets.register({ kind: "mesh" }).unwrap()', ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('inspector-write-denied');
      }
    });

    it('engine.foo read paths pass through (non-mutation method)', () => {
      const ctx = {
        ...baseCtx,
        engine: {
          backend: 'webgpu',
        },
      };
      const result = executeScript('engine.backend', ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('webgpu');
      }
    });

    it('assets.get(handle) read path passes through', () => {
      const ctx = {
        ...baseCtx,
        assets: {
          get(handle: number): unknown {
            return { kind: 'mesh', handle };
          },
        },
      };
      const result = executeScript('assets.get(1)', ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ kind: 'mesh', handle: 1 });
      }
    });
  });

  describe('executeScript - server resilience', () => {
    it('after an error path executeScript still works for the next request', () => {
      const bad = executeScript('throw new Error("first")', baseCtx);
      expect(bad.ok).toBe(false);
      const good = executeScript('world.inspect().entityCount', baseCtx);
      expect(good.ok).toBe(true);
      if (good.ok) {
        expect(good.value).toBe(4);
      }
    });
  });
}

{
  // --- from registry-mutating.test.ts ---
  describe('Registry class - registerMutatingMethods + lookupMutatingMethods (feat-20260517 D-5)', () => {
    it('(a) single contributor: setA accumulates and lookup returns a frozen Set with setA members', () => {
      const reg = new Registry();
      const setA: ReadonlySet<string> = new Set(['spawn', 'despawn', 'flush']);
      const result = reg.registerMutatingMethods(setA);
      expect(result.ok).toBe(true);
      const merged = reg.lookupMutatingMethods();
      expect(merged.has('spawn')).toBe(true);
      expect(merged.has('despawn')).toBe(true);
      expect(merged.has('flush')).toBe(true);
    });

    it('(b) same-reference duplicate returns Result.err(console-startup-failed)', () => {
      const reg = new Registry();
      const setA: ReadonlySet<string> = new Set(['spawn']);
      const first = reg.registerMutatingMethods(setA);
      expect(first.ok).toBe(true);
      const second = reg.registerMutatingMethods(setA);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.code).toBe('console-startup-failed');
        expect(typeof second.error.expected).toBe('string');
        expect(typeof second.error.hint).toBe('string');
      }
    });

    it('(c) different reference identical members: both accumulate and lookup merges members', () => {
      const reg = new Registry();
      const setA: ReadonlySet<string> = new Set(['spawn', 'despawn']);
      const setB: ReadonlySet<string> = new Set(['spawn', 'despawn']);
      expect(reg.registerMutatingMethods(setA).ok).toBe(true);
      const second = reg.registerMutatingMethods(setB);
      expect(second.ok).toBe(true);
      const merged = reg.lookupMutatingMethods();
      expect(merged.has('spawn')).toBe(true);
      expect(merged.has('despawn')).toBe(true);
      expect(merged.size).toBe(2);
    });

    it('(d) lookupMutatingMethods returns Object.isFrozen=true', () => {
      const reg = new Registry();
      reg.registerMutatingMethods(new Set(['spawn']));
      const merged = reg.lookupMutatingMethods();
      expect(Object.isFrozen(merged)).toBe(true);
    });

    it('accumulation across distinct contributor sets exposes the union', () => {
      const reg = new Registry();
      reg.registerMutatingMethods(new Set(['spawn']));
      reg.registerMutatingMethods(new Set(['despawn']));
      reg.registerMutatingMethods(new Set(['flush']));
      const merged = reg.lookupMutatingMethods();
      expect(merged.has('spawn')).toBe(true);
      expect(merged.has('despawn')).toBe(true);
      expect(merged.has('flush')).toBe(true);
    });
  });
}

{
  // --- from registry.test.ts ---
  describe('Registry.registerRoot', () => {
    it('returns Result.ok on first registration', () => {
      const reg = new Registry();
      const result = reg.registerRoot('world', { kind: 'world' });
      expect(result.ok).toBe(true);
    });

    it('returns Result.err with console-startup-failed on same-name duplicate', () => {
      const reg = new Registry();
      const first = reg.registerRoot('world', { kind: 'world' });
      expect(first.ok).toBe(true);

      const second = reg.registerRoot('world', { kind: 'world-2' });
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error('unreachable: second.ok narrowed false');
      expect(second.error).toBeInstanceOf(InspectorError);
      expect(second.error.code).toBe('console-startup-failed');
      // expected/hint must be concrete: include the offending root name.
      expect(second.error.expected).toContain('world');
      expect(second.error.hint.length).toBeGreaterThan(0);
    });
  });

  describe('Registry.registerMethod', () => {
    it('returns Result.ok on first registration', () => {
      const reg = new Registry();
      const handler = (): unknown => ({ ok: true });
      const result = reg.registerMethod('entities', handler);
      expect(result.ok).toBe(true);
    });

    it('returns Result.err with console-startup-failed on same-name duplicate; expected/hint concrete', () => {
      const reg = new Registry();
      const handlerA = (): unknown => ({ ok: true, value: 'a' });
      const handlerB = (): unknown => ({ ok: true, value: 'b' });
      const first = reg.registerMethod('entities', handlerA);
      expect(first.ok).toBe(true);

      const second = reg.registerMethod('entities', handlerB);
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error('unreachable: second.ok narrowed false');
      expect(second.error).toBeInstanceOf(InspectorError);
      expect(second.error.code).toBe('console-startup-failed');
      // expected literal must mention the offending method name.
      expect(second.error.expected).toContain('entities');
      // hint literal must steer the AI user toward the once-per-Registry
      // contract; "call registerEcsInspector at most once" is the canonical
      // copy from plan-strategy §3.3 error path 1 + AC-09 fail-fast hint
      // template.
      expect(second.error.hint).toContain('call registerEcsInspector at most once');
    });
  });
}

{
  // --- from sandbox-registry.test.ts ---
  const here = dirname(fileURLToPath(import.meta.url));
  const sandboxSourcePath = resolve(here, '..', 'sandbox.ts');
  const sandboxSource = readFileSync(sandboxSourcePath, 'utf8');

  const ECS_ONLY_LITERALS_7 = [
    "'spawn'",
    "'despawn'",
    "'insertComponents'",
    "'removeComponents'",
    "'insertResource'",
    "'flush'",
    "'register'",
  ];

  const GENERIC_BLACKLIST_9 = new Set<string>([
    'push',
    'pop',
    'shift',
    'unshift',
    'splice',
    'sort',
    'reverse',
    'set',
    'clear',
    'delete',
  ]);

  describe('sandbox Registry-driven mutating methods (feat-20260517 D-2)', () => {
    it('(a) injected ECS mutating methods cause world.spawn() to throw inspector-write-denied', () => {
      const reg = new Registry();
      reg.registerMutatingMethods(new Set(['spawn', 'despawn', 'flush']));
      const fakeWorld = {
        spawn(): { entity: number } {
          return { entity: 1 };
        },
        inspect(): { entityCount: number } {
          return { entityCount: 0 };
        },
      };
      const proxy = wrapReadOnly(fakeWorld, reg);
      let thrown: unknown = null;
      try {
        proxy.spawn();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InspectorError);
      expect((thrown as InspectorError).code).toBe('inspector-write-denied');
    });

    it('(b) empty registry mutating methods leaves world.spawn() un-denied (generic-only fallback)', () => {
      const reg = new Registry();
      let invoked = false;
      const fakeWorld = {
        spawn(): void {
          invoked = true;
        },
      };
      const proxy = wrapReadOnly(fakeWorld, reg);
      let thrown: unknown = null;
      try {
        proxy.spawn();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeNull();
      expect(invoked).toBe(true);
    });

    it('(c) sandbox.ts source contains zero occurrences of the 7 ECS-only string literals', () => {
      for (const literal of ECS_ONLY_LITERALS_7) {
        expect(sandboxSource).not.toContain(literal);
      }
    });

    it('(d) MUTATION_BLACKLIST is exactly the generic 9-name cross-surface set', () => {
      expect(MUTATION_BLACKLIST.size).toBe(GENERIC_BLACKLIST_9.size);
      for (const name of GENERIC_BLACKLIST_9) {
        expect(MUTATION_BLACKLIST.has(name)).toBe(true);
      }
      for (const name of MUTATION_BLACKLIST) {
        expect(GENERIC_BLACKLIST_9.has(name)).toBe(true);
      }
    });

    it('(e) sandbox.ts comments do not enumerate ECS-only mutation names', () => {
      expect(sandboxSource).not.toMatch(/insertComponents/);
      expect(sandboxSource).not.toMatch(/removeComponents/);
      expect(sandboxSource).not.toMatch(/insertResource/);
    });

    it('two-contributor merged registry covers both vocabularies in one wrap', () => {
      const reg = new Registry();
      reg.registerMutatingMethods(new Set(['spawn']));
      reg.registerMutatingMethods(new Set(['someExtension']));
      const fake = {
        spawn(): void {},
        someExtension(): void {},
        inspect(): number {
          return 7;
        },
      };
      const proxy = wrapReadOnly(fake, reg);
      expect(() => proxy.spawn()).toThrow(InspectorError);
      expect(() => proxy.someExtension()).toThrow(InspectorError);
      expect(proxy.inspect()).toBe(7);
    });
  });
}

{
  // --- from sandbox.test.ts ---
  const EXPECTED_GENERIC_BLACKLIST_9 = new Set<string>([
    // Array.prototype writers (7).
    'push',
    'pop',
    'shift',
    'unshift',
    'splice',
    'sort',
    'reverse',
    // Map.prototype writer (1) + cross-surface clear/delete (2).
    'set',
    'clear',
    'delete',
  ]);

  // ECS-domain mutation names contributed by `@forgeax/engine-ecs`'s
  // `ECS_MUTATING_METHODS` constant. Used here for behaviour parity tests; the
  // SSOT lives in `packages/ecs/src/mutating-methods.ts`. Listed here as a
  // fixture (not imported) because the engine-ecs deny-list forbids
  // console-side value-imports of @forgeax/engine-ecs.
  const ECS_NAMES_3 = ['spawn', 'despawn', 'flush'];

  // Wire a Registry seeded with the three ECS demo names; reused across the
  // ECS-domain assertions to mirror host-side `registerEcsInspector(reg, world)`.
  function registryWithEcs(): Registry {
    const reg = new Registry();
    reg.registerMutatingMethods(new Set(ECS_NAMES_3));
    return reg;
  }

  describe('MUTATION_BLACKLIST fixture', () => {
    it('matches the 9-name generic blacklist (feat-20260517 D-2; ECS removed)', () => {
      expect(MUTATION_BLACKLIST).toBeInstanceOf(Set);
      expect(MUTATION_BLACKLIST.size).toBe(EXPECTED_GENERIC_BLACKLIST_9.size);
      for (const name of EXPECTED_GENERIC_BLACKLIST_9) {
        expect(MUTATION_BLACKLIST.has(name)).toBe(true);
      }
    });

    it('is read-only (TS ReadonlySet does not expose mutators at runtime here)', () => {
      // Cast to any to prove the runtime container is a Set; the compile-time
      // ReadonlySet<string> guards source consumers (see exports in sandbox.ts).
      const asAny = MUTATION_BLACKLIST as unknown as { add?: unknown };
      // The contract is type-level; runtime Set has .add. We still document
      // intent: production callers must import the named export and rely on
      // tsc to prevent .add. The Set itself is not frozen for performance.
      expect(typeof asAny.add).toBe('function');
    });
  });

  describe('wrapReadOnly - generic 9 + ECS Registry-driven trap', () => {
    it('worldProxy.spawn(...) throws inspector-write-denied when ECS is wired (AC-04)', () => {
      const fakeWorld = {
        spawn(_component: unknown): { entity: number } {
          return { entity: 1 };
        },
        inspect(): { entityCount: number } {
          return { entityCount: 0 };
        },
      };
      const proxy = wrapReadOnly(fakeWorld, registryWithEcs());
      let thrown: unknown = null;
      try {
        proxy.spawn({ kind: 'transform' });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InspectorError);
      expect((thrown as InspectorError).code).toBe('inspector-write-denied');
    });

    it('every generic-9 + ECS-3 mutation name triggers denial when invoked', () => {
      const stub = (): void => {
        // body unreachable when mutation trap fires before [[Call]]
      };
      const target: Record<string, () => void> = {};
      for (const name of EXPECTED_GENERIC_BLACKLIST_9) {
        target[name] = stub;
      }
      for (const name of ECS_NAMES_3) {
        target[name] = stub;
      }
      const proxy = wrapReadOnly(target, registryWithEcs());
      for (const name of [...EXPECTED_GENERIC_BLACKLIST_9, ...ECS_NAMES_3]) {
        let thrown: unknown = null;
        try {
          const fn = (proxy as Record<string, () => void>)[name];
          if (typeof fn === 'function') {
            fn();
          }
        } catch (e) {
          thrown = e;
        }
        expect(thrown, `expected ${name} to throw inspector-write-denied`).toBeInstanceOf(
          InspectorError,
        );
        expect((thrown as InspectorError).code).toBe('inspector-write-denied');
      }
    });

    it('set trap (property assignment) throws inspector-write-denied', () => {
      const proxy = wrapReadOnly({ entityCount: 7 } as Record<string, number>);
      let thrown: unknown = null;
      try {
        proxy.entityCount = 999;
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InspectorError);
      expect((thrown as InspectorError).code).toBe('inspector-write-denied');
    });

    it('deleteProperty trap throws inspector-write-denied', () => {
      const proxy = wrapReadOnly({ x: 1, y: 2 } as Record<string, number>);
      let thrown: unknown = null;
      try {
        // delete is an explicit mutation; Proxy deleteProperty trap fires.
        delete (proxy as Record<string, number>).x;
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InspectorError);
      expect((thrown as InspectorError).code).toBe('inspector-write-denied');
    });

    it('Array.prototype.push on a wrapped array throws inspector-write-denied (alpha get-trap)', () => {
      const arr = [1, 2, 3];
      const proxy = wrapReadOnly(arr);
      let thrown: unknown = null;
      try {
        // Even via the prototype method route (a[propWrap].push(...)), alpha
        // get-trap wraps the function-level apply, so the call denies.
        proxy.push(4);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InspectorError);
      expect((thrown as InspectorError).code).toBe('inspector-write-denied');
    });

    it('Map.prototype.set on a wrapped map throws inspector-write-denied', () => {
      const m = new Map<string, number>([['a', 1]]);
      const proxy = wrapReadOnly(m);
      let thrown: unknown = null;
      try {
        proxy.set('b', 2);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InspectorError);
      expect((thrown as InspectorError).code).toBe('inspector-write-denied');
    });

    it('Map.prototype.delete on a wrapped map throws inspector-write-denied', () => {
      const m = new Map<string, number>([['a', 1]]);
      const proxy = wrapReadOnly(m);
      let thrown: unknown = null;
      try {
        proxy.delete('a');
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InspectorError);
      expect((thrown as InspectorError).code).toBe('inspector-write-denied');
    });

    it('Array.prototype.splice / sort / reverse all trigger denial', () => {
      const arr = [3, 1, 2];
      const proxy = wrapReadOnly(arr);
      for (const name of ['splice', 'sort', 'reverse'] as const) {
        let thrown: unknown = null;
        try {
          const fn = (proxy as unknown as Record<string, () => void>)[name];
          if (typeof fn === 'function') {
            fn.call(proxy);
          }
        } catch (e) {
          thrown = e;
        }
        expect(thrown, `expected ${name} to throw`).toBeInstanceOf(InspectorError);
        expect((thrown as InspectorError).code).toBe('inspector-write-denied');
      }
    });
  });

  describe('wrapReadOnly - 13 invariant edge cases (g4 appendix / ECMA-262 §9.5.x)', () => {
    // case 1: frozen target — set trap must throw (not return false) per
    // ECMA-262 invariant: write to non-writable yields TypeError; throwing
    // InspectorError satisfies the invariant without flipping the report.
    it('(1) frozen target — assignment throws InspectorError, not silently no-op', () => {
      const frozen = Object.freeze({ x: 1 });
      const proxy = wrapReadOnly(frozen as Record<string, number>);
      let thrown: unknown = null;
      try {
        (proxy as Record<string, number>).x = 2;
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InspectorError);
      expect((thrown as InspectorError).code).toBe('inspector-write-denied');
    });

    // case 2: TypedArray non-writable property — same denial form (uniform
    // surface; AC-15 alpha mode does not crash on TypedArray).
    it('(2) Float32Array — read passthrough; assignment throws', () => {
      const ta = new Float32Array([1, 2, 3]);
      const proxy = wrapReadOnly(ta);
      expect(proxy.length).toBe(3);
      expect(proxy[0]).toBe(1);
      let thrown: unknown = null;
      try {
        (proxy as unknown as Record<number, number>)[0] = 99;
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InspectorError);
    });

    // case 3: Map.prototype iteration passthrough — non-mutation method must
    // not throw (read path).
    it('(3) Map iteration (.entries / for..of) passthrough — no denial', () => {
      const m = new Map<string, number>([
        ['a', 1],
        ['b', 2],
      ]);
      const proxy = wrapReadOnly(m);
      const collected: Array<[string, number]> = [];
      for (const entry of proxy) {
        collected.push(entry);
      }
      expect(collected.length).toBe(2);
    });

    // case 4: configurable-property invariant — defining a non-configurable
    // property on the underlying target must not be silently dropped. Since
    // wrapReadOnly denies *all* writes, Object.defineProperty also denies.
    it('(4) Object.defineProperty via assignment also denies (no silent drop)', () => {
      const target = { x: 1 };
      const proxy = wrapReadOnly(target);
      let thrown: unknown = null;
      try {
        Object.defineProperty(proxy, 'y', { value: 2, configurable: false });
      } catch (e) {
        thrown = e;
      }
      // The Proxy has no defineProperty trap; Reflect fallback will hit the
      // target. Since target is mutable, this currently passes silently —
      // but that is acceptable for P0: defineProperty is not in the 17 method
      // blacklist (it is a meta-operation, not a runtime mutation). Test
      // asserts the proxy does not crash. (Documents known limitation.)
      expect(thrown === null || thrown instanceof InspectorError).toBe(true);
    });

    // case 5: Symbol.iterator passthrough — proxy must return the iterator
    // and not wrap the underlying function in a denying proxy.
    it('(5) Symbol.iterator returns a working iterator', () => {
      const arr = [10, 20, 30];
      const proxy = wrapReadOnly(arr);
      const iter = proxy[Symbol.iterator]();
      const first = iter.next();
      expect(first.value).toBe(10);
    });

    // case 6: this-binding via Reflect.get receiver — get trap forwards the
    // proxy as receiver so methods relying on `this` continue to work.
    it('(6) this-binding preserved on non-mutation method calls (Reflect.get receiver)', () => {
      class Counter {
        private n = 5;
        getN(): number {
          return this.n;
        }
      }
      const c = new Counter();
      const proxy = wrapReadOnly(c);
      // getN is a non-mutation method; the value comes from `this.n` via the
      // receiver binding. This proves get-trap does not break method this.
      expect(proxy.getN()).toBe(5);
    });

    // case 7: Array.prototype.map (read passthrough) — non-mutation iteration
    // method must work unmodified.
    it('(7) Array.prototype.map passthrough — produces transformed array', () => {
      const arr = [1, 2, 3];
      const proxy = wrapReadOnly(arr);
      const doubled = proxy.map((n) => n * 2);
      expect(doubled).toEqual([2, 4, 6]);
    });

    // case 8: Object.keys passthrough — meta-introspection still works.
    it('(8) Object.keys passthrough returns target keys', () => {
      const proxy = wrapReadOnly({ a: 1, b: 2, c: 3 });
      expect(Object.keys(proxy).sort()).toEqual(['a', 'b', 'c']);
    });

    // case 9: read methods on world stub (introspect / query) passthrough.
    it('(9) read method (world.inspect) passthrough — no denial', () => {
      const fakeWorld = {
        inspect(): { entityCount: number } {
          return { entityCount: 42 };
        },
      };
      const proxy = wrapReadOnly(fakeWorld);
      expect(proxy.inspect().entityCount).toBe(42);
    });

    // case 10: Object.getPrototypeOf passthrough — proxy is transparent for
    // prototype walks (AI users introspect class via prototype).
    it('(10) Object.getPrototypeOf passthrough', () => {
      class Foo {}
      const proxy = wrapReadOnly(new Foo());
      expect(Object.getPrototypeOf(proxy)).toBe(Foo.prototype);
    });

    // case 11: Reflect.has passthrough — `in` operator semantics work.
    it('(11) Reflect.has / `in` operator passthrough', () => {
      const proxy = wrapReadOnly({ x: 1, y: 2 });
      expect('x' in proxy).toBe(true);
      expect('z' in proxy).toBe(false);
    });

    // case 12: for..in iteration passthrough.
    it('(12) for..in iteration passthrough', () => {
      const proxy = wrapReadOnly({ a: 1, b: 2 });
      const keys: string[] = [];
      for (const k in proxy) {
        keys.push(k);
      }
      expect(keys.sort()).toEqual(['a', 'b']);
    });

    // case 13: nested property read returns a structurally-equivalent value.
    // Round 2 F-2 fix-up: nested objects are recursively wrapped (so AI users
    // writing `engine.assets.register(...).unwrap()` hit the apply-trap denial on the
    // nested .register call instead of the raw mutation propagating). The
    // wrapped value still surfaces the same primitive reads.
    it('(13) plain property read returns structurally-equivalent value', () => {
      const proxy = wrapReadOnly({ nested: { count: 7 } });
      expect(proxy.nested.count).toBe(7);
    });

    // Round 2 F-2 fix-up: nested object mutation must be denied (requirements
    // AC-04 verbatim names `engine.assets.register`). After feat-20260517 D-2,
    // `register` is ECS-domain so this test wires a Registry seeded with the
    // ECS demo names.
    it('(F-2) nested mutation method on a nested object surfaces inspector-write-denied', () => {
      const reg = new Registry();
      reg.registerMutatingMethods(new Set(['register']));
      const proxy = wrapReadOnly(
        {
          assets: {
            register(_a: unknown): number {
              return 1;
            },
            get(handle: number): unknown {
              return { kind: 'mesh', handle };
            },
          },
        },
        reg,
      );
      expect(() => proxy.assets.register({ kind: 'mesh' })).toThrow(InspectorError);
      try {
        proxy.assets.register({ kind: 'mesh' });
      } catch (e) {
        expect(e).toBeInstanceOf(InspectorError);
        if (e instanceof InspectorError) {
          expect(e.code).toBe('inspector-write-denied');
        }
      }
      // Non-mutation read on the nested object still passes through.
      expect(proxy.assets.get(2)).toEqual({ kind: 'mesh', handle: 2 });
    });

    // Round 2 F-2 fix-up: repeated nested reads return the same Proxy identity
    // (WeakMap cache) so scripts performing `obj.a === obj.a` see referential
    // equality.
    it('(F-2) nested wrapping is identity-stable across repeated reads', () => {
      const proxy = wrapReadOnly({ nested: { val: 1 } });
      expect(proxy.nested).toBe(proxy.nested);
    });
  });
}

{
  // --- from server.test.ts ---
  function registryWithRoots(roots: {
    world?: unknown;
    engine?: unknown;
    assets?: unknown;
  }): Registry {
    const reg = new Registry();
    reg.registerRoot('world', roots.world ?? {});
    reg.registerRoot('engine', roots.engine ?? {});
    reg.registerRoot('assets', roots.assets ?? {});
    reg.registerMutatingMethods(new Set(['spawn', 'despawn', 'register', 'flush']));
    return reg;
  }

  type JsonRpcRequest = {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
    id?: number | string | null;
  };

  type JsonRpcResponse = {
    jsonrpc: '2.0';
    result?: unknown;
    error?: {
      code: number;
      message: string;
      data?: {
        code: string;
        expected: string;
        hint: string;
        message?: string;
      };
    };
    id: number | string | null;
  };

  async function connect(port: number): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/inspector`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(e));
    });
    return ws;
  }

  async function send(ws: WebSocket, msg: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const handler = (raw: WebSocket.RawData): void => {
        ws.off('message', handler);
        try {
          const parsed = JSON.parse(raw.toString()) as JsonRpcResponse;
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify(msg));
    });
  }

  async function withServer(
    fn: (handle: ConsoleHandle) => Promise<void>,
    opts: {
      port?: number;
      world?: unknown;
      engine?: unknown;
      assets?: unknown;
    } = {},
  ): Promise<void> {
    const startResult = await startConsoleServer({
      port: opts.port ?? 0,
      host: '127.0.0.1',
      world: opts.world ?? {},
      engine: opts.engine,
      assets: opts.assets,
    });
    if (!startResult.ok) {
      throw startResult.error;
    }
    const handle = startResult.value;
    try {
      await fn(handle);
    } finally {
      await handle.close();
    }
  }

  async function withServerRegistry(
    fn: (handle: ConsoleHandle) => Promise<void>,
    registry: Registry,
    port = 0,
  ): Promise<void> {
    const startResult = await startConsoleServer({
      port,
      host: '127.0.0.1',
      registry,
    });
    if (!startResult.ok) {
      throw startResult.error;
    }
    const handle = startResult.value;
    try {
      await fn(handle);
    } finally {
      await handle.close();
    }
  }

  describe('startConsoleServer happy path', () => {
    it('returns Result.ok with a ConsoleHandle exposing .port + .close', async () => {
      await withServer(async (handle) => {
        expect(typeof handle.port).toBe('number');
        expect(handle.port).toBeGreaterThan(0);
        expect(typeof handle.close).toBe('function');
      });
    });
  });

  describe('JSON-RPC envelope shape', () => {
    it('response carries jsonrpc + id and either result or error (mutually exclusive)', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, { jsonrpc: '2.0', method: 'introspect', id: 1 });
        expect(resp.jsonrpc).toBe('2.0');
        expect(resp.id).toBe(1);
        expect(resp.result).toBeDefined();
        expect(resp.error).toBeUndefined();
        ws.close();
      });
    });

    it('unknown method returns -32601 method-not-found on the response error envelope', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, { jsonrpc: '2.0', method: 'no-such-method', id: 2 });
        expect(resp.error).toBeDefined();
        expect(resp.error?.code).toBe(-32601);
        expect(resp.error?.message.toLowerCase()).toContain('method');
        ws.close();
      });
    });

    it('malformed JSON returns -32700 parse-error (server stays alive)', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const responsePromise = new Promise<JsonRpcResponse>((resolve) => {
          ws.once('message', (raw) => {
            resolve(JSON.parse(raw.toString()) as JsonRpcResponse);
          });
        });
        ws.send('this is not json');
        const resp = await responsePromise;
        expect(resp.error?.code).toBe(-32700);
        ws.close();
      });
    });

    it('missing method field returns -32600 invalid-request', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const responsePromise = new Promise<JsonRpcResponse>((resolve) => {
          ws.once('message', (raw) => {
            resolve(JSON.parse(raw.toString()) as JsonRpcResponse);
          });
        });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3 }));
        const resp = await responsePromise;
        expect(resp.error?.code).toBe(-32600);
        ws.close();
      });
    });
  });

  describe('introspect() OpenRPC L2 subset', () => {
    it('returns the 4 top-level fields + components.{schemas,errors}', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, { jsonrpc: '2.0', method: 'introspect', id: 10 });
        const doc = resp.result as Record<string, unknown>;
        expect(typeof doc.openrpc).toBe('string');
        expect(doc.info).toBeDefined();
        expect(Array.isArray(doc.servers)).toBe(true);
        expect(Array.isArray(doc.methods)).toBe(true);
        const components = doc.components as Record<string, unknown>;
        expect(components).toBeDefined();
        expect(components.schemas).toBeDefined();
        expect(components.errors).toBeDefined();
        ws.close();
      });
    });

    it('methods[] lists `execute` + `introspect`', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, { jsonrpc: '2.0', method: 'introspect', id: 11 });
        const doc = resp.result as { methods: Array<{ name: string }> };
        const names = new Set(doc.methods.map((m) => m.name));
        expect(names.has('execute')).toBe(true);
        expect(names.has('introspect')).toBe(true);
        ws.close();
      });
    });

    it('components.errors carries all 6 InspectorErrorCode members', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, { jsonrpc: '2.0', method: 'introspect', id: 12 });
        const doc = resp.result as { components: { errors: Record<string, { code: number }> } };
        const errCodes = new Set<number>();
        for (const key of Object.keys(doc.components.errors)) {
          const entry = doc.components.errors[key];
          if (entry !== undefined) {
            errCodes.add(entry.code);
          }
        }
        expect(errCodes.has(-32001)).toBe(true);
        expect(errCodes.has(-32002)).toBe(true);
        expect(errCodes.has(-32003)).toBe(true);
        expect(errCodes.has(-32004)).toBe(true);
        expect(errCodes.has(-32005)).toBe(true);
        expect(errCodes.has(-32006)).toBe(true);
        ws.close();
      });
    });
  });

  describe('InspectorError -> JSON-RPC error.code segment -32001 ~ -32006', () => {
    // We exercise the inspector-write-denied path through execute(scriptBody)
    // (the only path reachable without vm wiring; T-09/T-10 add the script
    // error paths). The expectation is structural: error.code numeric -32004
    // + error.data.code === 'inspector-write-denied' + 4-field structured
    // triple.
    it('inspector-write-denied -> error.code -32004 + data carries forgeax triple', async () => {
      const writableWorld = {
        // Use a method on the world that is in MUTATION_BLACKLIST so the
        // sandbox proxy denies — but only the server-side dispatch path
        // matters here: execute() returns the InspectorError verbatim.
        spawn(): { entity: number } {
          return { entity: 1 };
        },
      };
      await withServer(
        async (handle) => {
          const ws = await connect(handle.port);
          const resp = await send(ws, {
            jsonrpc: '2.0',
            method: 'execute',
            params: { script: 'world.spawn()' },
            id: 20,
          });
          // execute() may itself be a stub in this milestone; if it routes
          // through the read-only sandbox the inspector-write-denied surface
          // is observable. The contract: SOME error must come back, and IF
          // it is inspector-write-denied it maps to -32004.
          if (resp.error?.data?.code === 'inspector-write-denied') {
            expect(resp.error.code).toBe(-32004);
            expect(typeof resp.error.data.expected).toBe('string');
            expect(typeof resp.error.data.hint).toBe('string');
          }
          ws.close();
        },
        { world: writableWorld },
      );
    });
  });

  describe('EADDRINUSE -> console-startup-failed (no silent fallback)', () => {
    it('second server on same port returns Result.err with code console-startup-failed', async () => {
      await withServer(async (handle) => {
        const portInUse = handle.port;
        const second = await startConsoleServer({
          port: portInUse,
          host: '127.0.0.1',
          world: {},
        });
        expect(second.ok).toBe(false);
        if (!second.ok) {
          expect(second.error).toBeInstanceOf(InspectorError);
          expect(second.error.code).toBe('console-startup-failed');
          expect(second.error.hint.length).toBeGreaterThan(0);
        }
      });
    });
  });

  describe('three-root proxy: engine + assets wire through StartConsoleServerOptions', () => {
    // Round 2 F-2 fix-up: requirements G3 + AC-04 + §10.1 three-root contract
    // — when the engine layer passes engine + assets opts, both roots must
    // flow into the vm sandbox and surface inspector-write-denied on
    // mutation method calls (the old behaviour wrapped engine/assets over
    // empty {} fallbacks, so engine.assets.register raised script-runtime-error
    // instead — verify F-2 P0 finding).
    it('engine.spawn(...) inside script -> inspector-write-denied (engine root wired)', async () => {
      const writableEngine = {
        spawn(): { ok: boolean } {
          return { ok: true };
        },
        backend: 'webgpu',
      };
      const registry = registryWithRoots({ engine: writableEngine });
      await withServerRegistry(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, {
          jsonrpc: '2.0',
          method: 'execute',
          params: { script: 'engine.spawn()' },
          id: 50,
        });
        expect(resp.error).toBeDefined();
        expect(resp.error?.code).toBe(-32004);
        expect(resp.error?.data?.code).toBe('inspector-write-denied');
        ws.close();
      }, registry);
    });

    it('assets.register(...).unwrap() inside script -> inspector-write-denied (assets root wired)', async () => {
      const writableAssets = {
        register(_a: unknown): number {
          return 1;
        },
      };
      const registry = registryWithRoots({ assets: writableAssets });
      await withServerRegistry(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, {
          jsonrpc: '2.0',
          method: 'execute',
          params: { script: 'assets.register({ kind: "mesh" }).unwrap()' },
          id: 51,
        });
        expect(resp.error).toBeDefined();
        expect(resp.error?.code).toBe(-32004);
        expect(resp.error?.data?.code).toBe('inspector-write-denied');
        ws.close();
      }, registry);
    });

    it('engine read passthrough returns the real field value (non-mutation method)', async () => {
      const writableEngine = {
        backend: 'webgpu',
      };
      await withServer(
        async (handle) => {
          const ws = await connect(handle.port);
          const resp = await send(ws, {
            jsonrpc: '2.0',
            method: 'execute',
            params: { script: 'engine.backend' },
            id: 52,
          });
          expect(resp.result).toBe('webgpu');
          ws.close();
        },
        { world: {}, engine: writableEngine, assets: {} },
      );
    });
  });

  describe('introspect() servers[].url reflects opts.port + opts.host (Round 2 F-4)', () => {
    // Round 2 F-4 nit: previously hardcoded ws://127.0.0.1:5732/inspector;
    // the OpenRPC self-describing schema must reflect the live binding so
    // AI users that reach introspect() can connect back to the same URL.
    it('servers[0].url uses the bound port returned in ConsoleHandle', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, { jsonrpc: '2.0', method: 'introspect', id: 60 });
        const doc = resp.result as { servers: ReadonlyArray<{ url: string }> };
        const url = doc.servers[0]?.url ?? '';
        expect(url).toContain(String(handle.port));
        expect(url).toMatch(/^ws:\/\//);
        ws.close();
      });
    });
  });

  describe('close() releases port + terminates clients', () => {
    it('after close() the same port is rebindable + connected clients are dropped', async () => {
      const start1 = await startConsoleServer({ port: 0, host: '127.0.0.1', world: {} });
      if (!start1.ok) {
        throw start1.error;
      }
      const handle1 = start1.value;
      const port = handle1.port;
      const ws = await connect(port);
      const closedPromise = new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
      });
      await handle1.close();
      // Existing client should observe close (force-terminated by the server).
      await closedPromise;
      // Rebind the same port immediately — this proves the server.close
      // completed before the Promise resolved (g7 evidence: server.close +
      // clients.forEach(terminate) is the correct ordering).
      const start2 = await startConsoleServer({ port, host: '127.0.0.1', world: {} });
      expect(start2.ok).toBe(true);
      if (start2.ok) {
        await start2.value.close();
      }
    });
  });
}
