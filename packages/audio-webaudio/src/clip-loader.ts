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

export async function decodeAudioClipBytes(
  guid: string,
  bytes: Uint8Array,
): Promise<Result<AudioClipAsset, AudioError>> {
  try {
    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    await ctx.close();
    return ok({ kind: 'audio', buffer });
  } catch (e) {
    return err(
      new AudioError({
        code: 'decode-failed',
        expected: `decodable audio artifact bytes for GUID ${guid}`,
        hint: 'verify the audio artifact mediaType and browser-supported codec',
        detail: {
          code: 'decode-failed' as const,
          reason: e instanceof Error ? e.message : 'audio artifact decode failed',
        },
      }),
    );
  }
}
