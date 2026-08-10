import { describe, expect, it } from 'vitest';
import { cookParticleCodeProgram } from '../code-program.js';

const source = {
  schemaVersion: 2,
  emitters: [
    {
      id: 'bolt',
      capacity: 64,
      backend: { required: 'gpu' as const },
      space: 'world' as const,
      bounds: { kind: 'sphere' as const, center: [0, 0, 0], radius: 4 },
      schedule: { rate: 1 },
      program: { module: 'bolt.vfx.wgsl' },
      renderers: [{ kind: 'billboard' as const, material: 'material-guid' }],
      channels: [{ id: 'impact', capacity: 2, overflow: 'drop-newest' }],
      events: [
        { id: 'impact-event', channel: 'impact', subEmitter: 'bolt', fanOut: 2, recursionDepth: 1 },
      ],
    },
  ],
};
const module = `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`;

describe('managed GPU event artifact', () => {
  it('includes event resources, stable ordering, and limits in the cooked reflection', async () => {
    const result = await cookParticleCodeProgram(source, { 'bolt.vfx.wgsl': { entry: module } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const emitter = result.value.program.emitters[0];
    expect(emitter?.reflection).toMatchObject({
      resources: expect.arrayContaining(['channelInputs', 'events', 'eventCounters']),
      eventChannels: [{ id: 'impact', capacity: 2, overflow: 'drop-newest' }],
      events: [{ id: 'impact-event', channel: 'impact', fanOut: 2, recursionDepth: 1 }],
    });
    expect(result.value.fingerprint).toBeTruthy();
  });
});
