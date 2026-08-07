import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GPU_SHADER_STAGE_COMPUTE,
  GPU_SHADER_STAGE_FRAGMENT,
  GPU_SHADER_STAGE_VERTEX,
} from '../gpu-stage';

const ownerSource = readFileSync(new URL('../gpu-stage.ts', import.meta.url), 'utf8');
const consumerSources = [
  readFileSync(new URL('../hdrp-buffers.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../pbr-pipeline.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../ibl/IblPipelineCache.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../ibl/skylight-bind-group.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../pipeline-spec.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../renderer/renderer-factory.ts', import.meta.url), 'utf8'),
];

describe('shader stage owner', () => {
  it('keeps the three shader stage bits in one owner', () => {
    expect(GPU_SHADER_STAGE_VERTEX).toBe(0x1);
    expect(GPU_SHADER_STAGE_FRAGMENT).toBe(0x2);
    expect(GPU_SHADER_STAGE_COMPUTE).toBe(0x4);
    expect(ownerSource.match(/export const GPU_SHADER_STAGE_/g)).toHaveLength(3);
  });

  it('routes render visibility consumers through the owner', () => {
    for (const source of consumerSources) {
      expect(source).toContain('GPU_SHADER_STAGE_FRAGMENT');
      expect(source).not.toMatch(/const GPU_SHADER_STAGE_(VERTEX|FRAGMENT|COMPUTE)\s*=/);
      expect(source).not.toMatch(/visibility:\s*0x[124]/);
    }
    expect(consumerSources[0]).toContain('GPU_SHADER_STAGE_COMPUTE');
    expect(consumerSources[0]).toContain('GPU_SHADER_STAGE_VERTEX');
    expect(consumerSources[1]).toContain('GPU_SHADER_STAGE_VERTEX');
    expect(consumerSources[2]).toContain('GPU_SHADER_STAGE_VERTEX');
  });
});
