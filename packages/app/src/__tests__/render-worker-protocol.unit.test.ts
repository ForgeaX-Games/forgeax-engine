import { RendererOperationError } from '@forgeax/engine-render';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  draw: vi.fn(),
  observe: vi.fn(),
  bounds: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost: (...args: unknown[]) => {
    mocks.construct(...args);
    return Promise.resolve({
      ok: true,
      value: {
        renderer: {
          draw: mocks.draw,
          observe: mocks.observe,
          bounds: mocks.bounds,
          dispose: mocks.dispose,
          state: () => 'alive',
          inspect: () => ({ capabilities: {} }),
        },
      },
    });
  },
}));
vi.mock('../execution/bootstrap-entry', () => ({
  prepareBootstrapEntry: async () => ({ ok: true, value: {} }),
}));
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

async function start(options: { readonly gpuPassTiming?: object } = {}) {
  const post = vi.fn();
  vi.stubGlobal('postMessage', post);
  vi.stubGlobal('close', vi.fn());
  vi.stubGlobal('onmessage', undefined);
  await import('../execution/render-worker-runtime');
  const receive = globalThis.onmessage as unknown as (event: { data: unknown }) => void;
  receive({
    data: {
      kind: 'init',
      canvas: {},
      bootstrapUrl: 'test://bootstrap',
      identity: { source: 'test', epoch: 1 },
      ...options,
    },
  });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' })),
  );
  return { post, receive };
}

function drawMessage(revision: number, close = vi.fn(), source: 'video' | 'canvas' = 'video') {
  return {
    kind: 'draw',
    frameId: revision,
    worldIdentity: 'test-world',
    width: 32,
    height: 32,
    publication: {
      source: 'test',
      epoch: 1,
      revision,
      features: [],
      videoFrames: source === 'video' ? [{ frame: { close } }] : [],
      canvasFrames:
        source === 'canvas'
          ? [
              { id: 1, version: revision, disposed: false, frame: { close } },
              { id: 2, version: revision, disposed: true },
            ]
          : [],
      upserts: new Float32Array(0),
      removed: new Uint32Array(0),
      transformEntities: new Uint32Array(0),
      transforms: new Float32Array(0),
    },
  };
}

it('reports a failed successor immediately even when its timing observation and predecessor wait', async () => {
  let completeFirst!: () => void;
  let finishTiming!: () => void;
  const completed = new Promise((resolve) => {
    completeFirst = () => resolve({ ok: true, value: undefined });
  });
  const error = new RendererOperationError('device-operation-failed', {
    operation: 'complete-frame',
    cause: { code: 'device-lost', expected: 'live device', hint: 'replace the device' },
  });
  mocks.draw
    .mockReturnValueOnce({ ok: true, value: { deviceGeneration: 1, completed } })
    .mockReturnValueOnce({
      ok: true,
      value: { deviceGeneration: 1, completed: Promise.resolve({ ok: false, error }) },
    });
  mocks.observe.mockResolvedValueOnce({ ok: true, value: {} }).mockReturnValueOnce(
    new Promise((resolve) => {
      finishTiming = () => resolve({ ok: true, value: {} });
    }),
  );
  const { post, receive } = await start({ gpuPassTiming: {} });
  try {
    receive({ data: drawMessage(1) });
    receive({ data: drawMessage(2) });
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'failed',
          recoverable: true,
          publication: expect.objectContaining({ revision: 2 }),
        }),
      ),
    );
    receive({ data: { kind: 'dispose' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(post.mock.calls.some(([message]) => message.kind === 'completed')).toBe(false);
  } finally {
    finishTiming();
    completeFirst();
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
  expect(post.mock.calls.filter(([message]) => message.kind === 'failed')).toHaveLength(1);
  expect(post.mock.calls.some(([message]) => message.kind === 'completed')).toBe(false);
});

it.each([
  'video',
  'canvas',
] as const)('retires %s frames on admission failure and shutdown', async (source) => {
  let complete!: () => void;
  const completed = new Promise((resolve) => {
    complete = () => resolve({ ok: true, value: undefined });
  });
  mocks.draw.mockReturnValue({ ok: true, value: { deviceGeneration: 1, completed } });
  const { post, receive } = await start();
  const closes = [vi.fn(), vi.fn(), vi.fn()];
  try {
    receive({ data: drawMessage(1, closes[0], source) });
    receive({ data: drawMessage(2, closes[1], source) });
    await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledTimes(2));
    receive({ data: drawMessage(3, closes[2], source) });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'failed',
        publication: expect.objectContaining({ revision: 3 }),
      }),
    );
    expect(mocks.draw).toHaveBeenCalledTimes(2);
    expect(closes[0]).not.toHaveBeenCalled();
    expect(closes[1]).not.toHaveBeenCalled();
    expect(closes[2]).toHaveBeenCalledTimes(1);
  } finally {
    complete();
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
  for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  expect(post.mock.calls.some(([message]) => message.kind === 'completed')).toBe(false);
});

it.each([
  'video',
  'canvas',
] as const)('retires %s publications in order while submitting ahead', async (source) => {
  const releases: (() => void)[] = [];
  const closes = [vi.fn(), vi.fn()];
  mocks.draw.mockImplementation(() => ({
    ok: true,
    value: {
      deviceGeneration: 1,
      completed: new Promise((resolve) => {
        releases.push(() => resolve({ ok: true, value: undefined }));
      }),
    },
  }));
  const { post, receive } = await start();
  const completedRevisions = () =>
    post.mock.calls
      .filter(([message]) => message.kind === 'completed')
      .map(([message]) => message.revision);
  try {
    for (const revision of [1, 2])
      receive({ data: drawMessage(revision, closes[revision - 1], source) });
    await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledTimes(2));
    expect(completedRevisions()).toEqual([]);
    releases[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completedRevisions()).toEqual([]);
    for (const close of closes) expect(close).not.toHaveBeenCalled();
    receive({ data: { kind: 'dispose' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.dispose).not.toHaveBeenCalled();
    releases[0]?.();
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
    expect(completedRevisions()).toEqual([1, 2]);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  } finally {
    for (const release of releases) release();
    // The baseline only creates the second receipt after releasing the first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const release of releases) release();
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it('constructs timing in the Render Worker and returns the receipt-bound observation', async () => {
  const timing = {
    status: 'complete',
    frame: {
      schemaVersion: '1.0',
      frameId: 1,
      deviceGeneration: 1,
      graphGeneration: 1,
      backendKind: 'webgpu',
      timestampPeriodNanoseconds: 1,
      passCapacity: 4,
      executedPassCount: 1,
      measuredPassCount: 1,
      droppedPassCount: 0,
      passes: [],
      measuredPassNanoseconds: 10,
    },
  } as const;
  mocks.draw.mockReturnValue({
    ok: true,
    value: {
      deviceGeneration: 1,
      graphGeneration: 1,
      completed: Promise.resolve({ ok: true, value: undefined }),
    },
  });
  mocks.observe.mockResolvedValue({ ok: true, value: { timings: timing } });
  const { post, receive } = await start({ gpuPassTiming: { retentionFrames: 4 } });
  expect(mocks.construct.mock.calls[0]?.[1]).toMatchObject({
    gpuPassTiming: { retentionFrames: 4 },
  });
  receive({
    data: {
      kind: 'draw',
      frameId: 1,
      worldIdentity: 'test-world',
      width: 32,
      height: 32,
      publication: {
        source: 'test',
        epoch: 1,
        revision: 1,
        features: [],
        videoFrames: [],
        upserts: new Float32Array(0),
        removed: new Uint32Array(0),
        transformEntities: new Uint32Array(0),
        transforms: new Float32Array(0),
      },
    },
  });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'completed', gpuPassTiming: timing }),
      expect.any(Array),
    ),
  );
  expect(mocks.observe).toHaveBeenCalledWith(expect.objectContaining({ deviceGeneration: 1 }), {
    include: ['timings'],
  });
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it('reports publication overflow as deterministic protocol failure and drains owned frames', async () => {
  let complete!: () => void;
  const completed = new Promise((resolve) => {
    complete = () => resolve({ ok: true, value: undefined });
  });
  mocks.draw.mockReturnValue({ ok: true, value: { deviceGeneration: 1, completed } });
  const { post, receive } = await start();
  const closeFrames = [vi.fn(), vi.fn(), vi.fn()];
  const draw = (revision: number) => ({
    kind: 'draw',
    frameId: revision,
    worldIdentity: 'test-world',
    width: 32,
    height: 32,
    publication: {
      source: 'test',
      epoch: 1,
      revision,
      features: [],
      videoFrames: [{ frame: { close: closeFrames[revision - 1] } }],
      upserts: new Float32Array(0),
      removed: new Uint32Array(0),
      transformEntities: new Uint32Array(0),
      transforms: new Float32Array(0),
    },
  });
  try {
    receive({ data: draw(1) });
    await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledTimes(1));
    receive({ data: draw(2) });
    expect(() => receive({ data: draw(3) })).not.toThrow();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'failed',
        stage: 'draw',
        recoverable: false,
        publication: { source: 'test', epoch: 1, revision: 3, frameId: 3 },
      }),
    );
  } finally {
    complete();
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
  expect(mocks.draw).toHaveBeenCalledTimes(1);
  for (const close of closeFrames) expect(close).toHaveBeenCalledTimes(1);
});

it.each([
  'device-lost',
  'disposed',
  'stale-generation',
  'producer-invalid',
])('classifies a %s completion fence using the receipt even before health changes', async (code) => {
  const error = new RendererOperationError('device-operation-failed', {
    operation: 'complete-frame',
    cause: { code, expected: 'live receipt generation', hint: 'inspect the receipt' },
  });
  mocks.draw.mockReturnValue({
    ok: true,
    value: {
      deviceGeneration: 1,
      completed: Promise.resolve({ ok: false, error }),
    },
  });
  const { post, receive } = await start();
  receive({
    data: {
      kind: 'draw',
      frameId: 1,
      width: 32,
      height: 32,
      publication: { source: 'test', epoch: 1, revision: 1, features: [], videoFrames: [] },
    },
  });
  try {
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'failed',
          recoverable: code !== 'producer-invalid',
          error: expect.objectContaining({ code: 'device-operation-failed' }),
        }),
      ),
    );
  } finally {
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it('answers bounds queries against the bound publication source without drawing', async () => {
  const bounds = { min: [1, 2, 3], max: [4, 5, 6] };
  mocks.bounds.mockReturnValue(bounds);
  const { post, receive } = await start();
  receive({ data: { kind: 'bounds', requestId: 1, entity: 7 } });
  expect(mocks.bounds).toHaveBeenCalledWith({ source: 'test', epoch: 1 }, 7);
  expect(post).toHaveBeenCalledWith({ kind: 'bounds-result', requestId: 1, bounds });
  expect(mocks.draw).not.toHaveBeenCalled();
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});
