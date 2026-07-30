import { describe, expect, it } from 'vitest';
import {
  type MaterialCookReceipt,
  serializeMaterialCookReceipt,
} from '../evidence/material-cook.js';

describe('material cook receipt', () => {
  it('serializes source closure, profile, version, and output digest stably', () => {
    const receipt: MaterialCookReceipt = {
      sourceClosure: ['b.wgsl', 'a.material.json'],
      profile: 'webgpu/v1',
      compilerVersion: 'compiler/1',
      inputDigest: 'sha256:input',
      outputDigest: 'sha256:output',
    };

    expect(serializeMaterialCookReceipt(receipt)).toBe(
      serializeMaterialCookReceipt({ ...receipt, sourceClosure: ['a.material.json', 'b.wgsl'] }),
    );
  });
});
