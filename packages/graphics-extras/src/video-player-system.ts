// @forgeax/engine-graphics-extras — video high-perf upload capability probe
// (feat-20260623-world-space-video-asset M4 / w17).
//
// The single per-frame video upload path lives in the record stage
// (`render-system-record.ts` `videoTextureView`): it reads the host-registered
// VideoElementProvider (World Resource, D-1), uploads the current frame via
// `DynamicTextureStore.uploadFrame` (copyExternalImageToTexture), and fires the
// structured `VideoUploadUnsupportedError` on the engine error channel when a
// VideoPlayer entity can reach NEITHER the general path (no host element) NOR
// the high-perf path (AC-10 double-miss, charter P3). There is exactly ONE video
// upload/failure path — this module only contributes the capability probe the
// record stage consults to decide whether the reserved high-perf branch is
// available.
//
// Decision anchors:
//   - requirements AC-09 (two paths left in place, capability probe explicit).
//   - plan-strategy D-2 (grep-able capability branch, not a TODO).

/**
 * Minimal device shape the high-perf capability probe inspects: the backend
 * kind plus the (currently-absent) `importExternalTexture` method. Declared
 * structurally so the probe stays decoupled from the full RhiDevice surface and
 * unit tests drive it with a small object.
 */
export interface VideoCapabilityDevice {
  readonly caps: { readonly backendKind: 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null' };
  /**
   * The WebGPU zero-copy video import entry point. forgeax exposes NO such RHI
   * method today (research Finding 4 confirmed `importExternalTexture` grep=0),
   * so this is always `undefined` — the probe's presence check is the explicit,
   * grep-able boundary between the general path and the reserved high-perf path
   * (D-2 / AC-09; OOS-5 keeps the upload body unimplemented).
   */
  readonly importExternalTexture?: unknown;
}

/**
 * AC-09 / D-2 capability probe: decide whether the high-perf zero-copy
 * GPUExternalTexture upload path is available for video this frame. This is the
 * EXPLICIT reserved hook the AC-09 "two paths left in place" acceptance is
 * checked against by code review — it is a real, grep-able code branch, not a
 * TODO comment.
 *
 * The high-perf path requires BOTH a WebGPU backend (GPUExternalTexture is a
 * browser-WebGPU feature) AND the RHI exposing an `importExternalTexture` entry
 * point. The latter does not exist in forgeax today (OOS-5: importing the
 * external texture + a `texture_external` MaterialParamType + WGSL external
 * sampling is out of scope), so this probe ALWAYS returns false and the general
 * `copyExternalImageToTexture` path (record stage) is the sole route end-to-end.
 * The day a future feat lands `importExternalTexture`, this probe flips on for
 * WebGPU backends without touching the call sites.
 */
export function probeVideoHighPerfUpload(device: VideoCapabilityDevice | undefined): boolean {
  if (device === undefined) return false;
  // GPUExternalTexture is browser-WebGPU only (wgpu-native / wgpu-webgl2 lack it).
  if (device.caps.backendKind !== 'webgpu') return false;
  // Reserved high-perf hook: available only when the RHI exposes the import
  // entry point. It is absent today (OOS-5), so this is the false-returning
  // boundary the AC-09 two-path code review verifies.
  return typeof device.importExternalTexture === 'function';
}
