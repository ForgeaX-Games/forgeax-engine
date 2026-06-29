// Compile-time type-derivation tests for the world.push / world.pop /
// world.capacity command surface (w6, AC-04).
//
// Locks the M2 contract: the three commands accept only schema fields whose
// type literal is a managed-array keyword (`array<T>` / `array<T, N>`).
// Cross-shape access (entity / buffer / string fields) is a TS compile-time
// error via the `ArrayFieldsOf<S>` mapped-type filter.
//
// Each command gets at least one cross-shape negative anchor:
//   - world.push     -> reject `'parent'` (entity field)
//   - world.capacity -> reject `'meta'`   (buffer<N> field)
//   - world.pop      -> reject `'name'`   (string field)
//
// Plus a positive anchor per command on the array<...> field `'transforms'`.
//
// Pre-M2 (w8 impl): the three commands do not exist on `World`; every
// reference below is a TS error and the @ts-expect-error directives flip
// "unsatisfied". This is the TDD red state — the test file is intentionally
// in flux until w8 lands the implementation.
//
// Post-M2 (w8 impl): the negative directives are satisfied; the positive
// access lines compile clean.

import { describe, it } from 'vitest';
import { defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { World } from '../world';

describe('world.push / world.pop / world.capacity — cross-shape reject (w6, AC-04)', () => {
  // Mixed-shape schema covering all three reject anchors plus one positive
  // `array<...>` anchor. The component is registered against a fresh World
  // instance per test path; the `entity` we feed in is a sentinel cast so we
  // do not need a live spawn here (the test is about TS resolution only).
  const Mixed = defineComponent('Mixed', {
    parent: { type: 'entity' },
    meta: { type: 'buffer<8>' },
    name: { type: 'string' },
    transforms: { type: 'array<f32>' },
  });

  const world = new World();
  const e = 0 as unknown as EntityHandle;

  it("world.push rejects an 'entity' field name", () => {
    // @ts-expect-error 'parent' is an entity field; world.push only accepts
    // ArrayFieldsOf<Schema> (array<T> / array<T, N>) field names.
    void world.push(e, Mixed, 'parent', 0);
  });

  it("world.push accepts an 'array<T>' field name", () => {
    void world.push(e, Mixed, 'transforms', 1.0);
  });

  it("world.capacity rejects a 'buffer<N>' field name", () => {
    // @ts-expect-error 'meta' is a buffer<N> field; world.capacity only
    // accepts ArrayFieldsOf<Schema> (array<T> / array<T, N>) field names.
    void world.capacity(e, Mixed, 'meta');
  });

  it("world.capacity accepts an 'array<T>' field name", () => {
    void world.capacity(e, Mixed, 'transforms');
  });

  it("world.pop rejects a 'string' field name", () => {
    // @ts-expect-error 'name' is a string field; world.pop only accepts
    // ArrayFieldsOf<Schema> (array<T> / array<T, N>) field names.
    void world.pop(e, Mixed, 'name');
  });

  it("world.pop accepts an 'array<T>' field name", () => {
    void world.pop(e, Mixed, 'transforms');
  });
});
