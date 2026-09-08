import { World } from '@forgeax/engine-ecs';
import { createProfiler } from '@forgeax/engine-profiler';
import { Camera, type RenderFeature } from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderer as constructRenderer } from '../assembly/factory';

function manifestUrl(): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ schemaVersion: '1.0.0', entries: [] }))}`;
}

describe('factory contract', () => {
  it('releases its profiler catalog contribution on dispose', async () => {
    const profiler = createProfiler();
    const renderer = await constructRenderer(
      { getContext: () => null },
      { profiler, rhi },
      { shaderManifestUrl: manifestUrl() },
    );

    expect(profiler.phaseCatalog.render.length).toBeGreaterThan(0);
    renderer.dispose();
    expect(profiler.phaseCatalog.render).toEqual([]);
  });

  it('completes the receipt-bound create, attach, draw, observe, recover chain', async () => {
    const renderer = await constructRenderer(
      { getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const lease = attached.value;
    expect(world.update().ok).toBe(true);

    const frame = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    expect(frame.ok).toBe(true);
    if (!frame.ok || frame.value === undefined) return;

    const observed = await renderer.observe(frame.value, { include: ['timings'] });
    expect(observed.ok).toBe(true);
    const recovered = await renderer.recover();
    expect(recovered.ok).toBe(false);
    if (!recovered.ok) expect(recovered.error.code).toBe('recover-not-needed');
    renderer.dispose();
  });

  it('does not promote a graph feature without a fullscreen effect into post-effects', async () => {
    let planCalls = 0;
    const feature = {
      identity: 'synthetic.graph-only',
      extract: () => ok(undefined),
      plan: () => {
        planCalls += 1;
        return ok({ resources: [], passes: [] });
      },
    };
    const renderer = await constructRenderer(
      { getContext: () => null },
      { rhi, features: [feature] },
      { shaderManifestUrl: manifestUrl() },
    );
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update().ok).toBe(true);
    const frame = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok).toBe(true);
    expect(planCalls).toBe(1);
    renderer.dispose();
  });

  it('keeps the active graph as LKG when a feature candidate cannot be projected', async () => {
    let invalid = false;
    const featureErrors: string[] = [];
    const feature: RenderFeature<undefined> = {
      identity: 'synthetic.candidate-lkg',
      extract: () => ok(undefined),
      plan: () => {
        if (!invalid) return ok({ resources: [], passes: [] });
        return ok({
          resources: [
            {
              kind: 'compute-program' as const,
              name: 'candidate.program',
              program: {
                wgsl: '@compute @workgroup_size(1) fn main() {}',
                entryPoints: ['main'],
                bindings: [
                  {
                    entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
                  },
                ],
              },
            },
            {
              kind: 'buffer' as const,
              name: 'candidate.buffer',
              size: 4,
              usage: ['storage' as const],
              data: new Uint32Array([0]),
            },
            {
              kind: 'compute-bindings' as const,
              name: 'candidate.bindings',
              program: 'candidate.program',
              entries: [{ binding: 0, resource: 'candidate.buffer' }],
            },
          ],
          passes: [
            {
              kind: 'compute',
              name: 'main',
              program: 'candidate.program',
              bindings: 'candidate.bindings',
              dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [1] }],
            },
          ],
        });
      },
    };
    const renderer = await constructRenderer(
      { getContext: () => null },
      { rhi, features: [feature] },
      { shaderManifestUrl: manifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const unsubscribe = renderer.onError((error) => featureErrors.push(error.code));
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    expect(world.update().ok).toBe(true);
    expect(
      renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      }).ok,
    ).toBe(true);
    const lastKnownGoodPasses = [...renderer.perFramePassNames];
    expect(lastKnownGoodPasses.length).toBeGreaterThan(0);

    invalid = true;
    expect(
      renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      }).ok,
    ).toBe(true);
    await Promise.resolve();
    expect(
      renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      }).ok,
    ).toBe(true);
    expect(featureErrors).toContain('duplicate-pass-name');
    expect(renderer.perFramePassNames).toEqual(lastKnownGoodPasses);
    unsubscribe();
    renderer.dispose();
  });

  it('attaches derived-state systems once without putting writes in draw', async () => {
    const renderer = await constructRenderer(
      { getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    const world = new World();

    expect(renderer.attach(world).ok).toBe(true);
    expect(renderer.attach(world).ok).toBe(true);
    expect(world.inspect().schedules.flatMap((schedule) => schedule.systems)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'renderDerivedEntities' })]),
    );
    renderer.dispose();
  });

  it('releases one World without disposing the shared Renderer', async () => {
    const first = await constructRenderer(
      { getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    const second = await constructRenderer(
      { getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    const world = new World();

    expect(first.attach(world).ok).toBe(true);
    first.detachScene(world);
    first.detachScene(world);
    expect(second.attach(world).ok).toBe(true);
    second.dispose();
    first.dispose();
  });

  it('resolves a renderer for a host canvas and rejects missing input', async () => {
    const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ schemaVersion: '1.0.0', entries: [] }))}`;
    await expect(
      constructRenderer({ getContext: () => null }, { rhi }, { shaderManifestUrl: manifest }),
    ).resolves.toMatchObject({
      attach: expect.any(Function),
      draw: expect.any(Function),
    });
    await expect(constructRenderer(undefined, { rhi })).rejects.toBeInstanceOf(Error);
  });

  it('temporarily releases presentation while preserving the Renderer identity', async () => {
    const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ schemaVersion: '1.0.0', entries: [] }))}`;
    const renderer = await constructRenderer(
      { getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifest },
    );
    expect(renderer.releaseSurface().ok).toBe(true);
    expect(renderer.releaseSurface().ok).toBe(true);
    expect(renderer.draw([], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(false);
    expect(renderer.restoreSurface().ok).toBe(true);
    expect(renderer.restoreSurface().ok).toBe(true);
    expect(renderer.draw([], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
  });

  it('does not unconfigure a surface after its ownership was released', async () => {
    let unconfigureCalls = 0;
    const renderer = await constructRenderer(
      { getContext: () => null },
      {
        rhi: {
          ...rhi,
          acquireCanvasContext: () => ({
            ok: true as const,
            value: {
              configure: () => ({ ok: true as const, value: undefined }),
              unconfigure: () => {
                unconfigureCalls += 1;
              },
              getConfiguration: () => undefined,
              getCurrentTexture: () => ({
                ok: true as const,
                value: { __brand: 'TextureView' },
              }),
            },
          }),
        },
      } as never,
      { shaderManifestUrl: manifestUrl() },
    );

    expect(renderer.releaseSurface().ok).toBe(true);
    expect(unconfigureCalls).toBe(1);
    renderer.dispose();
    expect(unconfigureCalls).toBe(1);
  });
});
