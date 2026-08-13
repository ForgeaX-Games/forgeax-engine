import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { constructRenderer } from '../construct-renderer';

function manifestUrl(): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ schemaVersion: '1.0.0', entries: [] }))}`;
}

describe('factory contract', () => {
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
    expect(renderer.draw([], { owner: 0 }).ok).toBe(false);
    expect(renderer.restoreSurface().ok).toBe(true);
    expect(renderer.restoreSurface().ok).toBe(true);
    expect(renderer.draw([], { owner: 0 }).ok).toBe(true);
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
      expect(renderer.draw([new World()], { owner: 0 }).ok).toBe(true);
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

    expect(renderer.draw([new World()], { owner: 0 }).ok).toBe(true);
    expect(completions).toBe(1);

    expect(renderer.releaseSurface().ok).toBe(true);
    expect(renderer.draw([new World()], { owner: 0 }).ok).toBe(false);
    expect(completions).toBe(1);

    expect(renderer.restoreSurface().ok).toBe(true);
    unsubscribe();
    expect(renderer.draw([new World()], { owner: 0 }).ok).toBe(true);
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
    expect(renderer.draw([new World()], { owner: 0 }).ok).toBe(true);
    expect(completions).toBe(0);
  });
});
