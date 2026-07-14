// AC-L5 stale-error compile-assertion vehicle.
//
// Sediments 5 method-level `expectTypeOf` assertions (the 4 `lookupAlive`
// callers — `get` / `set` / `addComponent` / `removeComponent` — plus
// `addSystem`) into a dedicated test-d file so that `tsc -b` (and vitest
// typecheck) certify, every release, the load-bearing type-layer contract
// of F-1's stale-error precision work:
//
//   1. Each of the 4 mutation/read methods returns `Result<..., EcsError>`
//      whose error variant — when narrowed to `StaleEntityError` — exposes
//      `.operation: string | undefined` and `.component: string | undefined`
//      (charter proposition 4: errors are structured payloads, not strings).
//   2. `addSystem`'s class-method generic shape is preserved (a method-level
//      simplified counterpart of `types.test-d.ts:[w15]` — that file owns the
//      `NestedColumnBundle` inference theme; this file owns the signature
//      shape theme; both coexist per plan-strategy §2 S-3 OQ-3).
//
// File structure mirrors `minimal-example.test-d.ts` (vitest test-d form,
// `expectTypeOf` based, single top-level `describe` per method group).

import type { Result } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { CommandBuffer } from '../commands';
import { defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { entityIndex } from '../entity-handle';
import type { EcsErrorCode } from '../errors';
import { StaleEntityError } from '../errors';
import type { EcsError } from '../world';
import { World } from '../world';

describe('[w6] AC-L5 — world.get returns Result<ShapeOf<S>, EcsError> with structured stale payload', () => {
  it('return type is Result<{ x: number; y: number }, EcsError>; stale narrowing exposes .operation/.component', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });

    const world = new World();
    const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = world.get(e, Position);

    // Signature shape: Result<ShapeOf<S>, EcsError>.
    expectTypeOf(r).toEqualTypeOf<Result<{ readonly x: number; readonly y: number }, EcsError>>();

    if (!r.ok) {
      const err = r.error;
      // EcsError is a union; narrowing to StaleEntityError surfaces .operation/.component.
      if (err instanceof StaleEntityError) {
        expectTypeOf(err.operation).toEqualTypeOf<string | undefined>();
        expectTypeOf(err.component).toEqualTypeOf<string | undefined>();
      }
    }
  });
});

describe('[w6] AC-L5 — world.set returns Result<void, EcsError> with structured stale payload', () => {
  it('return type is Result<void, EcsError>; stale narrowing exposes .operation/.component', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });

    const world = new World();
    const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = world.set(e, Position, { x: 10 });

    expectTypeOf(r).toEqualTypeOf<Result<void, EcsError>>();

    if (!r.ok) {
      const err = r.error;
      if (err instanceof StaleEntityError) {
        expectTypeOf(err.operation).toEqualTypeOf<string | undefined>();
        expectTypeOf(err.component).toEqualTypeOf<string | undefined>();
      }
    }
  });
});

describe('[w6] AC-L5 — world.addComponent returns Result<void, EcsError> with structured stale payload', () => {
  it('return type is Result<void, EcsError>; stale narrowing exposes .operation/.component', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });
    const Velocity = defineComponent('Velocity', { dx: { type: 'f32' }, dy: { type: 'f32' } });

    const world = new World();
    const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = world.addComponent(e, { component: Velocity, data: { dx: 1, dy: 0 } });

    expectTypeOf(r).toEqualTypeOf<Result<void, EcsError>>();

    if (!r.ok) {
      const err = r.error;
      if (err instanceof StaleEntityError) {
        expectTypeOf(err.operation).toEqualTypeOf<string | undefined>();
        expectTypeOf(err.component).toEqualTypeOf<string | undefined>();
      }
    }
  });
});

describe('[w6] AC-L5 — world.removeComponent returns Result<void, EcsError> with structured stale payload', () => {
  it('return type is Result<void, EcsError>; stale narrowing exposes .operation/.component', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });

    const world = new World();
    const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const r = world.removeComponent(e, Position);

    expectTypeOf(r).toEqualTypeOf<Result<void, EcsError>>();

    if (!r.ok) {
      const err = r.error;
      if (err instanceof StaleEntityError) {
        expectTypeOf(err.operation).toEqualTypeOf<string | undefined>();
        expectTypeOf(err.component).toEqualTypeOf<string | undefined>();
      }
    }
  });
});

describe('[w6] AC-L5 — world.addSystem<const Qs> method signature shape (simplified counterpart of types.test-d.ts:[w15])', () => {
  it('addSystem returns void; fn receives mapped queryResults + CommandBuffer at the method-level call site', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });

    const world = new World();
    const ret = world.addSystem({
      name: 'ac-l5-shape-probe',
      queries: [{ with: [Position] }],
      fn: (_world, queryResults, commands) => {
        // Method-level signature shape: queryResults is array; per-query bundle
        // is array; per-component access yields the field-view dict; commands
        // is `CommandBuffer`. Simplified vs. types.test-d.ts:[w15] which probes
        // `bundle.Position.x → Float32Array` (NestedColumnBundle theme).
        const sample = queryResults[0]?.[0];
        if (sample) {
          expectTypeOf(sample.Position.x).toEqualTypeOf<Float32Array>();
        }
        expectTypeOf(commands).toEqualTypeOf<CommandBuffer>();
      },
    });

    // Class-method `addSystem` returns void (registration side-effect only).
    expectTypeOf(ret).toEqualTypeOf<void>();
  });
});

// w3: type-level assertion — entityIndex returns number (u32 slot, low 24 bits)
describe('[w3] Entity codec type contract', () => {
  it('entityIndex returns number', () => {
    const fake = 0 as EntityHandle;
    expectTypeOf(entityIndex(fake)).toEqualTypeOf<number>();
  });
});

// w13: EcsErrorCode exhaustion test-d — store-level type completeness gate.
// Verifies the closed union includes 'shared-ref-stale' and 'unique-ref-stale'
// so that any exhaustive switch without these codes triggers TS never error.
// Distinct from w19 (resolveAssetHandle real consumption path, AC-10).
describe('[w13] EcsErrorCode union completeness — stale codes present', () => {
  it('exhaustive switch over EcsErrorCode must include shared-ref-stale', () => {
    // If shared-ref-stale is NOT in the union, this switch block would
    // still compile because the type level never would not trigger —
    // this test-d proves the code IS in the union.
    const assertExhaustive = (code: EcsErrorCode): string => {
      switch (code) {
        case 'entity-index-overflow':
        case 'schema-unsupported-field':
        case 'stale-entity':
        case 'component-already-present':
        case 'component-not-present':
        case 'cyclic-dependency':
        case 'resource-not-found':
        case 'system-before-unknown':
        case 'system-name-conflict':
        case 'cyclic-injection':
        case 'unique-ref-released':
        case 'unique-ref-double-release':
        case 'unique-ref-stale':
        case 'shared-ref-released':
        case 'shared-ref-double-release':
        case 'shared-ref-stale':
        case 'builtin-slot-not-owned':
        case 'managed-buffer-out-of-bounds':
        case 'managed-buffer-shrink-not-supported':
        case 'managed-array-element-type-not-allowed':
        case 'fixed-size-mismatch':
        case 'fixed-array-overflow':
        case 'array-pop-empty':
        case 'instance-transforms-stride-mismatch':
        case 'spawn-light-invalid-bounds':
        case 'cardinality-exceeded':
        case 'resource-invalid-value':
        case 'sprite-animation-invalid':
        case 'relationship-self-cycle':
        case 'relationship-mirror-component-not-registered':
        case 'relationship-mirror-field-type-mismatch':
        case 'relationship-detach-mismatch':
        case 'query-descriptor-with-optional-conflict':
        case 'component-not-defined':
        case 'remove-essential-component':
        case 'scene-override-type-mismatch':
        case 'spawn-data-unknown-field':
        case 'sprite-instances-count-mismatch':
        case 'sprite-instances-requires-sprite-shader':
        case 'sprite-instances-mutually-exclusive-with-instances':
        case 'query-combinations-entity-required':
        // feat-20260713-mount-override-component-add-and-shared-ref-round M2 / w9
        case 'shared-field-invalid-value':
          return code;
      }
    };
    expectTypeOf(assertExhaustive).toBeFunction();
  });

  it('shared-ref-stale is assignable to EcsErrorCode', () => {
    const stale: EcsErrorCode = 'shared-ref-stale';
    expectTypeOf(stale).toEqualTypeOf<'shared-ref-stale'>();
  });

  it('unique-ref-stale is assignable to EcsErrorCode', () => {
    const stale: EcsErrorCode = 'unique-ref-stale';
    expectTypeOf(stale).toEqualTypeOf<'unique-ref-stale'>();
  });
});
