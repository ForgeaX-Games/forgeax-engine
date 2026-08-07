import { describe, expect, it } from 'vitest';
import { captureIdleTimeoutMs } from '../recorder-core';

describe('captureIdleTimeoutMs', () => {
  it('keeps short captures on the existing 30-second floor', () => {
    expect(captureIdleTimeoutMs(1)).toBe(30_000);
    expect(captureIdleTimeoutMs(300)).toBe(30_000);
  });

  it('scales the wait budget for long captures', () => {
    expect(captureIdleTimeoutMs(3000)).toBe(150_000);
  });

  it('caps hostile or accidentally huge requests', () => {
    expect(captureIdleTimeoutMs(Number.POSITIVE_INFINITY)).toBe(30_000);
    expect(captureIdleTimeoutMs(10_000)).toBe(300_000);
  });
});
