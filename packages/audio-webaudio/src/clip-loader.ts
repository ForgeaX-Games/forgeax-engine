// clip-loader.ts -- M3 (w27) AudioClipAsset register/load path
//
// Load AudioClipAsset from pack-index catalog via fetch + decodeAudioData.
//
// Decision anchors:
// - plan-strategy D-6 (load path: fetch ArrayBuffer -> decodeAudioData -> register)
// - requirements AC-03 (AudioClipAsset via asset system loadByGuid)
// - requirements constraint 5 (format decided by browser decodeAudioData)
// - requirements E-2 (decodeAudioData failure returns Err with code: 'decode-failed')
// - requirements E-9 (nonexistent GUID returns Err with code 'asset-not-found')
// - research Finding 'decodeAudioData error semantics'
//
// charter awareness:
// - P3 explicit failure: returns Result<AudioClipAsset, AudioError> with structured errors
// - P4 consistent abstraction: parallel to image/gltf loader patterns

import { AudioError } from '@forgeax/engine-audio';
import { err, ok, type Result } from '@forgeax/engine-ecs';
import type { AudioClipAsset } from '@forgeax/engine-types';

/**
 * Load an AudioClipAsset from a pack-index entry.
 *
 * Path: fetch(relativeUrl) -> arrayBuffer() -> decodeAudioData(arrayBuffer) -> AudioClipAsset.
 *
 * Uses a temporary AudioContext for decoding (not the audio engine's context).
 * The decoded AudioBuffer is shared across all handles pointing to the same GUID.
 *
 * Returns:
 * - `Ok(AudioClipAsset)` on success
 * - `Err(AudioError)` with structured error codes:
 *   - `decode-failed`: decodeAudioData rejected (corrupt file or unsupported codec)
 *
 * @param guid Pack-index GUID of the audio asset (for error tracing)
 * @param relativeUrl HTTP path to the audio file (from PackIndexEntry.relativeUrl)
 */
export async function loadAudioClipByGuid(
  guid: string,
  relativeUrl: string,
): Promise<Result<AudioClipAsset, AudioError>> {
  // Step 1: fetch the audio file as ArrayBuffer
  let arrayBuffer: ArrayBuffer;
  try {
    const response = await fetch(relativeUrl);
    if (!response.ok) {
      return err(
        new AudioError({
          code: 'decode-failed',
          expected: `HTTP 200 for audio asset at ${relativeUrl}`,
          hint: `asset guid ${guid}: HTTP ${response.status} fetching ${relativeUrl}`,
          detail: {
            code: 'decode-failed' as const,
            reason: `HTTP ${response.status}: ${response.statusText}`,
          },
        }),
      );
    }
    arrayBuffer = await response.arrayBuffer();
  } catch (e) {
    return err(
      new AudioError({
        code: 'decode-failed',
        expected: `fetchable audio asset at ${relativeUrl}`,
        hint: `asset guid ${guid}: network error fetching ${relativeUrl}`,
        detail: {
          code: 'decode-failed' as const,
          reason: e instanceof Error ? e.message : 'fetch failed',
        },
      }),
    );
  }

  // Step 2: decode AudioBuffer via a temporary AudioContext
  try {
    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    await ctx.close();

    const asset: AudioClipAsset = {
      kind: 'audio',
      buffer,
    };

    return ok(asset);
  } catch (e) {
    return err(
      new AudioError({
        code: 'decode-failed',
        expected: 'decodeAudioData succeeds for valid audio file',
        hint: 'ensure the audio file is a valid wav/mp3/ogg/flac supported by the browser',
        detail: {
          code: 'decode-failed' as const,
          reason: e instanceof Error ? e.message : 'decodeAudioData failed',
        },
      }),
    );
  }
}
