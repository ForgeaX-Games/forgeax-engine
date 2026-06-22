// @forgeax/engine-state -- setNextState / getState / getPreviousState unit tests (M2 / m2w3)
//
// Covers: setNextState success path, setNextStateForce, AC-03 invalid-variant
// error, state-not-registered error, getState/getPreviousState, same-variant
// overwrite semantics, multiple consecutive calls.
//
// Decision anchors:
// - requirements AC-02: transition flips State / PreviousState (this test only
//   verifies setNextState writes NextState; full transition tested in M3)
// - requirements AC-03: both error codes verified with correct .detail
// - requirements C-3: setNextState returns Result.err, not throw
// - requirements C-4: free functions, not world.x methods

import { describe, expect, it } from 'vitest';
import { World } from '@forgeax/engine-ecs';
import { defineState } from '../src/define-state';
import { stateResourceKey, nextStateResourceKey, previousStateResourceKey } from '../src/resources';
import type { StateError } from '../src/errors';
import { registerStatesPlugin } from '../src/register-plugin';
import { setNextState, setNextStateForce, getState, getPreviousState } from '../src/set-next-state';
import type { Result } from '@forgeax/engine-types';

const MyState = defineState('MyState', ['idle', 'running', 'paused'] as const);

function makeWorldWithPlugin(): World {
  const world = new World();
  registerStatesPlugin(world);
  return world;
}

describe('setNextState', () => {
  it('writes NextState Resource on valid variant', () => {
    const world = makeWorldWithPlugin();
    const result = setNextState(world, MyState, 'running');

    expect(result.ok).toBe(true);

    const nsKey = nextStateResourceKey(MyState);
    const ns = world.getResource<{ value: number; force: boolean }>(nsKey);
    expect(ns.value).toBe(1); // 'running' = idx 1
    expect(ns.force).toBe(false);
  });

  it('returns Result.err with code=invalid-variant when variant does not exist in token', () => {
    const world = makeWorldWithPlugin();

    // @ts-expect-error - 'invalid-variant' is not a valid MyState variant
    const result = setNextState(world, MyState, 'nonexistent');

    expect(result.ok).toBe(false);
    const err = result.error as StateError;
    expect(err.code).toBe('invalid-variant');
    expect(err.detail).toHaveProperty('name', 'MyState');
    expect(err.detail).toHaveProperty('got', 'nonexistent');
    expect(err.detail).toHaveProperty('valid');
    expect((err.detail as Record<string, unknown>).valid).toContain('idle');
    expect((err.detail as Record<string, unknown>).valid).toContain('running');
    expect((err.detail as Record<string, unknown>).valid).toContain('paused');
  });

  it('returns Result.err with code=state-not-registered when plug-in not called', () => {
    const world = new World();
    // No registerStatesPlugin call

    const result = setNextState(world, MyState, 'idle');

    expect(result.ok).toBe(false);
    const err = result.error as StateError;
    expect(err.code).toBe('state-not-registered');
    expect(err.detail).toHaveProperty('name', 'MyState');
  });

  it('last write wins on multiple consecutive setNextState calls', () => {
    const world = makeWorldWithPlugin();

    setNextState(world, MyState, 'running');
    setNextState(world, MyState, 'paused');
    // Both calls succeed; last write wins

    const nsKey = nextStateResourceKey(MyState);
    const ns = world.getResource<{ value: number; force: boolean }>(nsKey);
    expect(ns.value).toBe(2); // 'paused' = idx 2
    expect(ns.force).toBe(false);
  });
});

describe('setNextStateForce', () => {
  it('writes NextState Resource with force=true', () => {
    const world = makeWorldWithPlugin();
    const result = setNextStateForce(world, MyState, 'running');

    expect(result.ok).toBe(true);

    const nsKey = nextStateResourceKey(MyState);
    const ns = world.getResource<{ value: number; force: boolean }>(nsKey);
    expect(ns.value).toBe(1); // 'running' = idx 1
    expect(ns.force).toBe(true);
  });

  it('returns Result.err with code=invalid-variant for bad variant', () => {
    const world = makeWorldWithPlugin();

    // @ts-expect-error - 'nonexistent' is not a valid variant
    const result = setNextStateForce(world, MyState, 'nonexistent');

    expect(result.ok).toBe(false);
    const err = result.error as StateError;
    expect(err.code).toBe('invalid-variant');
  });
});

describe('getState', () => {
  it('returns the current State value from the State Resource', () => {
    const world = makeWorldWithPlugin();

    // Default is 'idle' (idx 0)
    const result = getState(world, MyState);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('idle');
    }
  });

  it('returns Result.err with code=state-not-registered when plug-in not called', () => {
    const world = new World();

    const result = getState(world, MyState);

    expect(result.ok).toBe(false);
    const err = result.error as StateError;
    expect(err.code).toBe('state-not-registered');
  });
});

describe('getPreviousState', () => {
  it('returns the PreviousState value', () => {
    const world = makeWorldWithPlugin();

    // Default prev = 'idle' (idx 0)
    const result = getPreviousState(world, MyState);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('idle');
    }
  });

  it('returns Result.err with code=state-not-registered when plug-in not called', () => {
    const world = new World();

    const result = getPreviousState(world, MyState);
    expect(result.ok).toBe(false);
    const err = result.error as StateError;
    expect(err.code).toBe('state-not-registered');
  });
});

describe('same-variant write', () => {
  it('setNextState with current value writes NextState (overwrite semantics)', () => {
    const world = makeWorldWithPlugin();
    // Current State = 'idle' (default). setNextState with 'idle' still writes NextState.
    const result = setNextState(world, MyState, 'idle');

    expect(result.ok).toBe(true);

    const nsKey = nextStateResourceKey(MyState);
    const ns = world.getResource<{ value: number; force: boolean }>(nsKey);
    expect(ns.value).toBe(0); // 'idle' = idx 0
    expect(ns.force).toBe(false);
  });
});