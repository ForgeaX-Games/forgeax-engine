import type { AssetGuid } from './guid.js';
import { AssetGuid as AssetGuidNS } from './guid.js';

/**
 * ForgeaX engine namespace UUID for UUIDv5 derivation.
 * Value: 9a09805a-7623-482e-b322-9fc3591f2a38
 * This is a custom namespace; it is intentionally NOT the RFC 4122 X.500 namespace.
 */
const _nsResult = AssetGuidNS.parse('9a09805a-7623-482e-b322-9fc3591f2a38');
if (!_nsResult.ok) throw new Error('builtin: FORGEAX_NAMESPACE is not a valid UUID');
export const FORGEAX_NAMESPACE: AssetGuid = _nsResult.value;

/**
 * Derive a stable UUIDv5 AssetGuid from a name within the ForgeaX namespace.
 * Uses SHA-1 via Node.js `node:crypto` or Web Crypto API (RFC 4122 §4.3).
 * Deterministic: same name always produces the same bytes.
 */
export async function deriveBuiltin(name: string): Promise<AssetGuid> {
  const nsBytes = FORGEAX_NAMESPACE;
  const nameBytes = new TextEncoder().encode(name);

  // Concatenate namespace bytes + name bytes for SHA-1 digest
  const concat = new Uint8Array(16 + nameBytes.length);
  concat.set(nsBytes, 0);
  concat.set(nameBytes, 16);

  let hashBytes: Uint8Array;

  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle !== undefined) {
    // Browser / Web Crypto path
    const buffer = await globalThis.crypto.subtle.digest('SHA-1', concat);
    hashBytes = new Uint8Array(buffer);
  } else {
    // Node.js path
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha1');
    hash.update(concat);
    hashBytes = hash.digest();
  }

  // RFC 4122 §4.3: assemble UUIDv5 from first 16 bytes of SHA-1 digest
  const uuidBytes = new Uint8Array(16);
  uuidBytes.set(hashBytes.subarray(0, 16));

  // Set version bits: byte 6, high nibble = 0x5 (version 5)
  // biome-ignore lint/style/noNonNullAssertion: uuidBytes is 16 bytes
  uuidBytes[6] = (uuidBytes[6]! & 0x0f) | 0x50;
  // Set variant bits: byte 8, high 2 bits = 0b10
  // biome-ignore lint/style/noNonNullAssertion: uuidBytes is 16 bytes
  uuidBytes[8] = (uuidBytes[8]! & 0x3f) | 0x80;

  return uuidBytes as AssetGuid;
}

function formatSync(bytes: Uint8Array): string {
  return AssetGuidNS.format(bytes as AssetGuid);
}

async function deriveSync(name: string): Promise<string> {
  return formatSync(await deriveBuiltin(name));
}

/**
 * Pre-computed compile-time constant for the HANDLE_CUBE builtin GUID.
 * Derived from: deriveBuiltin('HANDLE_CUBE') under FORGEAX_NAMESPACE.
 */
export const BUILTIN_HANDLE_CUBE = await deriveSync('HANDLE_CUBE');

/**
 * Pre-computed compile-time constant for the HANDLE_TRIANGLE builtin GUID.
 * Derived from: deriveBuiltin('HANDLE_TRIANGLE') under FORGEAX_NAMESPACE.
 */
export const BUILTIN_HANDLE_TRIANGLE = await deriveSync('HANDLE_TRIANGLE');

/**
 * Pre-computed compile-time constant for the HANDLE_QUAD builtin GUID.
 * Derived from: deriveBuiltin('HANDLE_QUAD') under FORGEAX_NAMESPACE.
 */
export const BUILTIN_HANDLE_QUAD = await deriveSync('HANDLE_QUAD');
