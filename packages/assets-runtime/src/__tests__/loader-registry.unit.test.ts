// @forgeax/engine-assets-runtime -- LoaderRegistry coverage (fix issue #709).
// register/get/registeredKinds with fail-fast + last-write-wins semantics.

import type { Loader } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { LoaderRegistry } from '../loader-registry';

function loader(kind: string): Loader<unknown> {
  return { kind, load: async () => ({ ok: true, value: undefined }) } as unknown as Loader<unknown>;
}

describe('LoaderRegistry', () => {
  it('registers and looks up a loader by kind', () => {
    const reg = new LoaderRegistry();
    const mesh = loader('mesh');
    reg.register(mesh);
    expect(reg.get('mesh')).toBe(mesh);
  });

  it('get returns undefined for an unregistered kind', () => {
    expect(new LoaderRegistry().get('nope')).toBeUndefined();
  });

  it('registeredKinds returns the kinds in insertion order', () => {
    const reg = new LoaderRegistry();
    reg.register(loader('mesh'));
    reg.register(loader('material'));
    reg.register(loader('scene'));
    expect(reg.registeredKinds()).toEqual(['mesh', 'material', 'scene']);
  });

  it('is idempotent on a repeated kind (last write wins, no throw)', () => {
    const reg = new LoaderRegistry();
    reg.register(loader('mesh'));
    const second = loader('mesh');
    reg.register(second);
    expect(reg.get('mesh')).toBe(second);
    expect(reg.registeredKinds()).toEqual(['mesh']);
  });

  it('throws TypeError when kind is an empty string', () => {
    expect(() => new LoaderRegistry().register(loader(''))).toThrow(TypeError);
  });

  it('throws TypeError when load is not a function', () => {
    const bad = { kind: 'mesh', load: 123 } as unknown as Loader<unknown>;
    expect(() => new LoaderRegistry().register(bad)).toThrow(TypeError);
  });
});
