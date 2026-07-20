// texture-status.ts — per-texture degradation matrix for TextureViewer.
//
// Pure function (zero GPU, zero React). Maps a set of texture descriptors
// from a selected draw to per-texture status: ok | no-rt | no-webgpu | error.
//
// Degradation rules (research Finding 9):
//   - depth24plus / depth24plus-stencil8: opaque format, copyTextureToBuffer
//     forbidden in both directions -> status 'error'.
//   - no WebGPU available -> all textures status 'no-webgpu'.
//   - depth32float / depth16unorm / color formats: copy allowed -> status 'ok'.
//
// AC-18: a single texture in error status does not contaminate others.
//
// Related: plan-strategy D-4; research Finding 9/12; requirements AC-18.

export type TextureStatus = 'ok' | 'no-rt' | 'no-webgpu' | 'error';

/** A minimal texture descriptor for status computation. */
export interface TextureDescriptor {
  readonly handleId: string;
  readonly format: string;
  readonly usage?: number;
}

export interface TextureStatusEntry {
  readonly handleId: string;
  readonly status: TextureStatus;
  readonly format: string;
}

const NON_COPYABLE_DEPTH_FORMATS = new Set(['depth24plus', 'depth24plus-stencil8']);

/**
 * Compute per-texture status for a set of texture attachments.
 *
 * Each texture gets an independent status. A single texture in error
 * does not affect others (isolation per AC-18).
 *
 * @param textures - Textures attached to the selected draw.
 * @param webgpuAvailable - Whether the browser has WebGPU (default true).
 * @returns Array of status entries, one per input texture descriptor.
 */
export function computeTextureStatus(
  textures: readonly TextureDescriptor[],
  webgpuAvailable = true,
): readonly TextureStatusEntry[] {
  return textures.map((tex) => {
    let status: TextureStatus;

    if (!webgpuAvailable) {
      status = 'no-webgpu';
    } else if (NON_COPYABLE_DEPTH_FORMATS.has(tex.format)) {
      status = 'error';
    } else {
      status = 'ok';
    }

    return {
      handleId: tex.handleId,
      status,
      format: tex.format,
    };
  });
}
