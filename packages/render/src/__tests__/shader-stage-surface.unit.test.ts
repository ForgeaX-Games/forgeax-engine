import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GPU_SHADER_STAGE_COMPUTE,
  GPU_SHADER_STAGE_FRAGMENT,
  GPU_SHADER_STAGE_VERTEX,
} from '../gpu-stage';

const ownerSource = readFileSync(new URL('../gpu-stage.ts', import.meta.url), 'utf8');
const computeConsumerSources = [
  readFileSync(new URL('../hdrp-buffers.ts', import.meta.url), 'utf8'),
];
const fragmentConsumerSources = [
  readFileSync(new URL('../pbr-pipeline.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../ibl/IblPipelineCache.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../ibl/skylight-bind-group.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../assembly/factory.ts', import.meta.url), 'utf8'),
];

describe('shader stage owner', () => {
  it('keeps the three shader stage bits in one owner', () => {
    expect(GPU_SHADER_STAGE_VERTEX).toBe(0x1);
    expect(GPU_SHADER_STAGE_FRAGMENT).toBe(0x2);
    expect(GPU_SHADER_STAGE_COMPUTE).toBe(0x4);
    expect(ownerSource.match(/export const GPU_SHADER_STAGE_/g)).toHaveLength(3);
  });

  it('routes render visibility consumers through the owner', () => {
    for (const source of [...computeConsumerSources, ...fragmentConsumerSources]) {
      expect(source).toContain('gpu-stage');
      expect(source).not.toMatch(/const GPU_SHADER_STAGE_(VERTEX|FRAGMENT|COMPUTE)\s*=/);
      expect(source).not.toMatch(/visibility:\s*0x[124]/);
    }
    for (const source of fragmentConsumerSources) {
      expect(source).toContain('GPU_SHADER_STAGE_FRAGMENT');
    }
    for (const source of computeConsumerSources) {
      expect(source).toContain('GPU_SHADER_STAGE_COMPUTE');
    }
    expect(fragmentConsumerSources[0]).toContain('GPU_SHADER_STAGE_VERTEX');
    expect(fragmentConsumerSources[1]).toContain('GPU_SHADER_STAGE_VERTEX');
  });
});
