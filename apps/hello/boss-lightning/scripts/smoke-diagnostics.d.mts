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
