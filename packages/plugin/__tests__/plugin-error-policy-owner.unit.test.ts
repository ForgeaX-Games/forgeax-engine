import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  PLUGIN_ERROR_HINTS,
  PLUGIN_EXPECTED,
  PluginError,
  type PluginErrorCode,
  type PluginError as PluginErrorType,
  type PluginErrorDetailFor,
} from '../src/index';

// These witnesses are test oracles for the shipped contract, not production authority.
const CODES_IN_POLICY_ORDER = [
  'duplicate-plugin',
  'plugin-build-failed',
] as const satisfies readonly PluginErrorCode[];

const EXPECTED_IN_POLICY_ORDER = [
  'each plugin name must be unique within the merged plugins list',
  'every plugin.build(world) call must return Result.ok',
] as const;

const HINTS_IN_POLICY_ORDER = [
  'remove or rename the duplicate plugin; check both default and user-provided plugins for name collisions',
  'inspect detail.failures for the complete failure list; check each plugin build implementation for missing resources or invalid world state',
] as const;

describe('PluginError policy owner', () => {
  it('projects the exact two-code surface with stable own-key order and enumerability', () => {
    expect(CODES_IN_POLICY_ORDER).toHaveLength(2);
    expect(new Set(CODES_IN_POLICY_ORDER).size).toBe(2);

    for (const policy of [PLUGIN_EXPECTED, PLUGIN_ERROR_HINTS]) {
      expect(Object.keys(policy)).toEqual(CODES_IN_POLICY_ORDER);
      expect(Object.getOwnPropertyNames(policy)).toEqual(CODES_IN_POLICY_ORDER);
      expect(Object.getOwnPropertySymbols(policy)).toEqual([]);
      for (const code of CODES_IN_POLICY_ORDER) {
        expect(Object.prototype.propertyIsEnumerable.call(policy, code)).toBe(true);
      }
    }

    expect(Object.values(PLUGIN_EXPECTED)).toEqual(EXPECTED_IN_POLICY_ORDER);
    expect(Object.values(PLUGIN_ERROR_HINTS)).toEqual(HINTS_IN_POLICY_ORDER);
  });

  it('keeps every expected and hint string byte-identical', () => {
    for (const [index, code] of CODES_IN_POLICY_ORDER.entries()) {
      expect(PLUGIN_EXPECTED[code]).toBe(EXPECTED_IN_POLICY_ORDER[index]);
      expect(PLUGIN_ERROR_HINTS[code]).toBe(HINTS_IN_POLICY_ORDER[index]);
    }
  });

  it('preserves public record types and correlated PluginError construction', () => {
    expectTypeOf(PLUGIN_EXPECTED).toEqualTypeOf<Readonly<Record<PluginErrorCode, string>>>();
    expectTypeOf(PLUGIN_ERROR_HINTS).toEqualTypeOf<Readonly<Record<PluginErrorCode, string>>>();

    const duplicate = new PluginError({
      code: 'duplicate-plugin',
      expected: PLUGIN_EXPECTED['duplicate-plugin'],
      hint: PLUGIN_ERROR_HINTS['duplicate-plugin'],
      detail: { name: 'physics' },
    });
    expectTypeOf(duplicate).toEqualTypeOf<
      Extract<PluginErrorType, { readonly code: 'duplicate-plugin' }>
    >();
    expectTypeOf(duplicate.detail).toEqualTypeOf<PluginErrorDetailFor<'duplicate-plugin'>>();
    expect(duplicate.detail).toEqual({ name: 'physics' });

    const buildFailure = new PluginError({
      code: 'plugin-build-failed',
      expected: PLUGIN_EXPECTED['plugin-build-failed'],
      hint: PLUGIN_ERROR_HINTS['plugin-build-failed'],
      detail: { pluginName: 'physics', cause: 'WASM init error' },
    });
    expectTypeOf(buildFailure).toEqualTypeOf<
      Extract<PluginErrorType, { readonly code: 'plugin-build-failed' }>
    >();
    expectTypeOf(buildFailure.detail).toEqualTypeOf<PluginErrorDetailFor<'plugin-build-failed'>>();
    expect(buildFailure.detail).toEqual({
      pluginName: 'physics',
      cause: 'WASM init error',
    });
  });
});
