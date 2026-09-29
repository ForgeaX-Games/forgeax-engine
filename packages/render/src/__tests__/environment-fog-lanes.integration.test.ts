import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Atmosphere } from '../components/atmosphere';
import { DirectionalLight } from '../components/directional-light';
import { Fog } from '../components/fog';
import { DeviceScope } from '../device/device-scope';
import { selectEnvironment } from '../environment/frame';
import { EnvironmentLifecycle } from '../environment/lifecycle';
import { extractFrames } from '../render-system-extract-tail';

const frame = selectEnvironment({
  environments: [
    {
      kind: 'atmosphere',
      entityKey: 7,
      sourceKey: 'sky-stable',
      atmosphere: {
        turbidity: 2,
        rayleigh: 1,
        mieCoefficient: 0.005,
        mieDirectionalG: 0.8,
        sunAngularRadius: 0.004675,
        circumsolarStrength: 1,
        circumsolarWidth: 1,
      },
    },
  ],
  fogs: [
    {
      entityKey: 8,
      color: [0.2, 0.3, 0.4],
      density: 0.03,
      heightFalloff: 0.2,
      maxOpacity: 0.9,
    },
  ],
  suns: [{ entityKey: 9, direction: [0, -1, 0], color: [1, 1, 1], intensity: 2 }],
  lane: 'direct',
});

describe('Environment and Fog lane graph contract', () => {
  it('extracts all Atmosphere parameters and normalized Sun facts from ECS rows', () => {
    const world = new World();
    world
      .spawn({
        component: Atmosphere,
        data: {
          turbidity: 3,
          rayleigh: 1.2,
          mieCoefficient: 0.006,
          mieDirectionalG: 0.7,
          sunAngularRadius: 0.01,
          circumsolarStrength: 1.4,
          circumsolarWidth: 1.6,
        },
      })
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, -2, 0], intensity: 2 },
      })
      .unwrap();

    const extracted = extractFrames([world], 0);
    expect(extracted.environment).toBeDefined();
    if (extracted.environment === undefined) throw new Error('expected extracted environment');
    expect(extracted.environment.source.kind).toBe('atmosphere');
    if (extracted.environment.source.kind !== 'atmosphere') {
      throw new Error('expected atmosphere environment source');
    }
    expect(extracted.environment.source.atmosphere?.turbidity).toBeCloseTo(3);
    expect(extracted.environment.source.atmosphere?.rayleigh).toBeCloseTo(1.2);
    expect(extracted.environment.source.atmosphere?.mieCoefficient).toBeCloseTo(0.006);
    expect(extracted.environment.source.atmosphere?.mieDirectionalG).toBeCloseTo(0.7);
    expect(extracted.environment.source.atmosphere?.sunAngularRadius).toBeCloseTo(0.01);
    expect(extracted.environment.source.atmosphere?.circumsolarStrength).toBeCloseTo(1.4);
    expect(extracted.environment.source.atmosphere?.circumsolarWidth).toBeCloseTo(1.6);
    const signature = JSON.parse(extracted.environment.signature) as {
      environments: [{ atmosphere: Record<string, number> }];
      suns: [{ direction: [number, number, number] }];
    };
    expect(signature.environments[0].atmosphere.turbidity).toBeCloseTo(3);
    expect(signature.environments[0].atmosphere.rayleigh).toBeCloseTo(1.2);
    expect(signature.environments[0].atmosphere.mieCoefficient).toBeCloseTo(0.006);
    expect(signature.environments[0].atmosphere.mieDirectionalG).toBeCloseTo(0.7);
    expect(signature.environments[0].atmosphere.sunAngularRadius).toBeCloseTo(0.01);
    expect(signature.environments[0].atmosphere.circumsolarStrength).toBeCloseTo(1.4);
    expect(signature.environments[0].atmosphere.circumsolarWidth).toBeCloseTo(1.6);
    expect(signature.suns[0].direction).toEqual([0, 1, 0]);
  });

  it('extracts the resource-owner Fog into the frame projection', () => {
    const world = new World();
    const fogEntity = world
      .spawn({
        component: Fog,
        data: {
          color: [0.15, 0.25, 0.35],
          density: 0.04,
          heightFalloff: 0.3,
          maxOpacity: 0.7,
        },
      })
      .unwrap();

    const first = extractFrames([world], 0);
    expect(first.fog?.entityKey).toBe(fogEntity);
    expect(first.fog?.color[0]).toBeCloseTo(0.15);
    expect(first.fog?.color[1]).toBeCloseTo(0.25);
    expect(first.fog?.color[2]).toBeCloseTo(0.35);
    expect(first.fog?.density).toBeCloseTo(0.04);
    expect(first.fog?.heightFalloff).toBeCloseTo(0.3);
    expect(first.fog?.maxOpacity).toBeCloseTo(0.7);

    world
      .set(fogEntity, Fog, {
        color: [0.6, 0.5, 0.4],
        density: 0.01,
        heightFalloff: 0,
        maxOpacity: 0.2,
      })
      .unwrap();
    const changed = extractFrames([world], 0);
    expect(changed.fog?.density).toBeCloseTo(0.01);
    expect(changed.fog?.color[0]).toBeCloseTo(0.6);
    expect(changed.fog?.color[1]).toBeCloseTo(0.5);
    expect(changed.fog?.color[2]).toBeCloseTo(0.4);
  });

  it('uses one signature and generation for direct and clustered consumers', async () => {
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    const lifecycle = new EnvironmentLifecycle(DeviceScope.create(3, 'environment-lanes'));
    const direct = await lifecycle.ensure(frame.value, 'direct');
    const clustered = await lifecycle.ensure(frame.value, 'clustered');
    expect(direct.ok).toBe(true);
    expect(clustered.ok).toBe(true);
    if (!direct.ok || !clustered.ok) return;
    expect(clustered.value.generation).toBe(direct.value.generation);
    expect(clustered.value.signature).toBe(direct.value.signature);
    expect(clustered.value.liveHandle).toBe(direct.value.liveHandle);
  });

  it('keeps failed candidate receipts structured and active/LKG unchanged', async () => {
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    const lifecycle = new EnvironmentLifecycle(DeviceScope.create(4, 'environment-recovery'));
    const published = await lifecycle.ensure(frame.value, 'direct');
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    lifecycle.publish(published.value);
    const before = lifecycle.inspect();
    const failed = await lifecycle.ensure(frame.value, { failureAt: 'execute' });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe('environment-generation-failed');
    expect(failed.error.detail).toEqual({ sourceKey: 'sky-stable', stage: 'execute' });
    expect(lifecycle.inspect()).toEqual(before);
  });

  it('rejects an invalid extracted candidate before lifecycle ensure, then publishes one correction', async () => {
    const world = new World();
    const atmosphereEntity = world
      .spawn({
        component: Atmosphere,
        data: {
          turbidity: 2,
          rayleigh: 1,
          mieCoefficient: 0.005,
          mieDirectionalG: 0.8,
          sunAngularRadius: 0.004675,
          circumsolarStrength: 1,
          circumsolarWidth: 1,
        },
      })
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], intensity: 1 },
      })
      .unwrap();
    const lifecycle = new EnvironmentLifecycle(DeviceScope.create(5, 'environment-render-path'));

    const initial = extractFrames([world], 0);
    expect(initial.environmentReady).toBe(true);
    expect(initial.environment).toBeDefined();
    if (initial.environment === undefined) throw new Error('expected initial environment');
    const first = await lifecycle.ensure(initial.environment);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    lifecycle.publish(first.value);
    const beforeInvalid = lifecycle.inspect();

    world
      .set(atmosphereEntity, Atmosphere, {
        turbidity: -1,
        rayleigh: 1,
        mieCoefficient: 0.005,
        mieDirectionalG: 0.8,
        sunAngularRadius: 0.004675,
        circumsolarStrength: 1,
        circumsolarWidth: 1,
      })
      .unwrap();
    const invalid = extractFrames([world], 0);
    expect(invalid.environmentReady).toBe(false);
    expect(lifecycle.inspect()).toEqual(beforeInvalid);

    world
      .set(atmosphereEntity, Atmosphere, {
        turbidity: 3,
        rayleigh: 1,
        mieCoefficient: 0.006,
        mieDirectionalG: 0.7,
        sunAngularRadius: 0.01,
        circumsolarStrength: 1,
        circumsolarWidth: 1,
      })
      .unwrap();
    const corrected = extractFrames([world], 0);
    expect(corrected.environmentReady).toBe(true);
    expect(corrected.environment).toBeDefined();
    if (corrected.environment === undefined) throw new Error('expected corrected environment');
    const second = await lifecycle.ensure(corrected.environment);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.generation).toBeGreaterThan(first.value.generation);
    lifecycle.publish(second.value);
    expect(lifecycle.inspect().activeSignature).toBe(second.value.signature);
  });
});
