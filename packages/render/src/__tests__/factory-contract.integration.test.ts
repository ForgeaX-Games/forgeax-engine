import { World } from '@forgeax/engine-ecs';
import { RhiNullAdapter, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { constructRenderer } from '../construct-renderer';

function manifestUrl(): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ schemaVersion: '1.0.0', entries: [] }))}`;
}

describe('factory contract', () => {
  it('rolls back a post-process params buffer when its initial write fails', async () => {
    const adapter = new RhiNullAdapter();
    const deviceResult = await adapter.requestDevice();
    expect(deviceResult.ok).toBe(true);
    if (!deviceResult.ok) return;
    const device = deviceResult.value;
    device.queue.writeBuffer = () =>
      ({
        ok: false,
        error: new Error('write failed'),
      }) as never;
    const failingRhi = {
      requestAdapter: () =>
        Promise.resolve({
          ok: true as const,
          value: { ...adapter, requestDevice: () => Promise.resolve(deviceResult) },
        }),
      acquireCanvasContext: rhi.acquireCanvasContext,
      createShaderModule: rhi.createShaderModule,
    };
    const renderer = await constructRenderer(
      { getContext: () => null },
      { rhi: failingRhi as never },
      { shaderManifestUrl: manifestUrl() },
    );
    expect(() =>
      renderer.postProcess.register('test::write-failure', {
        source: 'fn main() {}',
        params: { byteSize: 16, defaultValue: new Uint8Array(16) },
      }),
    ).toThrow('write failed');
    const buffers = (device as import('@forgeax/engine-rhi-null').RhiNullDevice).bookkeeper
      .allRecords()
      .filter((record) => record.kind === 'Buffer');
    expect(buffers.at(-1)?.destroyed).toBe(true);
    renderer.dispose();
  });

  it('attaches derived-state systems once without putting writes in draw', async () => {
    const renderer = await constructRenderer(
      { getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    const world = new World();

    expect(renderer.attachWorld(world).ok).toBe(true);
    expect(renderer.attachWorld(world).ok).toBe(true);
    expect(world.inspect().schedules.flatMap((schedule) => schedule.systems)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'renderDerivedEntities' })]),
    );
    renderer.dispose();
  });

  it('rejects a second renderer owner and releases attachment on dispose', async () => {
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

    expect(first.attachWorld(world).ok).toBe(true);
    expect(second.attachWorld(world).ok).toBe(false);
    first.dispose();
    expect(second.attachWorld(world).ok).toBe(true);
    second.dispose();
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

    expect(first.attachWorld(world).ok).toBe(true);
    first.detachWorld(world);
    first.detachWorld(world);
    expect(second.attachWorld(world).ok).toBe(true);
    second.dispose();
    first.dispose();
  });

  it('refuses an attached World whose latest update did not complete publication', async () => {
    const renderer = await constructRenderer(
      { getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    expect((await renderer.ready).ok).toBe(true);
    const world = new World();
    expect(renderer.attachWorld(world).ok).toBe(true);
    expect(world.update().ok).toBe(true);
    expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);

    expect(world.update(Number.NaN).ok).toBe(false);
    expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(false);
    renderer.dispose();
  });

  it('resolves a renderer for a host canvas and rejects missing input', async () => {
    const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ schemaVersion: '1.0.0', entries: [] }))}`;
    await expect(
      constructRenderer({ getContext: () => null }, { rhi }, { shaderManifestUrl: manifest }),
    ).resolves.toMatchObject({
      backend: 'webgpu',
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

  it('keeps the real factory-owned GPU refusal structured on the null carrier', async () => {
    const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ schemaVersion: '1.0.0', entries: [] }))}`;
    const renderer = await constructRenderer(
      { getContext: () => null },
      { rhi, membershipTiming: { mode: 'gpu' } },
      { shaderManifestUrl: manifest },
    );
    try {
      const ready = await renderer.ready;
      expect(ready.ok).toBe(true);
      expect(renderer.membershipTiming).toBeDefined();
      const started = renderer.membershipTiming?.start();
      expect(started?.ok).toBe(false);
      if (started !== undefined && !started.ok) {
        expect(started.error.code).toBe('timestamp-query-unsupported');
        expect(started.error.expected).toContain('timestampQuery');
        expect(started.error.hint).toEqual(expect.any(String));
        expect(started.error.detail).toEqual(expect.any(String));
      }
    } finally {
      renderer.dispose();
    }
  });

  it('reports one capture identity through the real Render submit path for CPU control', async () => {
    const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ schemaVersion: '1.0.0', entries: [] }))}`;
    const renderer = await constructRenderer(
      { getContext: () => null },
      { rhi, membershipTiming: { mode: 'cpu-control' } },
      { shaderManifestUrl: manifest },
    );
    try {
      const ready = await renderer.ready;
      expect(ready.ok).toBe(true);
      const timing = renderer.membershipTiming;
      expect(timing?.start().ok).toBe(true);
      const world = new World();
      expect(renderer.attachWorld(world).ok).toBe(true);
      expect(world.update().ok).toBe(true);
      expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
      const report = await timing?.finish();
      expect(report?.ok).toBe(true);
      if (report?.ok) {
        expect(report.value.captureId).toMatch(/^membership-\d+$/);
        expect(report.value.submissionToken).toBe(`${report.value.captureId}:submission`);
        expect(report.value.actualProducer).toBe('cpu');
        expect(report.value.gpu).toBeNull();
      }
    } finally {
      renderer.dispose();
    }
  });

  it('publishes frame completion only after a successful draw', async () => {
    const manifest = manifestUrl();
    const renderer = await constructRenderer(
      { getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifest },
    );
    expect((await renderer.ready).ok).toBe(true);

    let completions = 0;
    const unsubscribe = renderer.subscribeFrameEnd(() => {
      completions += 1;
    });
    const world = new World();
    expect(renderer.attachWorld(world).ok).toBe(true);
    world.update().unwrap();

    expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
    expect(completions).toBe(1);

    expect(renderer.releaseSurface().ok).toBe(true);
    expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(false);
    expect(completions).toBe(1);

    expect(renderer.restoreSurface().ok).toBe(true);
    unsubscribe();
    expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
    expect(completions).toBe(1);
  });

  it('does not publish completion when the render stage cannot submit', async () => {
    const adapterResult = await rhi.requestAdapter();
    expect(adapterResult.ok).toBe(true);
    if (!adapterResult.ok) return;
    const deviceResult = await adapterResult.value.requestDevice();
    expect(deviceResult.ok).toBe(true);
    if (!deviceResult.ok) return;
    const failingPack = {
      rhi: {
        requestAdapter: () => Promise.resolve(adapterResult),
        acquireCanvasContext: () => ({
          ok: true as const,
          value: {
            configure: () => ({ ok: true as const, value: undefined }),
            unconfigure: () => undefined,
            getConfiguration: () => undefined,
            getCurrentTexture: () => ({
              ok: false as const,
              error: new Error('surface unavailable'),
            }),
          },
        }),
      },
    };
    const renderer = await constructRenderer({ getContext: () => null }, failingPack as never, {
      shaderManifestUrl: manifestUrl(),
    });
    expect((await renderer.ready).ok).toBe(true);

    let completions = 0;
    renderer.subscribeFrameEnd(() => {
      completions += 1;
    });
    const world = new World();
    expect(renderer.attachWorld(world).ok).toBe(true);
    world.update().unwrap();
    expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
    expect(completions).toBe(0);
  });
});
