// feat-20260707-engine-world-clone-transient-for-editor-ssot M3 / m3t1:
// checkRelationshipMirrorsTransient pure-function test (AC-06).
//
// Five sub-scenarios:
//   (a) Holder with relationship.mirror, mirror token transient: false → violation
//   (b) All mirror targets transient: true → clean
//   (c) Holder transient: undefined, mirror transient: true → NO violation
//       (Finding-6: assertion checks mirror, NOT holder)
//   (d) Mirror name not resolvable → skip gracefully (no throw)
//   (e) Empty holders → empty violations
//
// Zero defineComponent calls — uses hand-crafted plain-object tokens with
// injectable resolveComponent (Map mock) per D-2.

import { describe, expect, it } from 'vitest';
import { checkRelationshipMirrorsTransient } from '../src/component';

// Minimal Component-like tokens for testing — only the fields the function reads.
interface MockToken {
  readonly name: string;
  readonly transient?: boolean;
  readonly relationship?: { readonly mirror: string };
}

describe('m3t1 — checkRelationshipMirrorsTransient pure function (AC-06)', () => {
  it('(a) mirror token transient: false → violation named', () => {
    const holder: MockToken = {
      name: 'ChildOf',
      relationship: { mirror: 'Children' },
    };
    const badMirror: MockToken = {
      name: 'Children',
      transient: false,
    };
    const resolveComponent = (name: string) =>
      name === 'Children' ? (badMirror as unknown as ReturnType<typeof resolveComponent>) : undefined;

    const violations = checkRelationshipMirrorsTransient(
      [holder as Parameters<typeof checkRelationshipMirrorsTransient>[0] extends Iterable<infer T> ? T : never],
      resolveComponent,
    );
    expect(violations).toContain('Children');
    expect(violations.length).toBe(1);
  });

  it('(b) all mirror targets transient: true → empty violations', () => {
    const childOf: MockToken = {
      name: 'ChildOf',
      relationship: { mirror: 'Children' },
    };
    const bulletOf: MockToken = {
      name: 'BulletOf',
      relationship: { mirror: 'Bullets' },
    };
    const children: MockToken = { name: 'Children', transient: true };
    const bullets: MockToken = { name: 'Bullets', transient: true };
    const resolveComponent = new Map<string, MockToken>([
      ['Children', children],
      ['Bullets', bullets],
    ]);

    const violations = checkRelationshipMirrorsTransient(
      [childOf, bulletOf] as unknown as Parameters<typeof checkRelationshipMirrorsTransient>[0],
      (name) => (resolveComponent.get(name) as unknown as ReturnType<typeof resolveComponent>) ?? undefined,
    );
    expect(violations.length).toBe(0);
  });

  it('(c) CRITICAL Finding-6: holder transient is NOT checked — only mirror transient matters', () => {
    // holder has transient: undefined (or whatever), mirror has transient: true → no violation
    const holder: MockToken = {
      name: 'ChildOf',
      // no transient field on holder
      relationship: { mirror: 'Children' },
    };
    const okMirror: MockToken = { name: 'Children', transient: true };
    const resolveComponent = (name: string) =>
      name === 'Children' ? (okMirror as unknown as ReturnType<typeof resolveComponent>) : undefined;

    const violations = checkRelationshipMirrorsTransient(
      [holder as Parameters<typeof checkRelationshipMirrorsTransient>[0] extends Iterable<infer T> ? T : never],
      resolveComponent,
    );
    expect(violations.length).toBe(0);

    // Also verify: holder with transient: false + mirror with transient: true → still no violation
    const holderFalse: MockToken = {
      name: 'ChildOf',
      transient: false,
      relationship: { mirror: 'Children' },
    };
    const violations2 = checkRelationshipMirrorsTransient(
      [holderFalse as Parameters<typeof checkRelationshipMirrorsTransient>[0] extends Iterable<infer T> ? T : never],
      resolveComponent,
    );
    expect(violations2.length).toBe(0);
  });

  it('(d) mirror name not found by resolveComponent → skip gracefully (no throw)', () => {
    const holder: MockToken = {
      name: 'UnregisteredHolder',
      relationship: { mirror: 'UnregisteredMirror' },
    };
    // resolveComponent returns undefined for everything — mirror not registered yet
    const resolveComponent = (_name: string) => undefined;

    expect(() => {
      const violations = checkRelationshipMirrorsTransient(
        [holder as Parameters<typeof checkRelationshipMirrorsTransient>[0] extends Iterable<infer T> ? T : never],
        resolveComponent,
      );
      expect(violations.length).toBe(0);
    }).not.toThrow();
  });

  it('(e) empty holders → empty violations', () => {
    const resolveComponent = (_name: string) => undefined;
    const violations = checkRelationshipMirrorsTransient([], resolveComponent);
    expect(violations.length).toBe(0);
  });

  it('(f) holder without relationship field → skipped (not a relationship component)', () => {
    const plain: MockToken = { name: 'Transform', transient: false };
    const resolveComponent = (_name: string) => undefined;
    const violations = checkRelationshipMirrorsTransient(
      [plain as Parameters<typeof checkRelationshipMirrorsTransient>[0] extends Iterable<infer T> ? T : never],
      resolveComponent,
    );
    expect(violations.length).toBe(0);
  });
});