export type PluginPackFailureStage =
  | 'config'
  | 'scan'
  | 'produce'
  | 'finalize'
  | 'commit'
  | 'emit'
  | 'watch'
  | 'route'
  | 'cleanup';

export type PluginPackFailureCode =
  | 'config-failed'
  | 'scan-failed'
  | 'produce-failed'
  | 'finalize-failed'
  | 'commit-failed'
  | 'emit-failed'
  | 'watch-failed'
  | 'route-failed'
  | 'cleanup-failed'
  | 'stale-generation';

export interface PluginPackFailureDetail {
  readonly stage: PluginPackFailureStage;
  readonly subject?: string;
}

export interface PluginPackFailure {
  readonly code: PluginPackFailureCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PluginPackFailureDetail;
  readonly cause?: unknown;
  readonly cleanup?: readonly PluginPackFailure[];
}

export function createPluginPackFailure(
  input: Omit<PluginPackFailure, 'cleanup'>,
): PluginPackFailure {
  return {
    code: input.code,
    expected: input.expected,
    hint: input.hint,
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };
}

export function appendPluginPackCleanup(
  primary: PluginPackFailure,
  cleanup: PluginPackFailure,
): PluginPackFailure {
  return {
    ...primary,
    cleanup: [...(primary.cleanup ?? []), cleanup],
  };
}
