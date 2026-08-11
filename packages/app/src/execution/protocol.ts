import type { AudioIntent } from '@forgeax/engine-audio';
import type { InputBackendSample } from '@forgeax/engine-input';

export interface ExecutionFrameMessage {
  readonly kind: 'frame';
  readonly worldIdentity: string;
  readonly frameId: number;
  readonly deltaSeconds: number;
  readonly inputSample: InputBackendSample;
}

export interface ExecutionFrameCompletion {
  readonly kind: 'frame-complete';
  readonly worldIdentity: string;
  readonly frameId: number;
  readonly engineUpdateMs: number;
  readonly kernelWaitMs: number;
  readonly audioIntents?: readonly AudioIntent[];
  readonly kernelDispatch?: {
    readonly eligible: boolean;
    readonly usedShared: boolean;
    readonly reason: import('./types').KernelDispatchReason;
    readonly dispatched: number;
    readonly completed: number;
  };
}

export type FrameCompletionDisposition = 'accepted' | 'duplicate' | 'stale-world' | 'late';

export class FrameCreditLedger {
  private nextFrameId = 1;
  private inFlight: number | null = null;
  private completed = 0;

  constructor(readonly worldIdentity: string) {}

  issue(
    deltaSeconds: number,
    sampleInput: () => InputBackendSample,
  ): ExecutionFrameMessage | undefined {
    if (this.inFlight !== null) return undefined;
    const frameId = this.nextFrameId;
    this.nextFrameId += 1;
    this.inFlight = frameId;
    return {
      kind: 'frame',
      worldIdentity: this.worldIdentity,
      frameId,
      deltaSeconds,
      inputSample: sampleInput(),
    };
  }

  complete(message: ExecutionFrameCompletion): FrameCompletionDisposition {
    if (message.worldIdentity !== this.worldIdentity) return 'stale-world';
    if (message.frameId <= this.completed) return 'duplicate';
    if (message.frameId !== this.inFlight) return 'late';
    this.completed = message.frameId;
    this.inFlight = null;
    return 'accepted';
  }

  get hasCreditInFlight(): boolean {
    return this.inFlight !== null;
  }
}

export interface ExecutionInitMessage {
  readonly kind: 'init';
  readonly canvas: OffscreenCanvas;
  readonly bootstrapUrl: string;
  readonly bootstrapData?: import('./types').ExecutionBootstrapValue;
  readonly bootstrapPort?: MessagePort;
  readonly shaderManifestUrl?: string;
  readonly time?: import('@forgeax/engine-ecs').TimePolicy;
  readonly tier: import('./types').ExecutionTier;
}

export interface ExecutionHostControlMessage {
  readonly kind: 'host-control';
  readonly command: 'set-pointer-lock-allowed';
  readonly allowed: boolean;
}

export interface ExecutionReadyMessage {
  readonly kind: 'ready';
  readonly worldIdentity: string;
  readonly realm: 'worker';
  readonly workerWebGpu: boolean;
}

export interface ExecutionFaultMessage {
  readonly kind: 'fault';
  readonly worldIdentity: string | null;
  readonly source: 'bootstrap' | 'handshake' | 'runtime' | 'kernel' | 'world' | 'rebuild';
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
  readonly partialWrite: boolean;
  readonly retryable: boolean;
}

export interface ExecutionRebuildMessage {
  readonly kind: 'rebuild';
  readonly worldIdentity: string;
}

export interface ExecutionRebuiltMessage {
  readonly kind: 'rebuilt';
  readonly previousWorldIdentity: string;
  readonly worldIdentity: string;
}

export type HostToEngineMessage =
  | ExecutionInitMessage
  | ExecutionFrameMessage
  | ExecutionRebuildMessage
  | { readonly kind: 'dispose' };
export type EngineToHostMessage =
  | ExecutionReadyMessage
  | ExecutionFrameCompletion
  | ExecutionFaultMessage
  | ExecutionRebuiltMessage
  | ExecutionHostControlMessage;
