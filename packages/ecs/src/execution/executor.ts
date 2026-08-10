import type { QuerySpan } from '../query/query';
import type { SharedKernelDispatch } from './shared-kernel';

export const SHARED_KERNEL_EXECUTOR_RESOURCE_KEY = 'SharedKernelExecutor';

export interface KernelDispatchResult {
  readonly mode: 'forced-inline' | 'shared';
  readonly dispatched: number;
  readonly completed: number;
  readonly waitMs: number;
}

export interface KernelDispatchFailure {
  readonly cause: unknown;
  readonly dispatched: number;
  readonly completed: number;
  readonly partialWrite: boolean;
}

export interface KernelDispatchSpan {
  readonly queryIndex: number;
  readonly span: QuerySpan;
}

export interface SharedKernelExecutor {
  warmup?(kernel: SharedKernelDispatch): void;
  execute(
    kernel: SharedKernelDispatch,
    spans: readonly KernelDispatchSpan[],
  ): KernelDispatchResult | KernelDispatchFailure;
}

export function isKernelDispatchFailure(
  value: KernelDispatchResult | KernelDispatchFailure,
): value is KernelDispatchFailure {
  return 'cause' in value;
}
