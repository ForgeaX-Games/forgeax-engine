import { uuidv7obj } from 'uuidv7';
import { PackError } from './errors.js';

/**
 * 16-byte UUID branded ABI. Prevents assignment from plain Uint8Array or string.
 * Brand field mirrors the declaration in @forgeax/engine-types for cross-package
 * structural compatibility (both use __guidBrand: 'AssetGuid').
 */
export type AssetGuid = Uint8Array & { readonly __guidBrand: 'AssetGuid' };

/** Minimal Result alias for this module (structurally compatible with ScanResult). */
export type GuidResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

function brand(bytes: Uint8Array): AssetGuid {
  return bytes as AssetGuid;
}

const HEX_BYTE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function bytesToDashForm(bytes: Uint8Array): string {
  const h = HEX_BYTE;
  // biome-ignore lint/style/noNonNullAssertion: length guaranteed 16
  return `${h[bytes[0]!]}${h[bytes[1]!]}${h[bytes[2]!]}${h[bytes[3]!]}-${h[bytes[4]!]}${h[bytes[5]!]}-${h[bytes[6]!]}${h[bytes[7]!]}-${h[bytes[8]!]}${h[bytes[9]!]}-${h[bytes[10]!]}${h[bytes[11]!]}${h[bytes[12]!]}${h[bytes[13]!]}${h[bytes[14]!]}${h[bytes[15]!]}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dashFormToBytes(dashForm: string): Uint8Array {
  const hex = dashForm.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Utilities for the AssetGuid branded 16-byte UUID type.
 * Declare the type via `import type { AssetGuid } from '@forgeax/engine-pack/guid'`
 * or `import type { AssetGuid } from '@forgeax/engine-types'`.
 */
export const AssetGuid = {
  /**
   * Parse a 36-char RFC 4122 dash-form UUID string into an AssetGuid.
   * Returns Ok(AssetGuid) on success or Err(PackError) with code 'pack-guid-malformed' on failure.
   * Never throws for expected failures (requirements §4.2 / §14 / charter proposition 4).
   */
  parse(dashForm: string): GuidResult<AssetGuid, PackError> {
    if (!UUID_RE.test(dashForm)) {
      return {
        ok: false,
        error: new PackError({
          code: 'pack-guid-malformed',
          expected: '36-char RFC 4122 dash-form UUID',
          hint: 'use AssetGuid.random() or a UUIDv7 generator; all GUID fields must be 36-char RFC 4122 dash-form',
          detail: {
            raw: dashForm,
            reason: 'expected 36-char RFC 4122 dash-form UUID',
          },
        }),
      };
    }
    return { ok: true, value: brand(dashFormToBytes(dashForm)) };
  },

  /**
   * Format an AssetGuid as a 36-char RFC 4122 lowercase dash-form string.
   */
  format(guid: AssetGuid): string {
    return bytesToDashForm(guid);
  },

  /**
   * Test byte-by-byte equality between two AssetGuids.
   */
  equals(a: AssetGuid, b: AssetGuid): boolean {
    for (let i = 0; i < 16; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  },

  /**
   * Mint a new time-ordered UUIDv7 as an AssetGuid.
   * Works in both Node.js and browser environments.
   */
  random(): AssetGuid {
    const uuid = uuidv7obj();
    const bytes = new Uint8Array(16);
    bytes.set(uuid.bytes);
    return brand(bytes);
  },
} as const;
