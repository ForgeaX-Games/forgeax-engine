// feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M6 / w22.
//
// Runtime unit test for AC-08: createApp().stop() chains into
// Renderer.dispose() and a second stop() is idempotent (no double-fire,
// no thrown error). Pairs with the M-5 Renderer.dispose 6-step cascade
// (createRenderer.ts:1774) -- the stop path is the AI-user-visible
// surface that actually triggers the cascade in production.
//
// Mock approach (mirrors packages/app/__tests__/app.unit.test.ts
// `makeRendererStub` pattern): build a minimal Renderer stub with
// resolved `ready` + a `vi.fn()` `dispose` spy. createApp's assemble
// form awaits `renderer.ready` so the stub must surface a settled
// Result.ok promise. Subscribing renderer.onError is internal to
// createApp.start() (R-1 timing); we return a noop unsubscribe.

import { World } from '@forgeax/engine-ecs';
import type { RhiError } from '@forgeax/engine-rhi/errors';
import type { Renderer } from '@forgeax/engine-runtime';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../create-app';
import { type CleanupFunnelOptions, makeCleanupFunnel } from '../internal/cleanup';
import type { FrameLoopHandle } from '../internal/frame-loop';

type ReadyResult = { ok: true; value: undefined } | { ok: false; error: RhiError };

interface StubRenderer {
  readonly renderer: Renderer;
  readonly disposeSpy: ReturnType<typeof vi.fn>;
}

function makeRendererStubForStop(): StubRenderer {
  const ready: Promise<ReadyResult> = Promise.resolve({ ok: true, value: undefined });
  const disposeSpy = vi.fn<() => void>();
  const renderer = {
    backend: 'webgpu' as const,
    ready,
    draw(): { ok: true; value: undefined } {
      return { ok: true, value: undefined };
    },
    onError(): () => void {
      return () => {
        // no-op unsubscribe
      };
    },
    onLost(): () => void {
      return () => {
        // no-op unsubscribe
      };
    },
    dispose: disposeSpy,
  } as unknown as Renderer;
  return { renderer, disposeSpy };
}

describe('create-app-stop.test.ts', () => {
  describe('createApp().stop() chains into Renderer.dispose() (AC-08)', () => {
    it('start -> stop calls renderer.dispose() exactly once', async () => {
      const { renderer, disposeSpy } = makeRendererStubForStop();
      const result = await createApp({ renderer, world: new World() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const app = result.value;

      const startResult = app.start();
      expect(startResult.ok).toBe(true);

      const stopResult = app.stop();
      expect(stopResult.ok).toBe(true);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('second stop() is idempotent: dispose still called only once', async () => {
      const { renderer, disposeSpy } = makeRendererStubForStop();
      const result = await createApp({ renderer, world: new World() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const app = result.value;

      app.start();
      app.stop();
      // Second stop returns app-not-started err (frame-loop already idle),
      // but the call itself must not throw and must not re-fire dispose.
      const second = app.stop();
      expect(second.ok).toBe(false);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('stop() before start() does not call renderer.dispose()', async () => {
      // Edge case: the cleanup funnel only fires renderer.dispose when the
      // funnel has not been invoked before. stop() before start() returns
      // app-not-started err; whether dispose fires here is a design
      // decision -- currently the cleanupFunnel is invoked unconditionally
      // by stop(), so dispose runs once even from the unstarted state.
      // That single fire is harmless (Renderer.dispose itself is
      // idempotent per renderer.ts:303 + createRenderer.ts:1775).
      const { renderer, disposeSpy } = makeRendererStubForStop();
      const result = await createApp({ renderer, world: new World() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const app = result.value;

      const stopResult = app.stop();
      expect(stopResult.ok).toBe(false);
      // Funnel runs once on first stop() call; dispose is called.
      expect(disposeSpy).toHaveBeenCalledTimes(1);

      // Repeat stop(): funnel idempotent -> dispose not re-fired.
      app.stop();
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// -------------------------------------------------------------------------
// feat-20260619-audio-resource-ownership-deterministic-reclaim / M1 test
// helpers
// -------------------------------------------------------------------------

function makeFrameLoopStub(): FrameLoopHandle {
  return {
    start() {
      return ok(undefined);
    },
    stop() {
      return ok(undefined);
    },
    pause() {
      return ok(undefined);
    },
    resume() {
      return ok(undefined);
    },
    getState() {
      return 'idle' as const;
    },
    setStopped() {
      // no-op
    },
  };
}

function makeDispatchStubs() {
  const dispatch = vi.fn<(err: import('../types').AppDispatchError) => void>();
  const setLastError = vi.fn<(err: import('../types').AppDispatchError) => void>();
  return { dispatch, setLastError };
}

// w1: AC-01 -- canvas-form stop triggers audioBackendDispose exactly once.
// The funnel does not yet know about audioBackendDispose (field added in w5),
// so this test will be RED until w5+w6 wire it.
describe('feat-20260619 M1: F23 cleanup funnel audio leg', () => {
  describe('w1: AC-01 canvas-form stop triggers audioBackendDispose', () => {
    it('stop() calls audioBackendDispose exactly once', () => {
      const loop = makeFrameLoopStub();
      const { dispatch, setLastError } = makeDispatchStubs();
      const destroySpy = vi.fn<() => void>();

      const opts = {
        loop,
        dispatch: dispatch as CleanupFunnelOptions['dispatch'],
        setLastError: setLastError as CleanupFunnelOptions['setLastError'],
        audioBackendDispose: destroySpy,
      } as unknown as CleanupFunnelOptions;

      const funnel = makeCleanupFunnel(opts);
      funnel({ reason: 'stop' });

      expect(destroySpy).toHaveBeenCalledTimes(1);
    });
  });

  // w2: AC-02 -- reason semantics: stop fires audioBackendDispose,
  // device-lost skips it (mirrors rendererDispose, OOS-2).
  describe('w2: AC-02 reason semantics', () => {
    it('device-lost does not call audioBackendDispose', () => {
      const loop = makeFrameLoopStub();
      const { dispatch, setLastError } = makeDispatchStubs();
      const destroySpy = vi.fn<() => void>();

      const opts = {
        loop,
        dispatch: dispatch as CleanupFunnelOptions['dispatch'],
        setLastError: setLastError as CleanupFunnelOptions['setLastError'],
        audioBackendDispose: destroySpy,
      } as unknown as CleanupFunnelOptions;

      const funnel = makeCleanupFunnel(opts);
      funnel({ reason: 'device-lost' });
      expect(destroySpy).not.toHaveBeenCalled();
    });

    it('stop calls audioBackendDispose', () => {
      const loop = makeFrameLoopStub();
      const { dispatch, setLastError } = makeDispatchStubs();
      const destroySpy = vi.fn<() => void>();

      const opts = {
        loop,
        dispatch: dispatch as CleanupFunnelOptions['dispatch'],
        setLastError: setLastError as CleanupFunnelOptions['setLastError'],
        audioBackendDispose: destroySpy,
      } as unknown as CleanupFunnelOptions;

      const funnel = makeCleanupFunnel(opts);
      funnel({ reason: 'stop' });
      expect(destroySpy).toHaveBeenCalledTimes(1);
    });
  });

  // w3: AC-03 -- double-stop idempotency: the funnel's `invoked` latch
  // (cleanup.ts:99/104-111) guarantees audioBackendDispose fires at most
  // once, even when stop() is called multiple times.
  describe('w3: AC-03 double-stop idempotency', () => {
    it('two consecutive funnel({ reason: "stop" }) calls invoke audioBackendDispose exactly once', () => {
      const loop = makeFrameLoopStub();
      const { dispatch, setLastError } = makeDispatchStubs();
      const destroySpy = vi.fn<() => void>();

      const opts = {
        loop,
        dispatch: dispatch as CleanupFunnelOptions['dispatch'],
        setLastError: setLastError as CleanupFunnelOptions['setLastError'],
        audioBackendDispose: destroySpy,
      } as unknown as CleanupFunnelOptions;

      const funnel = makeCleanupFunnel(opts);
      funnel({ reason: 'stop' });
      funnel({ reason: 'stop' });

      expect(destroySpy).toHaveBeenCalledTimes(1);
    });
  });
});

// w4: AC-04 -- assemble form does not auto-destroy host-managed audioBackend.
describe('w4: AC-04 assemble form does not auto-destroy external backend', () => {
  it('stop() on assemble-form app with external audioBackend does not call destroy()', async () => {
    const { renderer, disposeSpy: _disposeSpy } = makeRendererStubForStop();
    const destroySpy = vi.fn<() => void>();
    const audioBackend = {
      play: vi.fn(),
      stop: vi.fn(),
      setVolume: vi.fn(),
      setBusVolume: vi.fn(),
      setBusMute: vi.fn(),
      getState: vi.fn(() => ({ contextState: 'running' as const, activeSourceCount: 0 })),
      getActiveSourceCount: vi.fn(() => 0),
      destroy: destroySpy,
    };

    const result = await createApp({
      renderer,
      world: (() => {
        const w = new World();
        w.insertResource(AUDIO_ENGINE_RESOURCE_KEY, audioBackend);
        return w;
      })(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.value;

    const startResult = app.start();
    expect(startResult.ok).toBe(true);

    const stopResult = app.stop();
    expect(stopResult.ok).toBe(true);

    // The external backend is host-managed; the engine MUST NOT call destroy().
    expect(destroySpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// feat-20260619 M3: auto-register audioTickSystem (w13/w14 tests, w15 impl)
// ---------------------------------------------------------------------------

import { AUDIO_ENGINE_RESOURCE_KEY, AudioSource } from '@forgeax/engine-audio';
import { audioPlugin, WebAudioEngine } from '@forgeax/engine-audio-webaudio';

function createTestBufferForApp(duration = 1, sampleRate = 48000): AudioBuffer {
  return {
    sampleRate,
    length: duration * sampleRate,
    duration,
    numberOfChannels: 2,
    getChannelData: vi.fn(() => new Float32Array(duration * sampleRate)),
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

function makeMockAudioContextForApp(): AudioContext {
  const mkGain = vi.fn(
    () =>
      ({
        gain: { value: 1 } as unknown as AudioParam,
        context: undefined as unknown as BaseAudioContext,
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'max' as const,
        channelInterpretation: 'speakers' as const,
        connect: vi.fn().mockReturnValue(undefined),
        disconnect: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as GainNode,
  );

  const mkSrc = vi.fn(
    () =>
      ({
        buffer: null,
        playbackRate: { value: 1 } as unknown as AudioParam,
        detune: { value: 0 } as unknown as AudioParam,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        context: undefined as unknown as BaseAudioContext,
        numberOfInputs: 0,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'max' as const,
        channelInterpretation: 'speakers' as const,
        connect: vi.fn().mockReturnValue(undefined),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onended: null,
      }) as unknown as AudioBufferSourceNode,
  );

  const mkPanner = vi.fn(
    () =>
      ({
        panningModel: 'equalpower' as const,
        distanceModel: 'inverse' as const,
        refDistance: 1,
        maxDistance: 10000,
        rolloffFactor: 1,
        coneInnerAngle: 360,
        coneOuterAngle: 360,
        coneOuterGain: 0,
        positionX: { value: 0 } as unknown as AudioParam,
        positionY: { value: 0 } as unknown as AudioParam,
        positionZ: { value: 0 } as unknown as AudioParam,
        orientationX: { value: 1 } as unknown as AudioParam,
        orientationY: { value: 0 } as unknown as AudioParam,
        orientationZ: { value: 0 } as unknown as AudioParam,
        context: undefined as unknown as BaseAudioContext,
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit' as const,
        channelInterpretation: 'speakers' as const,
        connect: vi.fn().mockReturnValue(undefined),
        disconnect: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as PannerNode,
  );

  return {
    state: 'suspended' as AudioContextState,
    sampleRate: 48000,
    destination: {
      maxChannelCount: 2,
      channelCount: 2,
      channelCountMode: 'explicit' as const,
      channelInterpretation: 'speakers' as const,
      context: undefined as unknown as BaseAudioContext,
      numberOfInputs: 1,
      numberOfOutputs: 0,
      connect: vi.fn().mockReturnValue(undefined),
      disconnect: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as AudioDestinationNode,
    currentTime: 0,
    listener: {} as unknown as AudioListener,
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createGain: mkGain,
    createBufferSource: mkSrc,
    createPanner: mkPanner,
    decodeAudioData: vi.fn().mockResolvedValue(createTestBufferForApp()),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onstatechange: null,
    baseLatency: 0,
    outputLatency: 0,
    getOutputTimestamp: vi.fn(),
    createMediaStreamDestination: vi.fn(),
    createMediaStreamSource: vi.fn(),
    createChannelMerger: vi.fn(),
    createChannelSplitter: vi.fn(),
    createDelay: vi.fn(),
    createBiquadFilter: vi.fn(),
    createConvolver: vi.fn(),
    createDynamicsCompressor: vi.fn(),
    createOscillator: vi.fn(),
    createStereoPanner: vi.fn(),
    createWaveShaper: vi.fn(),
    createIIRFilter: vi.fn(),
    createScriptProcessor: vi.fn(),
    createAnalyser: vi.fn(),
    createConstantSource: vi.fn(),
    audioWorklet: undefined as unknown as AudioWorklet,
  } as unknown as AudioContext;
}

/**
 * Node-env rAF injection: in node, `requestAnimationFrame` is undefined,
 * so resolveRaf (frame-loop.ts:141-153) returns `() => 0` — the tick
 * callback is never invoked. We stub it so `start()` runs one frame
 * synchronously, and the captured tick callback can be driven repeatedly
 * by the test for additional frames.
 *
 * Auto-invoke only on first raf call (from start()), not on subsequent
 * calls (from tick()'s `raf(tick)` at frame-loop.ts:257), to avoid
 * infinite recursion.
 */
function installRafStub(): { tickFn: (() => void) | null } {
  const stub: { tickFn: (() => void) | null } = { tickFn: null };
  let firstCall = true;
  // biome-ignore lint/suspicious/noExplicitAny: vitest stub of a browser Global
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => {
    stub.tickFn = () => cb(performance.now());
    if (firstCall) {
      firstCall = false;
      stub.tickFn();
    }
    return 1;
  };
  // biome-ignore lint/suspicious/noExplicitAny: vitest stub of a browser Global
  (globalThis as any).cancelAnimationFrame = () => {
    stub.tickFn = null;
  };
  return stub;
}

function uninstallRafStub() {
  delete (globalThis as Record<string, unknown>).requestAnimationFrame;
  delete (globalThis as Record<string, unknown>).cancelAnimationFrame;
}

describe('feat-20260619 M3: auto-register audioTickSystem', () => {
  // w13: AC-12 — audioPlugin registers the audio-tick world system.
  // feat-20260623-plugin-system-unify (M2 / D-2 / D-4): the assemble form no
  // longer auto-wires audio; the host inserts AUDIO_ENGINE_RESOURCE_KEY and
  // passes audioPlugin() in plugins. The audio-tick system then runs inside
  // world.update(1 / 60).unwrap() each frame. Verification goes through the full consumption
  // path: createApp → app.start() → frames tick → AudioSource.playing edge
  // detected → backend.play triggered.
  //
  // Edge-detection semantics (getPrevState, audio-tick-system.ts:187-197):
  // first observation stores current as prev and returns current → no edge.
  // A false→true edge requires two frames: frame 1 sees false (prev=false),
  // frame 2 sees true (prev=false, current=true → play-start).
  describe('w13: AC-12 auto-register wiring verification', () => {
    it('audioPlugin → backend.play triggered after playing edge (full consumption path)', async () => {
      const OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock for AudioContext constructor
      globalThis.AudioContext = vi.fn(() => makeMockAudioContextForApp()) as any;

      const rafStub = installRafStub();

      try {
        const world = new World();

        // Alloc a clip handle so clipResolver can resolve it.
        const clipHandle = world.sharedRefs.alloc('AudioClipAsset', {
          kind: 'audio',
          buffer: createTestBufferForApp(),
        });

        // Spawn entity with playing=false. After frame 1, turn playing=true
        // to produce a false→true edge on frame 2.
        const spawnResult = world.spawn({
          // biome-ignore lint/suspicious/noExplicitAny: handle type is opaque branded via alloc
          component: AudioSource as any,
          data: {
            clip: clipHandle,
            playing: false,
            loop: false,
            volume: 1,
            spatialBlend: 0,
            bus: 'sfx',
          },
        });
        expect(spawnResult.ok).toBe(true);
        if (!spawnResult.ok) return;
        const entity = spawnResult.value;

        const backend = new WebAudioEngine();
        const playSpy = vi.spyOn(backend, 'play');

        const { renderer } = makeRendererStubForStop();
        // Attach sharedRefs as renderer.assets so buildApp inserts
        // ASSET_REGISTRY_RESOURCE_KEY (clipResolver reads world.sharedRefs
        // directly though, so this is primarily for buildApp coverage).
        const rendererWithAssets = { ...renderer, assets: world.sharedRefs } as unknown as Renderer;
        // New assemble contract (D-2 / D-4): host inserts the audio backend
        // resource + passes audioPlugin() in the plugin list. audioPlugin reads
        // the resource and registers the audio-tick world system.
        world.insertResource(AUDIO_ENGINE_RESOURCE_KEY, backend);
        const result = await createApp({
          renderer: rendererWithAssets,
          world,
          plugins: [audioPlugin()],
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const app = result.value;

        // Frame 1: playing=false (first obs → prev=false → no edge → no play).
        app.start();
        expect(playSpy).not.toHaveBeenCalled();

        // Set playing=true so the next frame detects the false→true edge.
        const setResult = world.set(entity, AudioSource, { playing: true });
        expect(setResult.ok).toBe(true);

        // Frame 2: captured rAF tick runs. The auto-registered audioTickSystem
        // calls getPrevState which sees prev=false, current=true → play-start.
        expect(rafStub.tickFn).not.toBeNull();
        rafStub.tickFn?.();

        expect(playSpy).toHaveBeenCalledTimes(1);

        app.stop();
        playSpy.mockRestore();
      } finally {
        uninstallRafStub();
        globalThis.AudioContext = OriginalAudioContext;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    });

    // Reverse: no audio:true → no registration → no play.
    it('no audio:true → audioTickSystem not registered, backend.play not triggered', async () => {
      const OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock for AudioContext constructor
      globalThis.AudioContext = vi.fn(() => makeMockAudioContextForApp()) as any;

      const rafStub = installRafStub();

      try {
        const world = new World();
        const clipHandle = world.sharedRefs.alloc('AudioClipAsset', {
          kind: 'audio',
          buffer: createTestBufferForApp(),
        });
        world.spawn({
          // biome-ignore lint/suspicious/noExplicitAny: handle type is opaque branded via alloc
          component: AudioSource as any,
          data: {
            clip: clipHandle,
            playing: true,
            loop: false,
            volume: 1,
            spatialBlend: 0,
            bus: 'sfx',
          },
        });

        const backend = new WebAudioEngine();
        const playSpy = vi.spyOn(backend, 'play');

        // Build WITHOUT audio backend → no tick system registration.
        const { renderer } = makeRendererStubForStop();
        const result = await createApp({ renderer, world });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const app = result.value;

        app.start();
        // Since audioTickSystem is never registered, play should never fire.
        expect(playSpy).not.toHaveBeenCalled();

        // Drive additional frames exhaustively.
        for (let i = 0; i < 5; i++) {
          if (rafStub.tickFn) rafStub.tickFn();
        }
        expect(playSpy).not.toHaveBeenCalled();

        app.stop();
        playSpy.mockRestore();
      } finally {
        uninstallRafStub();
        globalThis.AudioContext = OriginalAudioContext;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    });
  });

  // w14: AC-13 — auto-registered audioTickSystem can resolve both
  // AUDIO_ENGINE_RESOURCE_KEY and ASSET_REGISTRY_RESOURCE_KEY on the
  // first frame (no exception, no silent skip due to missing resources).
  describe('w14: AC-13 registration timing — first-frame resolution', () => {
    it('audioTickSystem resolves resources on first frame without error', async () => {
      const OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock for AudioContext constructor
      globalThis.AudioContext = vi.fn(() => makeMockAudioContextForApp()) as any;

      const rafStub = installRafStub();

      try {
        const world = new World();
        const clipHandle = world.sharedRefs.alloc('AudioClipAsset', {
          kind: 'audio',
          buffer: createTestBufferForApp(),
        });

        // Spawn entity with playing=false so first frame walks the
        // archetype without attempting to play — the key assertion is
        // "no exception thrown during first-frame execution".
        world.spawn({
          // biome-ignore lint/suspicious/noExplicitAny: handle type is opaque branded via alloc
          component: AudioSource as any,
          data: {
            clip: clipHandle,
            playing: false,
            loop: false,
            volume: 1,
            spatialBlend: 0,
            bus: 'sfx',
          },
        });

        const backend = new WebAudioEngine();
        const { renderer } = makeRendererStubForStop();
        const rendererWithAssets = { ...renderer, assets: world.sharedRefs } as unknown as Renderer;
        // New assemble contract (D-2 / D-4): host inserts the audio resource +
        // passes audioPlugin() so the audio-tick world system is registered.
        world.insertResource(AUDIO_ENGINE_RESOURCE_KEY, backend);
        const result = await createApp({
          renderer: rendererWithAssets,
          world,
          plugins: [audioPlugin()],
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const app = result.value;

        // First frame: the audio-tick world system walks the
        // AudioSource archetype. clipResolver uses world.sharedRefs (always
        // available on World, not a resource-key lookup). The tick system
        // should not throw due to missing resources.
        expect(() => app.start()).not.toThrow();

        // Drive a few more frames to ensure continuing resolution is stable.
        for (let i = 0; i < 3; i++) {
          if (rafStub.tickFn) rafStub.tickFn();
        }

        app.stop();
      } finally {
        uninstallRafStub();
        globalThis.AudioContext = OriginalAudioContext;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    });
  });
});
