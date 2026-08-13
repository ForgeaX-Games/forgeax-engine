import { readFileSync } from 'node:fs';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { isGpuMembershipProducerAvailable } from '../hdrp-pipeline';
import { createMembershipTiming } from '../record/membership-timing';
import { resolvePostColorDomainContract } from '../render-pipeline';

const hdrpSource = readFileSync(new URL('../hdrp-pipeline.ts', import.meta.url), 'utf8');
const frameSource = readFileSync(new URL('../record/frame.ts', import.meta.url), 'utf8');
const lightingSource = readFileSync(
  new URL('../record/frame-lighting.ts', import.meta.url),
  'utf8',
);
const targetsSource = readFileSync(new URL('../record/frame-targets.ts', import.meta.url), 'utf8');
const timingSource = readFileSync(
  new URL('../record/membership-timing.ts', import.meta.url),
  'utf8',
);

describe('HDRP post color-domain order', () => {
  it('selects the GPU membership producer only for a complete compute carrier', () => {
    expect(isGpuMembershipProducerAvailable(undefined, {}, {})).toBe(false);
    expect(isGpuMembershipProducerAvailable({ compute: false }, {}, {})).toBe(false);
    expect(isGpuMembershipProducerAvailable({ compute: true }, null, {})).toBe(false);
    expect(isGpuMembershipProducerAvailable({ compute: true }, {}, null)).toBe(false);
    expect(isGpuMembershipProducerAvailable({ compute: true }, {}, {})).toBe(true);
  });

  it('keeps transparent and bloom work in linear HDR before tone output', () => {
    const stages = resolvePostColorDomainContract('hdrp');
    expect(stages).toContainEqual(['transparent-blend', 'linear-hdr', 'linear-hdr']);
    expect(stages).toContainEqual(['bloom', 'linear-hdr', 'linear-hdr']);
    expect(stages).toContainEqual(['tone', 'linear-hdr', 'linear-ldr']);
    expect(stages).toContainEqual(['output', 'linear-ldr', 'display-encoded']);
    expect(stages.findIndex(([name]) => name === 'tone')).toBeGreaterThan(
      stages.findIndex(([name]) => name === 'bloom'),
    );
  });

  it('keeps the real HDRP producer and record owner as one provenance chain', () => {
    expect(hdrpSource).toContain("graph.addPass('cluster-membership-producer'");
    expect(hdrpSource).toContain('isGpuMembershipProducerAvailable(');
    expect(frameSource).toContain('internals.device.caps?.compute === true &&');
    expect(hdrpSource).toContain('beforeMembership()');
    expect(hdrpSource).toContain('timestampDescriptor');
    expect(hdrpSource).toContain('...timestampDescriptor');
    expect(hdrpSource).toContain('afterMembership(ctx.encoder)');
    expect(lightingSource).toContain('recordGpuMembershipSource({');
    expect(lightingSource).toContain('lightCount: effectiveLightCount');
    expect(lightingSource).toContain('grid: { x: gridX, y: gridY, z: gridZ }');
    expect(lightingSource).toContain('overflow,');
    expect(targetsSource).toContain('markEncodeFinished()');
    expect(targetsSource).toContain('markSubmitStarted()');
    expect(targetsSource).toContain('markSubmitted(cmd)');
    expect(timingSource).toContain("actualProducer: 'gpu'");
    expect(timingSource).toContain('beginningOfPassWriteIndex: 0');
    expect(timingSource).toContain('endOfPassWriteIndex: 1');
    expect(timingSource).not.toContain('encoder.writeTimestamp');
    expect(timingSource).toContain('membership: {');
    expect(timingSource).toContain('dispatchId: capture.dispatchId ?? null');
  });

  it('keeps the null/refusal route out of the accepted GPU contract', () => {
    const timing = createMembershipTiming(
      {
        caps: {
          backendKind: 'null',
          compute: true,
          timestampQuery: false,
          timestampPeriodNanoseconds: null,
        },
      } as unknown as RhiDevice,
      { mode: 'gpu' },
    );
    const result = timing.start();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('timestamp-query-unsupported');
      expect(result.error.expected).toContain('timestampQuery');
      expect(result.error.hint).toEqual(expect.any(String));
      expect(result.error.detail).toEqual(expect.any(String));
    }
  });

  it('requires the report contract to carry finite positive GPU provenance', () => {
    expect(timingSource).toContain("rawUnit: 'ticks'");
    expect(timingSource).toContain('end <= begin');
    expect(timingSource).toContain('Number.isFinite(durationNanoseconds)');
    expect(timingSource).toContain('source === undefined');
    expect(timingSource).toContain("'membership-output-mismatch'");
    expect(timingSource).toContain("'timestamp-range-invalid'");
  });
});
