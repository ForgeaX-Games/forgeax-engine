// @forgeax/engine-ecs — SystemSet define + registry enumeration tests (w1, RED)
//
// TDD: defineSystemSet and getRegisteredSystemSets do not exist yet, so this
// file will fail to compile (RED). It becomes GREEN after w2 implements the
// token + registry.

import { describe, expect, it } from 'vitest';
import { defineSystemSet, getRegisteredSystemSets } from '../src/schedule';

describe('system-set-define.test.ts', () => {
  describe('AC-01 — defineSystemSet writes to global registry, duplicate overwrites', () => {
    it('defineSystemSet returns a frozen branded token', () => {
      const token = defineSystemSet({ name: 'test-set' });
      expect(token).toBeDefined();
      expect(token.name).toBe('test-set');
      // Frozen: attempting to mutate a property throws in strict mode.
      expect(() => {
        (token as Record<string, unknown>).name = 'hijacked';
      }).toThrow();
    });

    it('duplicate defineSystemSet with same name overwrites the first', () => {
      const first = defineSystemSet({ name: 'overwrite-set' });
      const second = defineSystemSet({ name: 'overwrite-set' });
      // Second overwrites: they are different objects but the registry entry
      // is the second one.
      expect(first).not.toBe(second);
      // getRegisteredSystemSets returns the most recent token.
      const registered = getRegisteredSystemSets();
      expect(registered.get('overwrite-set')).toBe(second);
    });

    it('duplicate defineSystemSet with same name makes old token stale', () => {
      const first = defineSystemSet({ name: 'stale-set' });
      const second = defineSystemSet({ name: 'stale-set' });
      // The registry identity check: registry.get(name) === token.
      // After overwrite, registry.get(name) === second, not first.
      const registered = getRegisteredSystemSets();
      expect(registered.get('stale-set')).toBe(second);
      expect(registered.get('stale-set')).not.toBe(first);
    });
  });

  describe('getRegisteredSystemSets enumeration', () => {
    it('getRegisteredSystemSets returns a read-only view of defined sets', () => {
      defineSystemSet({ name: 'enum-a' });
      defineSystemSet({ name: 'enum-b' });
      const registered = getRegisteredSystemSets();
      expect(registered.has('enum-a')).toBe(true);
      expect(registered.has('enum-b')).toBe(true);
    });

    it('getRegisteredSystemSets entries carry name + runIf + chained fields', () => {
      defineSystemSet({ name: 'full-set', runIf: () => true, chained: true });
      const registered = getRegisteredSystemSets();
      const token = registered.get('full-set');
      expect(token).toBeDefined();
      expect(token!.name).toBe('full-set');
      expect(token!.runIf).toBeDefined();
      expect(token!.chained).toBe(true);
    });

    it('getRegisteredSystemSets entries for sets without runIf/chained have undefined optional fields', () => {
      defineSystemSet({ name: 'bare-set' });
      const registered = getRegisteredSystemSets();
      const token = registered.get('bare-set');
      expect(token).toBeDefined();
      expect(token!.name).toBe('bare-set');
      expect(token!.runIf).toBeUndefined();
      expect(token!.chained).toBeUndefined();
    });

    it('undefined set is not present in enumeration', () => {
      const registered = getRegisteredSystemSets();
      expect(registered.has('nonexistent-set')).toBe(false);
    });
  });
});