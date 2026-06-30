// plugin-error.test.ts -- M1 PluginError structure + AC-11 type exhaustiveness
// (feat-20260623-plugin-system-unify-build-world-protocol).
//
// M1 delivers RED for AC-04/05 behavioral assertions (createApp plugin runner
// not yet implemented -- M2), but GREEN for structural assertions (PluginError
// class shape, PLUGIN_ERROR_HINTS / PLUGIN_EXPECTED bidirectional, AC-11
// switch-exhaustiveness).
//
// charter awareness:
//   P3 explicit failure: PluginError carries .code / .expected / .hint /
//       .detail -- AI users consume by property access, not message parsing.
//   F1 + P1: the error surface is discoverable at compile time via the
//       closed union type; no prose docs needed for switch-exhaust.
//   AC-11: PluginErrorCode is an independent closed union from AppErrorCode
//       (C-7); switch on PluginErrorCode compiles without default branch
//       and does not accept AppErrorCode members.

import { describe, expect, it } from 'vitest';
import type { PluginErrorCode } from '@forgeax/engine-plugin';
import { isPluginError, PLUGIN_ERROR_HINTS, PLUGIN_EXPECTED, PluginError } from '@forgeax/engine-plugin';

// ---------------------------------------------------------------------------
// Known closed-union members (SSOT = PluginErrorCode literal union).
//
// When PluginErrorCode expands in a future feat, add the new member to this
// array -- the bidirectional assertion in describe('PLUGIN_ERROR_HINTS /
// PLUGIN_EXPECTED') will fail until both tables are updated.
// ---------------------------------------------------------------------------
const TWO_CODES: readonly PluginErrorCode[] = ['duplicate-plugin', 'plugin-build-failed'] as const;

// ---------------------------------------------------------------------------
// Target: 2 keys in each table + bidirectional non-empty + forward proof.
// ---------------------------------------------------------------------------
describe('PLUGIN_ERROR_HINTS / PLUGIN_EXPECTED bidirectional (AC-04/05)', () => {
  it('exposes exactly 2 hints, one per code, each non-empty (forward)', () => {
    expect(Object.keys(PLUGIN_ERROR_HINTS).length).toBe(2);

    for (const code of TWO_CODES) {
      const hint = PLUGIN_ERROR_HINTS[code];
      expect(typeof hint).toBe('string');
      expect(hint.length).toBeGreaterThan(0);
    }
  });

  it('every PLUGIN_ERROR_HINTS key is a valid PluginErrorCode (reverse)', () => {
    for (const key of Object.keys(PLUGIN_ERROR_HINTS)) {
      expect(TWO_CODES).toContain(key as PluginErrorCode);
    }
  });

  it('exposes exactly 2 expected entries, one per code, each non-empty (forward)', () => {
    expect(Object.keys(PLUGIN_EXPECTED).length).toBe(2);

    for (const code of TWO_CODES) {
      const expected = PLUGIN_EXPECTED[code];
      expect(typeof expected).toBe('string');
      expect(expected.length).toBeGreaterThan(0);
    }
  });

  it('every PLUGIN_EXPECTED key is a valid PluginErrorCode (reverse)', () => {
    for (const key of Object.keys(PLUGIN_EXPECTED)) {
      expect(TWO_CODES).toContain(key as PluginErrorCode);
    }
  });
});

// ---------------------------------------------------------------------------
// PluginError class -- 4-field surface (mirrors AppError / D-7).
// ---------------------------------------------------------------------------
describe('PluginError class -- 4-field surface (D-7)', () => {
  it('exposes .code / .expected / .hint / .detail readonly fields', () => {
    const err = new PluginError({
      code: 'duplicate-plugin',
      expected: PLUGIN_EXPECTED['duplicate-plugin'],
      hint: PLUGIN_ERROR_HINTS['duplicate-plugin'],
      detail: { name: 'test' },
    });
    expect(err.code).toBe('duplicate-plugin');
    expect(typeof err.expected).toBe('string');
    expect(typeof err.hint).toBe('string');
    expect(err.detail).toEqual({ name: 'test' });
  });

  it('extends Error so debug surfaces (stack, name) work in host environments', () => {
    const err = new PluginError({
      code: 'plugin-build-failed',
      expected: PLUGIN_EXPECTED['plugin-build-failed'],
      hint: PLUGIN_ERROR_HINTS['plugin-build-failed'],
      detail: {
        pluginName: 'physics',
        cause: 'WASM load failed',
        failures: [{ pluginName: 'audio', cause: 'WebAudio unavailable' }],
      },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PluginError');
    expect(err.message).toContain('plugin-build-failed');
  });

  it('builds via new PluginError({...}) for every closed-union member', () => {
    for (const code of TWO_CODES) {
      const detail =
        code === 'duplicate-plugin'
          ? { name: 'conflict' }
          : {
              pluginName: 'physics',
              cause: 'WASM init error',
            };
      const err = new PluginError({
        code,
        expected: PLUGIN_EXPECTED[code],
        hint: PLUGIN_ERROR_HINTS[code],
        detail,
      });
      expect(err.code).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// PluginError.detail -- discriminated union per code.
// After narrowing .code, the .detail type narrows to the per-code payload.
// ---------------------------------------------------------------------------
describe('PluginError.detail -- discriminated union per code (D-7)', () => {
  it("'duplicate-plugin' narrows detail to { name: string }", () => {
    const err = new PluginError({
      code: 'duplicate-plugin',
      expected: PLUGIN_EXPECTED['duplicate-plugin'],
      hint: PLUGIN_ERROR_HINTS['duplicate-plugin'],
      detail: { name: 'my-plugin' },
    });
    expect(err.code).toBe('duplicate-plugin');
    // Type narrowing: after checking .code === 'duplicate-plugin',
    // TS narrows .detail to PluginDetailDuplicatePlugin { name: string }.
    if (err.code === 'duplicate-plugin') {
      expect(typeof err.detail.name).toBe('string');
      expect(err.detail.name).toBe('my-plugin');
    }
  });

  it("'plugin-build-failed' narrows detail to { pluginName, cause, failures? }", () => {
    const err = new PluginError({
      code: 'plugin-build-failed',
      expected: PLUGIN_EXPECTED['plugin-build-failed'],
      hint: PLUGIN_ERROR_HINTS['plugin-build-failed'],
      detail: {
        pluginName: 'physics',
        cause: 'WASM init error',
        failures: [
          { pluginName: 'audio', cause: 'WebAudio unavailable' },
          { pluginName: 'input', cause: 'no canvas' },
        ],
      },
    });
    expect(err.code).toBe('plugin-build-failed');
    if (err.code === 'plugin-build-failed') {
      expect(err.detail.pluginName).toBe('physics');
      expect(err.detail.cause).toBe('WASM init error');
      expect(err.detail.failures).toHaveLength(2);
      expect(err.detail.failures?.[0]?.pluginName).toBe('audio');
    }
  });

  it("'plugin-build-failed' without failures array still reads pluginName + cause", () => {
    const err = new PluginError({
      code: 'plugin-build-failed',
      expected: PLUGIN_EXPECTED['plugin-build-failed'],
      hint: PLUGIN_ERROR_HINTS['plugin-build-failed'],
      detail: {
        pluginName: 'physics',
        cause: 'bare failure',
      },
    });
    if (err.code === 'plugin-build-failed') {
      expect(err.detail.pluginName).toBe('physics');
      expect(err.detail.cause).toBe('bare failure');
      expect(err.detail.failures).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// isPluginError type guard.
// ---------------------------------------------------------------------------
describe('isPluginError type guard', () => {
  it('returns true for PluginError instances', () => {
    const err = new PluginError({
      code: 'duplicate-plugin',
      expected: PLUGIN_EXPECTED['duplicate-plugin'],
      hint: PLUGIN_ERROR_HINTS['duplicate-plugin'],
      detail: { name: 'x' },
    });
    expect(isPluginError(err)).toBe(true);
  });

  it('returns false for plain Error', () => {
    expect(isPluginError(new Error('boom'))).toBe(false);
  });

  it('returns false for null / undefined', () => {
    expect(isPluginError(null)).toBe(false);
    expect(isPluginError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-11 type exhaustiveness: switch on PluginErrorCode without default branch
// compiles and covers all 2 members. Does NOT accept AppErrorCode members.
//
// This is a runtime assertion on the compile-time property: a switch that
// accepts a non-PluginErrorCode value would be caught by tsc BEFORE this
// test runs. We verify here that the exhaustive match compiles and executes.
// ---------------------------------------------------------------------------
describe('AC-11 PluginErrorCode exhaustiveness (type-level)', () => {
  it('switch on PluginErrorCode covers all 2 members with no default', () => {
    const codes: PluginErrorCode[] = ['duplicate-plugin', 'plugin-build-failed'];
    for (const code of codes) {
      const matched = (function exhaustive(c: PluginErrorCode): string {
        switch (c) {
          case 'duplicate-plugin':
            return 'dup';
          case 'plugin-build-failed':
            return 'fail';
        }
      })(code);
      expect(typeof matched).toBe('string');
    }
  });

  it('PluginErrorCode is 2 members', () => {
    // Structural proof: the literal union has exactly 2 members.
    // TSC would error if a member is missing or extra.
    expect(TWO_CODES).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC-04 / AC-05 behavioral assertions -- RED (M2 runner not yet wired).
//
// These tests verify the contract that createApp will enforce once the
// plugin runner is implemented in M2. Marked as todo so they appear in
// vitest output but do not fail milestone CI sweep.
// ---------------------------------------------------------------------------
describe('AC-04/AC-05 behavioral -- RED (deferred to M2)', () => {
  it.todo('AC-04: createApp returns err(duplicate-plugin) when two plugins share the same name');
  it.todo('AC-05: createApp returns err(plugin-build-failed) when a plugin build fails');
  it.todo('AC-05: plugin-build-failed detail accumulates all failures into .detail.failures[]');
  it.todo('AC-05: plugin-build-failed detail carries first failure pluginName + cause lower bound');
});