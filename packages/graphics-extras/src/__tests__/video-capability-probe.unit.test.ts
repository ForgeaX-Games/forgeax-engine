// feat-20260623-world-space-video-asset M4 / w17 — AC-09 capability probe.
//
// AC-09 / D-2: the high-perf GPUExternalTexture upload path is left in place as
// an EXPLICIT, grep-able capability-probe branch (not a TODO comment); the
// general copyExternalImageToTexture path is the one actually wired (w16). This
// test pins the probe's truth table + the source-level guarantee that the
// reserved hook is a real code branch keyed on backendKind +
// importExternalTexture presence.
//
// OOS-5: the high-perf upload body is intentionally NOT implemented; the probe
// returns false for every device the engine produces today (no RHI exposes
// `importExternalTexture`). The probe flips on automatically the day a future
// feat adds that entry point on a WebGPU backend.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { probeVideoHighPerfUpload, type VideoCapabilityDevice } from '../video-player-system';

const SYS_SRC = fileURLToPath(new URL('../video-player-system.ts', import.meta.url));

describe('AC-09 — probeVideoHighPerfUpload truth table (M4 / w17)', () => {
  it('returns false when no device is wired', () => {
    expect(probeVideoHighPerfUpload(undefined)).toBe(false);
  });

  it('returns false on a WebGPU backend without importExternalTexture (today, OOS-5)', () => {
    const device: VideoCapabilityDevice = { caps: { backendKind: 'webgpu' } };
    expect(probeVideoHighPerfUpload(device)).toBe(false);
  });

  it('returns false on non-WebGPU backends even if importExternalTexture existed', () => {
    const native: VideoCapabilityDevice = {
      caps: { backendKind: 'wgpu-native' },
      importExternalTexture: () => undefined,
    };
    const webgl2: VideoCapabilityDevice = {
      caps: { backendKind: 'wgpu-webgl2' },
      importExternalTexture: () => undefined,
    };
    expect(probeVideoHighPerfUpload(native)).toBe(false);
    expect(probeVideoHighPerfUpload(webgl2)).toBe(false);
  });

  it('returns true ONLY when a WebGPU backend exposes importExternalTexture (future hook)', () => {
    // Simulates the day a future feat lands the RHI entry point. Proves the
    // reserved branch is live (not dead code) and flips on without touching the
    // call sites — the AC-09 "two paths left in place" guarantee.
    const future: VideoCapabilityDevice = {
      caps: { backendKind: 'webgpu' },
      importExternalTexture: () => undefined,
    };
    expect(probeVideoHighPerfUpload(future)).toBe(true);
  });
});

describe('AC-09 — reserved high-perf hook is an explicit code branch (M4 / w17)', () => {
  it('the probe source references GPUExternalTexture import as a real condition, not a comment', () => {
    const src = readFileSync(SYS_SRC, 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Executable code (comments stripped) must test importExternalTexture
    // presence and gate on the WebGPU backend — the grep-able two-path boundary.
    expect(stripped.includes('importExternalTexture')).toBe(true);
    expect(stripped.includes('backendKind')).toBe(true);
  });
});
