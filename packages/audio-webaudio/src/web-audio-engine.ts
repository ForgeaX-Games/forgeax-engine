// web-audio-engine.ts -- M2 (w16) WebAudioEngine AudioBackend implementation
//
// Implements AudioBackend for Web Audio API:
//   1. Lazy AudioContext creation (D-3) -- ensureContext() on first play()
//   2. Gesture listener resume (D-3) -- register bounded 'click'/'keydown'/'touchstart'
//      listeners that call ctx.resume(), re-arming them after a refusal
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

import {
  AUDIO_ERROR_HINTS,
  AudioError,
  type AudioListenerPose,
  type AudioPlayOptions,
  type AudioState,
  type BusName,
} from '@forgeax/engine-audio';
import type { AudioClipAsset } from '@forgeax/engine-types';

interface ActiveSource {
  node: AudioBufferSourceNode;
  sourceGain: GainNode;
  panner: PannerNode | undefined;
  bus: BusName;
}

const GESTURE_EVENTS = ['click', 'keydown', 'touchstart'] as const;
const GAIN_TRANSITION_SECONDS = 0.01;

export class WebAudioEngine {
  private ctx: AudioContext | undefined;
  private closed = false;
  private masterGain: GainNode | undefined;
  private sfxGain: GainNode | undefined;
  private musicGain: GainNode | undefined;

  private readonly sources = new Map<number, ActiveSource>();

  private gestureListening = false;
  private resumeInFlight: Promise<void> | undefined;
  private readonly gestureResumeHandler: () => void;
  private lastError: AudioError | null = null;

  // Per-bus previous-volume cache for mute/unmute restore (D-5).
  private readonly busVolumes = new Map<BusName, number>([
    ['sfx', 1],
    ['music', 1],
  ]);
  private readonly busMuted = new Map<BusName, boolean>([
    ['sfx', false],
    ['music', false],
  ]);

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

  setListenerPose(pose: AudioListenerPose): void {
    const listener = this.ensureContext().listener;
    listener.positionX.value = pose.positionX;
    listener.positionY.value = pose.positionY;
    listener.positionZ.value = pose.positionZ;
    listener.forwardX.value = pose.forwardX;
    listener.forwardY.value = pose.forwardY;
    listener.forwardZ.value = pose.forwardZ;
    listener.upX.value = pose.upX;
    listener.upY.value = pose.upY;
    listener.upZ.value = pose.upZ;
  }

  // -----------------------------------------------------------------------
  // ensureContext -- lazy AudioContext + bus topology creation
  // -----------------------------------------------------------------------

  private ensureContext(): AudioContext {
    if (this.ctx) {
      this.registerGestureListener(this.ctx);
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

    // Register the bounded gesture listener set if ctx is suspended (autoplay gate).
    this.registerGestureListener(ctx);

    return ctx;
  }

  // -----------------------------------------------------------------------
  // Gesture listener -- D-3 bounded resume retry on user gesture
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
    const ctx = this.ctx;
    if (!ctx || this.closed || ctx.state !== 'suspended') return;
    if (this.resumeInFlight !== undefined) return this.resumeInFlight;

    const attempt = (async () => {
      try {
        await ctx.resume();
      } catch {
        // Inspect the real context state below so refusal remains recoverable.
      } finally {
        if (!this.closed && this.ctx === ctx) {
          if (ctx.state === 'running') {
            this.lastError = null;
            this.removeGestureListener();
          } else if (ctx.state === 'suspended') {
            this.recordResumeFailure();
            this.rearmGestureListener(ctx);
          } else {
            this.removeGestureListener();
          }
        }
        this.resumeInFlight = undefined;
      }
    })();
    this.resumeInFlight = attempt;
    return attempt;
  }

  private recordResumeFailure(): void {
    this.lastError = new AudioError({
      code: 'context-suspended',
      expected: 'AudioContext.resume() to make the existing context running',
      hint: AUDIO_ERROR_HINTS['context-suspended'],
      detail: { code: 'context-suspended' },
    });
  }

  private recordDecodeFailure(sourceKey: string, cause: unknown): void {
    this.lastError = new AudioError({
      code: 'decode-failed',
      expected: `browser-decodable audio bytes for sourceKey ${sourceKey}`,
      hint: AUDIO_ERROR_HINTS['decode-failed'],
      detail: {
        code: 'decode-failed',
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    });
  }

  private rearmGestureListener(ctx: AudioContext): void {
    this.removeGestureListener();
    this.registerGestureListener(ctx);
  }

  // -----------------------------------------------------------------------
  // AudioBackend implementation
  // -----------------------------------------------------------------------

  decode(bytes: Uint8Array): Promise<AudioBuffer> {
    return this.ensureContext().decodeAudioData(bytes.slice().buffer as ArrayBuffer);
  }

  play(entityId: number, clip: AudioBuffer | AudioClipAsset, opts: AudioPlayOptions): void {
    if ('kind' in clip) {
      void this.decode(clip.bytes).then(
        (buffer) => {
          if (this.lastError?.code === 'decode-failed') {
            this.lastError = null;
          }
          this.play(entityId, buffer, opts);
        },
        (cause) => this.recordDecodeFailure(clip.sourceKey, cause),
      );
      return;
    }
    const clipBuffer = clip;
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
    source.panner?.disconnect();
    this.sources.delete(entityId);
  }

  setVolume(entityId: number, volume: number): void {
    const source = this.sources.get(entityId);
    if (!source) return;
    this.scheduleGainTransition(source.sourceGain, volume);
  }

  setBusVolume(busName: BusName, volume: number): void {
    const gain = this.busGainFor(busName);
    if (!gain) return;

    if (!this.scheduleGainTransition(gain, volume)) return;
    this.busVolumes.set(busName, volume);

    // If we were muted, un-mute (setting volume is an explicit un-mute signal).
    if (this.busMuted.get(busName)) {
      this.busMuted.set(busName, false);
    }
  }

  setBusMute(busName: BusName, muted: boolean): void {
    const gain = this.busGainFor(busName);
    if (!gain) return;

    const target = muted ? 0 : (this.busVolumes.get(busName) ?? 1);
    if (!this.scheduleGainTransition(gain, target)) return;
    this.busMuted.set(busName, muted);
  }

  getState(): AudioState {
    if (this.closed) {
      return { contextState: 'closed', activeSourceCount: 0, lastError: null };
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
      lastError: this.lastError,
    };
  }

  getActiveSourceCount(): number {
    return this.sources.size;
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;

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
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private scheduleGainTransition(gain: GainNode, target: number): boolean {
    if (!this.ctx || !Number.isFinite(target) || target < 0) return false;

    const now = this.ctx.currentTime;
    const param = gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + GAIN_TRANSITION_SECONDS);
    return true;
  }

  private busGainFor(busName: BusName): GainNode | undefined {
    switch (busName) {
      case 'sfx':
        return this.sfxGain;
      case 'music':
        return this.musicGain;
    }
  }
}
