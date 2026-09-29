/** Closed, consumer-facing failures for the detached SSR M0 contract. */
export type SsrAdmissionErrorCode =
  | 'ssr-not-requested'
  | 'ssr-reflection-fallback-unavailable'
  | 'ssr-format-unavailable'
  | 'ssr-temporal-unavailable'
  | 'ssr-receipt-identity-mismatch'
  | 'ssr-receipt-stale';

export type SsrOwnerRecoveryAction =
  | 'use-LKG'
  | 'use-Skylight'
  | 'use-neutral'
  | 'recapture'
  | 'rebuild'
  | 'retry';

export type SsrAdmissionErrorDetail =
  | {
      readonly code: 'ssr-not-requested';
      readonly owner: 'consumer';
      readonly action: 'retry';
    }
  | {
      readonly code: 'ssr-reflection-fallback-unavailable';
      readonly owner: 'producer';
      readonly action: 'use-LKG' | 'use-Skylight' | 'use-neutral' | 'recapture' | 'rebuild';
    }
  | {
      readonly code: 'ssr-format-unavailable';
      readonly owner: 'format';
      readonly action: 'rebuild' | 'retry';
      readonly stage?: string;
    }
  | {
      readonly code: 'ssr-temporal-unavailable';
      readonly owner: 'temporal';
      readonly action: 'rebuild' | 'retry';
    }
  | {
      readonly code: 'ssr-receipt-identity-mismatch';
      readonly owner: 'producer' | 'format' | 'temporal';
      readonly action: 'rebuild';
      readonly identityField: 'sourceHead' | 'sourceTree' | 'lockSha256' | 'buildSha256';
    }
  | {
      readonly code: 'ssr-receipt-stale';
      readonly owner: 'consumer';
      readonly action: 'retry';
      readonly generation: number;
    };

export interface SsrAdmissionError {
  readonly code: SsrAdmissionErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SsrAdmissionErrorDetail;
}

/** Closed authoring fields accepted by the ScreenSpaceReflection schema. */
export type SsrConfigField = 'maxDistance' | 'thickness' | 'maxRoughness';

/** Dynamic finite range returned by ScreenSpaceReflection validation. */
export interface SsrConfigRange {
  readonly min: number;
  readonly minInclusive: boolean;
  readonly max: number;
  readonly maxInclusive: boolean;
}

/** Structured invalid-authoring failure; callers branch on code and detail. */
export interface SsrConfigInvalidError {
  readonly code: 'ssr-config-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly field: SsrConfigField;
    readonly value: number;
    readonly range: SsrConfigRange;
  };
}

/** Closed spatial admission reasons. */
export type SsrSpatialUnavailableReason =
  | 'lane-unsupported'
  | 'projection-unsupported'
  | 'scene-input-unavailable'
  | 'capability-unavailable'
  | 'format-unavailable'
  | 'temporal-unavailable'
  | 'reflection-fallback-unavailable'
  | 'recovery-unavailable';

/** Structured spatial admission failure with bounded actual facts. */
export interface SsrUnavailableError {
  readonly code: 'ssr-unavailable';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly lane: string;
    readonly reason: SsrSpatialUnavailableReason;
    readonly required: readonly string[];
    readonly actual: Readonly<Record<string, boolean | number | string>>;
    readonly recovery: string;
  };
}

const EXPECTED = 'all detached SSR dependency receipts share one admitted identity';

export function createSsrAdmissionError(detail: SsrAdmissionErrorDetail): SsrAdmissionError {
  const hint =
    detail.action === 'use-LKG'
      ? 'use the producer last-known-good receipt before retrying admission'
      : detail.action === 'use-Skylight'
        ? 'use the producer Skylight receipt before retrying admission'
        : detail.action === 'use-neutral'
          ? 'use the producer neutral receipt before retrying admission'
          : detail.action === 'recapture'
            ? 'ask the producer owner to recapture and publish a detached receipt'
            : detail.action === 'rebuild'
              ? 'ask the owning producer to rebuild and publish a matching detached receipt'
              : 'retry after the owner publishes a matching detached receipt';
  return Object.freeze({ code: detail.code, expected: EXPECTED, hint, detail });
}
