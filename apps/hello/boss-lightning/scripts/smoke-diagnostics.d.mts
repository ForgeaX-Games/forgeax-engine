export const READINESS_FRAME_LIMIT: number;

export function classifyDawnErrors(
  errors: readonly {
    code: string;
    detail?: unknown;
    frame: number;
  }[],
  readinessFrame: number | undefined,
): {
  warmupErrors: readonly unknown[];
  persistentErrors: readonly unknown[];
};

export function assertAtomicPatchSnapshot(snapshot: {
  readonly before: { readonly generation: number; readonly payload: readonly number[] };
  readonly after: { readonly generation: number; readonly payload: readonly number[] };
}): void;
