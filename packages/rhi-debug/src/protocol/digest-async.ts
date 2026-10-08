import { bytesToHex } from '@noble/hashes/utils.js';

/** WebCrypto SHA-256; yields so bounded capture cancellation can run during large seeds. */
export async function digestBytesAsync(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${bytesToHex(new Uint8Array(hash))}`;
}
