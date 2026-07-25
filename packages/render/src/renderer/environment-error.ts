import type { RhiError } from '@forgeax/engine-rhi';
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
