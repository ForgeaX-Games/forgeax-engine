// feat-20260709-component-vec-fields-and-field-transient-batch M1 / w1:
// AC-07 transient exclusion tests for CollidingEntities and CharacterController.
//
// The collect-scene-asset mechanism (collect-scene-asset.ts:554,577) is generic:
// it reads compToken.transient (component-level) and comp.fields[f].transient
// (field-level). This test verifies the metadata declarations are correct; the
// serialization exclusion follows from the generic mechanism.
//
// TDD red-phase: these assertions will FAIL before w3 lands the transient
// declarations, then turn green after w3.

import { describe, expect, it } from 'vitest';
import { CharacterController, CollidingEntities } from '../index';

describe('w1 — AC-07 transient exclusion (CollidingEntities, CharacterController)', () => {
  it('CollidingEntities: component-level transient is true', () => {
    expect(CollidingEntities).toBeDefined();
    expect(CollidingEntities.transient).toBe(true);
  });

  it('CollidingEntities: entities field is not transient (only component-level skip)', () => {
    const entitiesField = CollidingEntities.fields.entities;
    expect(entitiesField).toBeDefined();
    // entities is the payload — transient is at component level, not field level.
    expect(entitiesField.transient).toBeUndefined();
  });

  it('CharacterController: grounded field is transient', () => {
    expect(CharacterController).toBeDefined();
    const groundedField = CharacterController.fields.grounded;
    expect(groundedField).toBeDefined();
    expect(groundedField.transient).toBe(true);
  });

  it('CharacterController: other fields are not transient', () => {
    expect(CharacterController.fields.offset.transient).toBeUndefined();
    expect(CharacterController.fields.maxSlopeClimbDeg.transient).toBeUndefined();
    expect(CharacterController.fields.snapToGroundDist.transient).toBeUndefined();
  });
});
