import { describe, expect, it } from 'vitest';
import { canonicalizeLogicalPackage, type LogicalPackage } from '../package-finalizer.js';

const packageInput = (bytes: number[]): LogicalPackage => ({
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [
    {
      guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
      kind: 'texture',
      payload: { width: 2, height: 2 },
      refs: [],
      artifacts: {
        pixels: { mediaType: 'application/octet-stream', bytes: new Uint8Array(bytes) },
      },
    },
  ],
});

describe('canonical pack projection', () => {
  it('excludes environment locator and finalized path', () => {
    expect(canonicalizeLogicalPackage(packageInput([1, 2]))).toBe(
      canonicalizeLogicalPackage(packageInput([1, 2])),
    );
  });

  it('retains logical payload and artifact byte changes', () => {
    expect(canonicalizeLogicalPackage(packageInput([1, 2]))).not.toBe(
      canonicalizeLogicalPackage(packageInput([1, 3])),
    );
  });
});
