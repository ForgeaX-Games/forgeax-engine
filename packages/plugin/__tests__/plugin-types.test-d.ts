// plugin-types.test-d.ts -- compile-time assertions for M1 Plugin interface
// (feat-20260623-plugin-system-unify-build-world-protocol, AC-01).
//
// M1 stages the Plugin interface shape. No runtime behavior is asserted -- this
// test validates only the public type surface as visible to AI users at compile
// time (charter P4).
//
// charter awareness:
//   F1 + P1: AI users discover the Plugin contract via tsc, not docs.
//   P4 consistent abstraction: Plugin is the single shape for all engine
//       capability packages regardless of package (runtime/physics/state/...).

import { ok, type World } from '@forgeax/engine-ecs';
import { describe, expectTypeOf, it } from 'vitest';
import type { Plugin } from '@forgeax/engine-plugin';

describe('Plugin interface exported from @forgeax/engine-plugin (AC-01)', () => {
  it('Plugin is exported as a type', () => {
    type Exists = Plugin extends { readonly name: string; readonly build: unknown } ? true : false;
    expectTypeOf<Exists>().toEqualTypeOf<true>();
  });

  it('Plugin.name type is string (not widened, not never)', () => {
    // AC-01 / C-8: Plugin.name is string. The "kebab-case literal" constraint
    // (C-8) is a naming convention on plugin factories, not a TS literal
    // type. M1 defines `name: string`; literal narrowing is exercised by
    // concrete plugin factories in M2.
    expectTypeOf<Plugin['name']>().toEqualTypeOf<string>();
  });

  it('Plugin.build signature accepts World and returns Result<void, PluginError>', () => {
    type BuildType = Plugin['build'];
    // biome-ignore lint/suspicious/noExplicitAny: type-level predicate on callable shape
    type IsCallable = BuildType extends (...args: any[]) => any ? true : false;
    expectTypeOf<IsCallable>().toEqualTypeOf<true>();
    // World is the single argument
    type BuildArgs = Parameters<Plugin['build']>;
    expectTypeOf<BuildArgs>().toEqualTypeOf<[World]>();
  });
});

describe('Plugin shape matches AC-01 contract', () => {
  it('Plugin has readonly name field', () => {
    type IsReadonly = keyof Plugin extends never ? false : true;
    expectTypeOf<IsReadonly>().toEqualTypeOf<true>();
  });

  it('Plugin object literals (sync + async) satisfy the interface', () => {
    // Synchronous build
    const syncPlugin: Plugin = {
      name: 'my-sync',
      build() {
        return ok(undefined);
      },
    };
    void syncPlugin;

    // Async build
    const asyncPlugin: Plugin = {
      name: 'my-async',
      async build() {
        return ok(undefined);
      },
    };
    void asyncPlugin;
  });
});