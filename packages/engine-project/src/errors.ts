// errors.ts — GameProjectError class (D-2)
//
// Four-field surface: .code / .expected / .hint / .detail
// Structurally parallel to PackError (engine-pack) — same interface shape
// (charter P4 consistent abstraction), but own code union (D-2: pipe isolation).
// GUID format failure translates PackError → GameProjectError(code='forge-guid-malformed')
// so PackError never leaks to engine-project public surface.
//
// AI users consume via exhaustive switch on .code — no default case needed:
// ```ts
// switch (err.code) {
//   case 'forge-missing':    console.error(err.detail.path); break;
//   case 'forge-parse-failed': console.error(err.detail.rawMessage); break;
//   // ... all 6 cases
// }
// ```

import type { z } from 'zod';

// ── code union (6 members, self-contained within engine-project) ────────────
export type GameProjectErrorCode =
  | 'forge-missing'
  | 'forge-parse-failed'
  | 'forge-schema-invalid'
  | 'forge-unknown-field'
  | 'forge-guid-malformed'
  | 'forge-scene-unresolved';

// ── detail: discriminated union narrowed per code (D-2) ─────────────────────

/** forge.json file not found at the expected path. */
export interface ForgeMissingDetail {
  readonly path: string;
}

/** forge.json exists but contains invalid JSON. */
export interface ForgeParseFailedDetail {
  readonly path: string;
  readonly rawMessage: string;
}

/** forge.json is valid JSON but fails zod schema validation (missing required fields, wrong types). */
export interface ForgeSchemaInvalidDetail {
  readonly path: string;
  /** The zod issues from `safeParse(...).error.issues` — each names the failing path + reason. */
  readonly zodErrors: readonly z.ZodIssue[];
}

/** forge.json has .strict() rejected an unknown field (e.g. scenes[]). */
export interface ForgeUnknownFieldDetail {
  readonly path: string;
  readonly fieldNames: string[];
}

/** defaultScene GUID string is not a valid 36-char RFC 4122 dash-form UUID.
 *  cause is the original PackError from AssetGuid.parse (for debugging), NOT part of reserved union. */
export interface ForgeGuidMalformedDetail {
  readonly field: string;
  readonly rawInput: string;
  readonly cause?: unknown; // PackError from engine-pack, optional for debugging (D-2)
}

/** defaultScene GUID is valid format but resolveGuid could not find it or found wrong kind. */
export interface ForgeSceneUnresolvedDetail {
  readonly guid: string;
}

export type GameProjectErrorDetail =
  | ForgeMissingDetail
  | ForgeParseFailedDetail
  | ForgeSchemaInvalidDetail
  | ForgeUnknownFieldDetail
  | ForgeGuidMalformedDetail
  | ForgeSceneUnresolvedDetail;

// ── constructor args ────────────────────────────────────────────────────────

export interface GameProjectErrorArgs {
  readonly code: GameProjectErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: GameProjectErrorDetail;
}

// ── GameProjectError class (D-2) ─────────────────────────────────────────────

/**
 * Structured error for the @forgeax/engine-project loader + resolve layer.
 *
 * AI users consume via exhaustive switch on .code — no default case needed.
 * Aligns with PackError four-field surface (.code/.expected/.hint/.detail)
 * per charter P4 (consistent abstraction) and AC-10.
 */
export class GameProjectError extends Error {
  readonly code: GameProjectErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: GameProjectErrorDetail;

  constructor(args: GameProjectErrorArgs) {
    super(`[GameProjectError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'GameProjectError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}
