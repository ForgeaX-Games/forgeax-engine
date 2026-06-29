// web-audio-engine.ts -- M2 (w16) WebAudioEngine AudioBackend implementation
//
// Implements AudioBackend for Web Audio API:
//   1. Lazy AudioContext creation (D-3) -- ensureContext() on first play()
//   2. One-shot gesture listener resume (D-3) -- register 'click'/'keydown'/'touchstart'
//      listeners that call ctx.resume() and self-remove
//   3. Fixed two-bus topology (D-5): masterGain <= sfxGain + musicGain
//   4. Per-source GainNode for individual volume control
//   5. Active source Map<entityId, { node, sourceGain, bus }>
//   6. Health check: getState() / getActiveSourceCount()
//   7. destroy(): stop all, disconnect, close ctx
//
// Decision anchors:
// - plan-strategy D-3 (lazy-create + one-shot gesture listener resume)
// - plan-strategy D-5 (fixed two-bus topology: SFX + Music -> Master)
// - plan-strategy section 3.1 (WebAudioEngine owner of AudioContext + bus GainNodes)
// - requirements S-1 (AudioContext lifecycle), S-5 (dual bus), S-9 (World Resource)
// - requirements AC-01 (lazy creation), AC-02 (auto resume), AC-10 (bus volume/mute)
//
// charter awareness:
// - P3 explicit failure: getState() returns real AudioContext.state, never a stale cache
// - P4 consistent abstraction: implements AudioBackend interface, parallel to InputBackend

import type { AudioBackend, AudioPlayOptions, AudioState, BusName } from '@forgeax/engine-audio';
import type { TickStateEntry } from './audio-tick-system';

interface ActiveSource {
  node: AudioBufferSourceNode;
  sourceGain: GainNode;
  panner: PannerNode | undefined;
  bus: BusName;
}

const GESTURE_EVENTS = ['click', 'keydown', 'touchstart'] as const;

export class WebAudioEngine implements AudioBackend {
  private ctx: AudioContext | undefined;
  private closed = false;
  private masterGain: GainNode | undefined;
  private sfxGain: GainNode | undefined;
  private musicGain: GainNode | undefined;

  private readonly sources = new Map<number, ActiveSource>();

  private gestureListening = false;
  private readonly gestureResumeHandler: () => void;

  // Per-bus previous-volume cache for mute/unmute restore (D-5).
  private readonly busVolumes = new Map<BusName, number>([
    ['sfx', 1],
    ['music', 1],
  ]);
  private readonly busMuted = new Map<BusName, boolean>([
    ['sfx', false],
    ['music', false],
  ]);

  // F25 de-singleton: per-entity tick state lives on the engine instance,
  // not in module-level singletons. audioTickSystem reads these via same-package
  // narrow (D-1). Each WebAudioEngine owns its own tick history.
  /** @internal */
  readonly _tickStates = new Map<number, TickStateEntry>();
  /** @internal */
  readonly _prevFrameEntities = new Set<number>();

  constructor() {
    // Lazy: AudioContext is NOT created here (D-3 / AC-01).
    // The gesture resume handler is a bound arrow so we can pass it
    // to addEventListener/removeEventListener with the same identity.
    this.gestureResumeHandler = () => {
      void this.tryResume();
    };
  }

  /**
   * Returns the Web Audio AudioListener for spatialization (D-2).
   * Triggers lazy ensureContext() on first access.
   * Returns undefined if the context could not be created or is closed.
   */
  get listener(): AudioListener | undefined {
    return this.ensureContext().listener;
  }

  // -----------------------------------------------------------------------
  // ensureContext -- lazy AudioContext + bus topology creation
  // -----------------------------------------------------------------------

  private ensureContext(): AudioContext {
    if (this.ctx) {
      return this.ctx;
    }

    const ctx = new AudioContext();

    // Build bus topology: masterGain <= sfxGain + musicGain
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);

    const sfx = ctx.createGain();
    sfx.gain.value = 1;
    sfx.connect(master);

    const music = ctx.createGain();
    music.gain.value = 1;
    music.connect(master);

    this.ctx = ctx;
    this.masterGain = master;
    this.sfxGain = sfx;
    this.musicGain = music;

    // Register one-shot gesture listener if ctx is suspended (autoplay gate).
    this.registerGestureListener(ctx);

    return ctx;
  }

  // -----------------------------------------------------------------------
  // Gesture listener -- D-3 one-shot resume on user gesture
  // -----------------------------------------------------------------------

  private registerGestureListener(ctx: AudioContext): void {
    if (ctx.state !== 'suspended') {
      return;
    }
    if (this.gestureListening) {
      return;
    }

    this.gestureListening = true;
    for (const event of GESTURE_EVENTS) {
      document.addEventListener(event, this.gestureResumeHandler, { once: true });
    }
  }

  private removeGestureListener(): void {
    if (!this.gestureListening) {
      return;
    }
    this.gestureListening = false;
    for (const event of GESTURE_EVENTS) {
      document.removeEventListener(event, this.gestureResumeHandler);
    }
  }

  private async tryResume(): Promise<void> {
    if (!this.ctx) return;
    if (this.ctx.state !== 'suspended') return;

    try {
      await this.ctx.resume();
    } catch {
      // Resume failed -- state stays suspended. The tick system (M3) will
      // defer playback until ctx.state becomes 'running' (charter P3).
    } finally {
      this.removeGestureListener();
    }
  }

  // -----------------------------------------------------------------------
  // AudioBackend implementation
  // -----------------------------------------------------------------------

  play(entityId: number, clipBuffer: AudioBuffer, opts: AudioPlayOptions): void {
    // If this entity is already playing, stop it first (replace).
    if (this.sources.has(entityId)) {
      this.stop(entityId);
    }

    const ctx = this.ensureContext();

    // Per-source GainNode for volume control
    const sourceGain = ctx.createGain();
    sourceGain.gain.value = opts.volume;

    // PannerNode for 3D spatialization (D-2 equalpower default)
    let panner: PannerNode | undefined;
    if (opts.spatialBlend > 0) {
      panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
    }

    // Route to the appropriate bus (gain nodes guaranteed by ensureContext above)
    const busGain = this.busGainFor(opts.bus);
    if (!busGain) return;

    if (panner) {
      sourceGain.connect(panner);
      panner.connect(busGain);
    } else {
      sourceGain.connect(busGain);
    }

    // Create AudioBufferSourceNode for one-shot playback
    const node = ctx.createBufferSource();
    node.buffer = clipBuffer;
    node.loop = opts.loop;
    node.connect(sourceGain);
    node.start();

    // Bookkeeping
    this.sources.set(entityId, { node, sourceGain, panner, bus: opts.bus });

    // F24: attach onended for non-loop sources with identity guard (D-5).
    // Loop sources never naturally end — no onended needed.
    if (!opts.loop) {
      node.onended = () => {
        const current = this.sources.get(entityId);
        if (current?.node === node) {
          this.stop(entityId);
        }
      };
    }
  }

  stop(entityId: number): void {
    const source = this.sources.get(entityId);
    if (!source) return;

    try {
      source.node.stop();
    } catch {
      // Already stopped -- ignore InvalidStateError from doubly-stopped nodes.
    }
    source.node.disconnect();
    source.sourceGain.disconnect();
    this.sources.delete(entityId);
  }

  setVolume(entityId: number, volume: number): void {
    const source = this.sources.get(entityId);
    if (!source) return;
    source.sourceGain.gain.value = volume;
  }

  setBusVolume(busName: BusName, volume: number): void {
    const gain = this.busGainFor(busName);
    if (!gain) return;

    gain.gain.value = volume;
    this.busVolumes.set(busName, volume);

    // If we were muted, un-mute (setting volume is an explicit un-mute signal).
    if (this.busMuted.get(busName)) {
      this.busMuted.set(busName, false);
    }
  }

  setBusMute(busName: BusName, muted: boolean): void {
    const gain = this.busGainFor(busName);
    if (!gain) return;

    if (muted) {
      // Remember current volume before muting
      const prev = gain.gain.value;
      if (prev > 0) {
        this.busVolumes.set(busName, prev);
      }
      this.busMuted.set(busName, true);
      gain.gain.value = 0;
    } else {
      this.busMuted.set(busName, false);
      // Restore previous volume
      gain.gain.value = this.busVolumes.get(busName) ?? 1;
    }
  }

  getState(): AudioState {
    if (this.closed) {
      return { contextState: 'closed', activeSourceCount: 0 };
    }
    const contextState: 'running' | 'suspended' | 'closed' =
      this.ctx?.state === 'closed'
        ? 'closed'
        : this.ctx?.state === 'running'
          ? 'running'
          : 'suspended';
    return {
      contextState,
      activeSourceCount: this.sources.size,
    };
  }

  getActiveSourceCount(): number {
    return this.sources.size;
  }

  destroy(): void {
    // Stop all active sources
    for (const entityId of this.sources.keys()) {
      this.stop(entityId);
    }

    // Disconnect bus topology
    if (this.sfxGain) {
      this.sfxGain.disconnect();
      this.sfxGain = undefined;
    }
    if (this.musicGain) {
      this.musicGain.disconnect();
      this.musicGain = undefined;
    }
    if (this.masterGain) {
      this.masterGain.disconnect();
      this.masterGain = undefined;
    }

    // Remove gesture listener
    this.removeGestureListener();

    // Close AudioContext (irreversible per R-4)
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = undefined;
    }
    this.closed = true;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private busGainFor(busName: BusName): GainNode | undefined {
    switch (busName) {
      case 'sfx':
        return this.sfxGain;
      case 'music':
        return this.musicGain;
    }
  }
}

export function createWebAudioBackend(): AudioBackend {
  return new WebAudioEngine();
}
