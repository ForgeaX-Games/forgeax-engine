import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Atmosphere, ReflectionProbe, MeshRenderer, Skylight, type Renderer, type GpuPassTimingObservation } from '@forgeax/engine-render';

function difference(a: Uint8Array, b: Uint8Array) {
  let changed = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const delta = Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
    if (delta > 3) changed++;
    sum += delta;
  }
  return { changed, meanRgbDelta: sum / (a.length / 4 * 3 * 255) };
}

/** Hold geometry, lighting and display sky fixed while only the captured sky catches up. */
export async function verifyProbeAtmosphere(
  world: World,
  renderer: Renderer,
  probe: EntityHandle,
  object: EntityHandle,
  skylight: EntityHandle,
  draw: () => Promise<GpuPassTimingObservation | undefined>,
  capture: () => Promise<Uint8Array>,
) {
  const profile = renderer.inspect().profile;
  const original = { ...world.get(probe, ReflectionProbe).unwrap() };
  const skyColor = Array.from(world.get(skylight, Skylight).unwrap().color);
  world.set(skylight, Skylight, { color: [1, 1, 1] }).unwrap();
  const atmosphere = world.spawn({ component: Atmosphere, data: { turbidity: 2 } }).unwrap();
  let frames = 0;
  let maximumProbeWork = 0;
  let atmosphereWork = 0;
  const timings = new Map<string, number[]>();
  const generation = () => renderer.inspect().reflectionProbes.updates?.[0]?.activeGeneration ?? 0;
  const step = async (count: number) => {
    for (let i = 0; i < count; i++) {
      const timing = await draw();
      if (timing !== undefined) {
        if (timing.status !== 'complete') throw new Error(`Incomplete GPU timing: ${JSON.stringify(timing)}`);
        for (const pass of timing.frame.passes) {
          if (!pass.passName.startsWith('reflection-probe.') && !pass.passName.startsWith('ssao-') && !pass.passName.startsWith('atmosphere-')) continue;
          if (pass.status !== 'measured') throw new Error(`Missing GPU timing: ${pass.passName}`);
          if (/^atmosphere-(cube|irradiance|prefilter)-/.test(pass.passName)) atmosphereWork++;
          const name = pass.passName.startsWith('reflection-probe.')
            ? (pass.passName.includes('.capture.') ? 'probe-capture' : 'probe-filter') : pass.passName.replace(/-(?:\d+-)?\d+$/, '');
          const values = timings.get(name) ?? [];
          values.push(pass.durationNanoseconds / 1e6);
          timings.set(name, values);
        }
      }
      frames++;
      const inspection = renderer.inspect();
      const gpu = inspection.renderScene.gpuDriven;
      if (!gpu.submitted || gpu.indirectDrawCount === 0 || gpu.cpuFallbackDrawItems !== 0)
        throw new Error(`Atmosphere/AO/probe lost GPU-driven lighting: ${JSON.stringify(gpu)}`);
      const work = inspection.perFramePassNames.filter(name => name.startsWith('reflection-probe.')).length;
      maximumProbeWork = Math.max(maximumProbeWork, work);
      if (work > 1) throw new Error(`Probe frame budget exceeded: ${work}`);
    }
  };
  const settle = async (before: number) => {
    for (let i = 0; i < 100; i++) {
      await step(1);
      if (generation() > before) { await step(2); return; }
    }
    throw new Error(`Atmosphere change did not publish: ${JSON.stringify(renderer.inspect().reflectionProbes)}`);
  };
  try {
    const installed = renderer.setProfile({ ...profile, ssao: { quality: 'medium', radius: 0.5 } });
    if (!installed.ok) throw installed.error;
    world.set(probe, ReflectionProbe, { updateIntent: 0, invalidationVersion: original.invalidationVersion + 1 }).unwrap();
    await settle(generation());
    // The on-screen sky changes first, while a once probe must keep its old cube.
    world.set(atmosphere, Atmosphere, { turbidity: 8 }).unwrap();
    await step(3);
    const frozen = await capture();
    const before = generation();
    world.set(probe, ReflectionProbe, { invalidationVersion: original.invalidationVersion + 2 }).unwrap();
    await settle(before);
    const updated = await capture();
    const explicit = difference(frozen, updated);
    if (explicit.changed < 100 || explicit.meanRgbDelta < 0.0001)
      throw new Error(`Probe omitted the changed Atmosphere: ${JSON.stringify(explicit)}`);
    world.set(probe, ReflectionProbe, { updateIntent: 1 }).unwrap();
    await step(100);
    const automaticBefore = generation();
    world.set(atmosphere, Atmosphere, { turbidity: 3 }).unwrap();
    await step(2);
    const automaticFrozen = await capture();
    await settle(automaticBefore);
    const automatic = difference(automaticFrozen, await capture());
    if (automatic.changed < 100) throw new Error(`Automatic sky update had no reflected effect: ${JSON.stringify(automatic)}`);
    const stableGeneration = generation();
    const stableAtmosphereWork = atmosphereWork;
    // Observe 60 stationary submissions after the update journey with AO, Atmosphere and probe combined.
    await step(60);
    if (generation() !== stableGeneration) throw new Error('An unchanged Atmosphere kept invalidating its probe');
    if (atmosphereWork !== stableAtmosphereWork) throw new Error('An unchanged Atmosphere kept rebaking its lighting');
    const mesh = world.get(object, MeshRenderer).unwrap();
    const objectRenderer = { ...mesh, materials: [...mesh.materials] };
    const probeSettings = { ...world.get(probe, ReflectionProbe).unwrap() };
    const emptyBefore = generation();
    world.removeComponent(object, MeshRenderer).unwrap();
    let emptyEnvironment;
    let probeRemoved = false;
    try {
      await settle(emptyBefore);
      const withProbe = await capture();
      world.removeComponent(probe, ReflectionProbe).unwrap();
      probeRemoved = true;
      await step(3);
      emptyEnvironment = difference(withProbe, await capture());
      if (emptyEnvironment.meanRgbDelta > 0.0003)
        throw new Error(`Empty Atmosphere probe leaves an influence-box patch: ${JSON.stringify(emptyEnvironment)}`);
    } finally {
      if (probeRemoved)
        world.addComponent(probe, { component: ReflectionProbe, data: probeSettings }).unwrap();
      world.addComponent(object, { component: MeshRenderer, data: objectRenderer }).unwrap();
    }
    await settle(generation());
    if (atmosphereWork !== 3 * 42) throw new Error(`Unchanged sky rebuilt across probe steps: ${atmosphereWork} passes instead of 126`);
    // Keep the tested combination for the same-tape Browser/Dawn capture.
    const summarize = (samples: Map<string, number[]>) => Object.fromEntries([...samples].map(([name, values]) => {
      const ordered = values.slice().sort((a, b) => a - b);
      return [name, { samples: ordered.length, p50: ordered[Math.floor((ordered.length - 1) * 0.5)], p95: ordered[Math.floor((ordered.length - 1) * 0.95)], max: ordered[ordered.length - 1] }];
    }));
    return { frames, explicit, automatic, maximumProbeWork, generation: generation(), emptyEnvironment, atmosphereWork, gpuPassMs: summarize(timings) };
  } catch (error) {
    world.despawn(atmosphere).unwrap();
    world.set(skylight, Skylight, { color: skyColor }).unwrap();
    world.set(probe, ReflectionProbe, original).unwrap();
    const restored = renderer.setProfile(profile);
    if (!restored.ok) throw restored.error;
    await draw();
    throw error;
  }
}
