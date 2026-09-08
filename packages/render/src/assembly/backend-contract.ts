import type {
  Result,
  RhiCanvasContext,
  RhiDevice,
  RhiError,
  RhiInstance,
  ShaderModule,
} from '@forgeax/engine-rhi';

/** Optional host hooks for recorder and device-lifecycle capabilities. */
export interface RhiBackendInstrumentation {
  readonly resolveSurfaceDevice?: (device: RhiDevice) => Result<RhiDevice, RhiError>;
  readonly onFrameBoundary?: () => void;
  readonly onDeviceLost?: () => void;
}

/** Runtime-owned backend services injected into the render assembly. */
export interface RhiBackendPack {
  readonly rhi: RhiInstance & {
    readonly acquireCanvasContext: (
      canvas: HTMLCanvasElement | OffscreenCanvas,
    ) => Result<RhiCanvasContext, RhiError>;
  };
  readonly createShaderModule?: (
    device: RhiDevice,
    desc: { code: string; label?: string | undefined },
  ) => Promise<Result<ShaderModule, RhiError>>;
  readonly translateErrorEventToRhiError?: (event: unknown) => {
    readonly ok: false;
    readonly error: RhiError;
  };
  /** @internal */
  readonly _internal_getRawDevice?: (device: RhiDevice) => unknown | undefined;
  /** Optional lifecycle hooks owned by the host capability being injected. */
  readonly instrumentation?: RhiBackendInstrumentation;
}

export interface EngineEnvironmentErrorDetail {
  readonly webgpuError?: RhiError | Error | undefined;
  readonly wgpuError?: RhiError | Error | undefined;
}

export class EngineEnvironmentError extends Error {
  readonly reason: string;
  readonly webgpuError?: RhiError | Error | undefined;
  readonly wgpuError?: RhiError | Error | undefined;
  readonly detail: EngineEnvironmentErrorDetail;

  constructor(reason: string, detail: EngineEnvironmentErrorDetail = {}) {
    super(`forgeax-engine: no usable backend (${reason})`);
    this.name = 'EngineEnvironmentError';
    this.reason = reason;
    this.webgpuError = detail.webgpuError;
    this.wgpuError = detail.wgpuError;
    this.detail = detail;
  }
}
