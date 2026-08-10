import { describe, expect, it } from 'vitest';
import { validateCaptureEnvelope } from '../../capture/named-capture';

describe('capture envelope contract', () => {
  it.each([
    ['missing hash', { capture: [0, 1], hash: '' }],
    ['missing config', { capture: [0, 1], hash: 'abc' }],
    ['fallback marked primary', { capture: [0, 1], hash: 'abc', config: {}, role: 'primary', renderer: 'webgl' }],
    ['same adapter read twice', { capture: [0, 1], hash: 'abc', config: {}, adapterId: 'same' }],
  ])('%s fails before numerical comparison', (_name, value) => {
    const result = validateCaptureEnvelope(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid envelope');
    expect(result.error.code).toMatch(/capture|provenance/);
  });
});
