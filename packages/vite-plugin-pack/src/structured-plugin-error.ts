export interface StructuredPluginFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
  readonly cause?: unknown;
}

/** Preserve machine-readable recovery fields while satisfying Vite's thrown-error boundary. */
export function structuredPluginError(
  failure: StructuredPluginFailure,
): Error & StructuredPluginFailure {
  return Object.assign(new Error(`${failure.code}: ${failure.expected}`), failure);
}
