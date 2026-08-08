import { describe, expect, it } from 'vitest';
import { PackRuntimeRealm } from '../runtime-realm.js';

const binding = (scopeId: string, generation: number) => ({
  schemaVersion: 'runtime-asset-binding-v1' as const,
  gameId: scopeId,
  scopeId,
  generation,
  status: 'unbound' as const,
  catalogUrl: `/__pack/scopes/${scopeId}/${generation}/catalog.json`,
  importUrlBase: `/__pack/scopes/${scopeId}/${generation}/import`,
  packageUrlBase: `/__pack/scopes/${scopeId}/${generation}/asset`,
});

describe('PackRuntimeRealm', () => {
  it('rejects publication from a retired generation', () => {
    const realm = new PackRuntimeRealm();
    const firstToken = realm.beginBind(binding('game-a', 1), ['/games/a']);
    const secondToken = realm.beginBind(binding('game-a', 2), ['/games/a']);

    expect(realm.publish(firstToken, 'ready')).toBeUndefined();
    expect(realm.publish(secondToken, 'ready')?.generation).toBe(2);
    expect(realm.matches('game-a', 1)).toBe(false);
    expect(realm.matches('game-a', 2)).toBe(true);
  });

  it('requires a positive generation and game/scope identity', () => {
    const realm = new PackRuntimeRealm();
    expect(() => realm.beginBind(binding('game-a', 0), ['/games/a'])).toThrow(
      'positive safe integer',
    );
    expect(() => realm.beginBind({ ...binding('game-a', 1), gameId: '' }, ['/games/a'])).toThrow(
      'gameId and scopeId are required',
    );
  });
});
