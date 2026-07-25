// @forgeax/engine-rhi-debug/src/replay-format — target-device format adaptation.

/**
 * Map recorded canvas formats to the byte-compatible formats used by offline
 * replay. Consumers that read a replay texture must decode these bytes as the
 * returned format, not as the original canvas format.
 */
export function adaptReplayFormat(format: string | undefined): string | undefined {
  if (format === 'bgra8unorm-srgb') return 'rgba8unorm-srgb';
  if (format === 'bgra8unorm') return 'rgba8unorm';
  return format;
}
