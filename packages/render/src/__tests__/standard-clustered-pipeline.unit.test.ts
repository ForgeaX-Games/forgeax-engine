import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolvePostColorDomainContract } from '../render-pipeline';

const clusteredSource = readFileSync(
  new URL('../pipeline/standard-pipeline.ts', import.meta.url),
  'utf8',
);
const frameSource = readFileSync(new URL('../record/frame.ts', import.meta.url), 'utf8');

describe('Standard clustered post color-domain order', () => {
  it('keeps transparent and bloom work in linear HDR before tone output', () => {
    const stages = resolvePostColorDomainContract('linear-hdr');
    expect(stages).toContainEqual(['transparent-blend', 'linear-hdr', 'linear-hdr']);
    expect(stages).toContainEqual(['bloom', 'linear-hdr', 'linear-hdr']);
    expect(stages).toContainEqual(['tone', 'linear-hdr', 'linear-ldr']);
    expect(stages).toContainEqual(['output', 'linear-ldr', 'display-encoded']);
    expect(stages.findIndex(([name]) => name === 'tone')).toBeGreaterThan(
      stages.findIndex(([name]) => name === 'bloom'),
    );
  });

  it('keeps the real Standard producer and record owner as one provenance chain', () => {
    expect(clusteredSource).toContain("graph.addComputePass('cluster-membership-producer'");
    expect(frameSource).toContain('internals.device.caps?.compute === true,');
    expect(clusteredSource).toContain('pass.dispatchWorkgroups(');
  });
});
