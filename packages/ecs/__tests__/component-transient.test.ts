// feat-20260707-engine-world-clone-transient-for-editor-ssot M1 / m1t1:
// Component.transient token field unit test (AC-01).
//
// Test (a) default-false, (b) explicit-true read-back, (c) explicit-false,
// (d) type-level: Component.transient is `readonly boolean` (not optional,
// not undefined). Also verifies transient does NOT interfere with other
// token fields (name, schema, id, defaults, cardinality, relationship, meta).

import { describe, expect, it } from 'vitest';
import { defineComponent, type Component } from '../src/index';

describe('m1t1 — Component.transient token field (AC-01)', () => {
  it('(a) default: defineComponent with no third arg -> token.transient === false', () => {
    const C = defineComponent('M1T1_Default', { x: 'f32' });
    // Token exists and has transient field with default false.
    expect(C).toBeDefined();
    expect(C.transient).toBe(false);
  });

  it('(b) explicit true: defineComponent({ transient: true }) -> token.transient === true', () => {
    const C = defineComponent('M1T1_ExplicitTrue', { y: 'f32' }, { transient: true });
    expect(C.transient).toBe(true);
    // Other fields unchanged.
    expect(C.name).toBe('M1T1_ExplicitTrue');
  });

  it('(c) explicit false: defineComponent({ transient: false }) -> token.transient === false', () => {
    const C = defineComponent('M1T1_ExplicitFalse', { z: 'f32' }, { transient: false });
    expect(C.transient).toBe(false);
  });

  it('(d) type-level: Component.transient is readonly boolean (not optional, not undefined)', () => {
    // Access the field — if it were optional or undefined, this type-checks but
    // the runtime value shape is verified: the field exists and is a boolean.
    const C = defineComponent('M1T1_TypeCheck', { v: 'f32' });
    const t: boolean = C.transient;
    expect(typeof t).toBe('boolean');
    expect(t).toBe(false);
  });

  it('(e) non-interference: transient does not affect other token fields', () => {
    // A component declared with transient: true still has all expected fields.
    const C = defineComponent('M1T1_NonInterfere', { a: 'f32', b: 'string' }, { transient: true, cardinality: 2 });

    expect(C.name).toBe('M1T1_NonInterfere');
    expect(C.transient).toBe(true);
    expect(C.cardinality).toBe(2);
    expect(C.schema).toBeDefined();
    expect(C.schema.a).toBe('f32');
    expect(C.schema.b).toBe('string');
    expect(C.id).toBeGreaterThan(0);
    expect(C.toSchemaJSON()).toBe(JSON.stringify(C.schema));
    expect(C.meta).toBeDefined();
    expect(C.fields).toBeDefined();
  });

  it('(f) relationship holder with transient (field is accessible on holder)', () => {
    // First define the mirror target, then the holder with relationship + transient.
    defineComponent('M1T1_RelMirror', { refs: 'array<entity>' });
    const C = defineComponent('M1T1_RelHolder', { ref: 'entity' }, {
      transient: true,
      relationship: { mirror: 'M1T1_RelMirror', field: 'refs' },
    });
    // Holder side transient field is accessible.
    expect(C.transient).toBe(true);
    expect(C.relationship?.mirror).toBe('M1T1_RelMirror');
  });
});