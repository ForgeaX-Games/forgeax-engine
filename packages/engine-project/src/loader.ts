// loader.ts — loadGameProject + resolveDefaultScene (D-6, AC-06/07/08/09)
//
// loadGameProject: injection-only `read:(path)=>Promise<string>`, returns
//   GuidResult<GameProject, GameProjectError>. Five return paths:
//   1. read throws → ok:false, error(code='forge-missing')
//   2. JSON.parse fails → ok:false, error(code='forge-parse-failed')
//   3. schema.parse fails (missing fields) → ok:false, error(code='forge-schema-invalid')
//   3b. schema.parse fails (unknown fields via .strict()) → ok:false, error(code='forge-unknown-field')
//   4. defaultScene GUID format invalid → ok:false, error(code='forge-guid-malformed')
//   5. all valid → ok:true, value:GameProject
//
// resolveDefaultScene: {read, resolveGuid} dual-injection (AC-07). Independent
//   of loadGameProject (does NOT call resolveGuid internally).
//
// D-6: return type GuidResult<T,E> — same as AssetGuid.parse (engine-pack).
// D-2: PackError→GameProjectError translation for GUID format failures.

import type { GuidResult } from '@forgeax/engine-pack/guid';
import {
  GameProjectError,
  type GameProjectErrorCode,
  type GameProjectErrorDetail,
} from './errors.js';
import { FORGE_JSON } from './paths.js';
import type { GameProject } from './schema.js';
import { GameProjectSchema } from './schema.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function err(
  code: GameProjectErrorCode,
  expected: string,
  hint: string,
  detail: GameProjectErrorDetail,
) {
  return { ok: false as const, error: new GameProjectError({ code, expected, hint, detail }) };
}

function ok<T>(value: T) {
  return { ok: true as const, value };
}

// ── validateGameProject: sync pure core (JSON.parse → schema validate → 5 return paths) ──

/**
 * Validate raw forge.json text against GameProjectSchema.
 * Pure sync function — no I/O, no `read` injection.
 *
 * ## Return paths (4 — missing/read-error handled by callers)
 *
 * | # | Condition | ok | code |
 * |:--|:--|:--|:--|
 * | 1 | `JSON.parse` fails | false | `forge-parse-failed` |
 * | 2a | zod `.strict()` unknown fields (e.g. `scenes[]`) | false | `forge-unknown-field` |
 * | 2b | zod required field missing / wrong type | false | `forge-schema-invalid` |
 * | 2c | `defaultScene` present, GUID format invalid | false | `forge-guid-malformed` |
 * | 3 | all valid | true | — |
 */
export function validateGameProject(raw: string): GuidResult<GameProject, GameProjectError> {
  // ── 1. Parse JSON ─────────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    return err(
      'forge-parse-failed',
      'forge.json to be valid JSON',
      'check forge.json for JSON syntax errors (trailing commas, unquoted keys, etc.)',
      {
        path: FORGE_JSON,
        rawMessage: e instanceof Error ? e.message : String(e),
      },
    );
  }

  // ── 2. Schema validate (.strict() rejects unknown fields) ─────────────────
  const schemaResult = GameProjectSchema.safeParse(parsed);
  if (!schemaResult.success) {
    const zodErrors = schemaResult.error.issues;

    // 2a: unknown fields (scenes[] etc.) — detect by looking for unrecognized_keys
    const unknownFieldIssues = zodErrors.filter((i) => i.code === 'unrecognized_keys');
    if (unknownFieldIssues.length > 0) {
      const fieldNames = unknownFieldIssues.flatMap((i) => (i as { keys?: string[] }).keys ?? []);
      return err(
        'forge-unknown-field',
        'forge.json to not contain unknown fields (e.g. scenes[])',
        'remove unknown fields from forge.json; refer to GameProjectSchema in @forgeax/engine-project for the authoritative field list',
        { path: FORGE_JSON, fieldNames },
      );
    }

    // 2c: GuidString refinement failure → forge-guid-malformed (D-2 translation)
    const guidFieldIssues = zodErrors.filter(
      (i) => Array.isArray(i.path) && i.path.includes('defaultScene'),
    );
    if (guidFieldIssues.length > 0) {
      const rawInput =
        typeof (parsed as Record<string, unknown>).defaultScene === 'string'
          ? String((parsed as Record<string, unknown>).defaultScene)
          : '';
      return err(
        'forge-guid-malformed',
        'defaultScene to be a valid 36-char RFC 4122 dash-form UUID',
        'use a valid scene GUID; find it in the scene pack.json assets[].guid where kind=scene',
        {
          field: 'defaultScene',
          rawInput,
        },
      );
    }

    // 2b: missing required fields or wrong types
    return err(
      'forge-schema-invalid',
      'forge.json to satisfy GameProjectSchema',
      'check forge.json against GameProjectSchema (z.infer for types); required fields: id, name, schemaVersion (all strings)',
      { path: FORGE_JSON, zodErrors },
    );
  }

  // ── 3. Success ────────────────────────────────────────────────────────────
  return ok(schemaResult.data);
}

// ── loadGameProject: async (injection-only read) ────────────────────────────────

/**
 * Load and validate a game project manifest from the abstract async reader.
 *
 * Wraps `validateGameProject`: reads `FORGE_JSON` via `read`, then validates.
 * If `read` throws/rejects → `forge-missing`.
 *
 * ## Return paths (5)
 *
 * | # | Condition | ok | code |
 * |:--|:--|:--|:--|
 * | 1 | `read(FORGE_JSON)` throws / rejects | false | `forge-missing` |
 * | 2 | `JSON.parse` fails | false | `forge-parse-failed` |
 * | 3a | zod `.strict()` unknown fields (e.g. `scenes[]`) | false | `forge-unknown-field` |
 * | 3b | zod required field missing / wrong type | false | `forge-schema-invalid` |
 * | 4 | `defaultScene` present, GUID format invalid (AssetGuid.parse fails) | false | `forge-guid-malformed` |
 * | 5 | all valid | true | — |
 *
 * ## Charter mapping
 *
 * - **P3 (explicit failure)**: every failure path returns structured `GameProjectError`
 *   with `.code`/`.expected`/`.hint`/`.detail`; no silent catch-and-ignore or fallback.
 * - **P4 (consistent abstraction)**: return shape is `GuidResult` (same alias as
 *   `AssetGuid.parse` from engine-pack).
 * - **SSOT**: this is the ONE authoritative forge.json loader — all consumers
 *   import it instead of hand-rolling their own fetch+as / JSON.parse+as.
 */
export async function loadGameProject(
  read: (path: string) => Promise<string>,
): Promise<GuidResult<GameProject, GameProjectError>> {
  let raw: string;
  try {
    raw = await read(FORGE_JSON);
  } catch (_e: unknown) {
    return err(
      'forge-missing',
      'forge.json file to exist at the game root',
      'verify the game directory contains forge.json; if this is a new game, scaffold via the Studio UI or create a forge.json with id, name, schemaVersion fields',
      { path: FORGE_JSON },
    );
  }

  return validateGameProject(raw);
}

// ── loadGameProjectSync: sync companion (for sync-only callers like ContextSlot) ──

/**
 * Synchronous version of loadGameProject — for callers that cannot use async
 * (e.g. sync `ContextSlot` content functions).
 *
 * Accepts a sync `read:(path)=>string` injection (same contract shape,
 * sync return). If `read` throws → `forge-missing`.
 *
 * Uses the same `validateGameProject` pure core as `loadGameProject`.
 */
export function loadGameProjectSync(
  read: (path: string) => string,
): GuidResult<GameProject, GameProjectError> {
  let raw: string;
  try {
    raw = read(FORGE_JSON);
  } catch (_e: unknown) {
    return err(
      'forge-missing',
      'forge.json file to exist at the game root',
      'verify the game directory contains forge.json; if this is a new game, scaffold via the Studio UI or create a forge.json with id, name, schemaVersion fields',
      { path: FORGE_JSON },
    );
  }

  return validateGameProject(raw);
}

// ── resolveDefaultScene: {read, resolveGuid} dual injection (AC-07) ─────────

/** Resolved scene asset with GUID and kind='scene' confirmation. */
export interface ResolvedScene {
  readonly guid: string;
  readonly kind: 'scene';
}

/**
 * Resolve the defaultScene GUID to a scene asset using the injected resolveGuid.
 *
 * ## Dual injection (AC-07)
 *
 * - `read`: same `(path)=>Promise<string>` as loadGameProject — reads forge.json.
 * - `resolveGuid`: resolves a GUID string to an asset with `kind` field.
 *   Signature: `(guid: string) => Promise<{ok:true, value:{kind:string, guid:string}} | {ok:false, error:unknown}>`
 *
 * `loadGameProject` does NOT call resolveGuid; resolveDefaultScene calls both
 * independently (charter SSOT: two-layer separation, format vs resolve).
 *
 * ## Return paths
 *
 * | Condition | ok | code |
 * |:--|:--|:--|
 * | loadGameProject returns !ok | false | propagated from loader |
 * | no defaultScene | false | `forge-scene-unresolved` |
 * | resolveGuid returns !ok | false | `forge-scene-unresolved` |
 * | resolveGuid returns asset.kind !== 'scene' | false | `forge-scene-unresolved` |
 * | resolveGuid returns asset.kind === 'scene' | true | — |
 */
export async function resolveDefaultScene(opts: {
  read: (path: string) => Promise<string>;
  resolveGuid: (
    guid: string,
  ) => Promise<{ ok: true; value: { kind: string; guid: string } } | { ok: false; error: unknown }>;
}): Promise<GuidResult<ResolvedScene, GameProjectError>> {
  const { read, resolveGuid } = opts;

  // 1. Load the game project
  const gpResult = await loadGameProject(read);
  if (!gpResult.ok) {
    return gpResult; // propagate loader error
  }

  // 2. Check if defaultScene exists
  const gp = gpResult.value;
  const defaultSceneGuid = gp.defaultScene;
  if (defaultSceneGuid === undefined || defaultSceneGuid === null) {
    return err(
      'forge-scene-unresolved',
      'a defaultScene field in forge.json to resolve',
      'add a defaultScene with a valid scene asset GUID to forge.json, or select a scene at runtime',
      { guid: '' },
    );
  }

  // 3. Resolve the GUID
  const guidStr = defaultSceneGuid as string;
  const resolveResult = await resolveGuid(guidStr);

  if (!resolveResult.ok) {
    return err(
      'forge-scene-unresolved',
      'the defaultScene GUID to resolve to an existing scene asset',
      "verify the defaultScene GUID matches a scene asset's pack.json assets[].guid (where kind=scene)",
      { guid: guidStr },
    );
  }

  // 4. Verify kind === 'scene'
  const asset = resolveResult.value;
  if (asset.kind !== 'scene') {
    return err(
      'forge-scene-unresolved',
      'the defaultScene GUID to point to a scene asset (kind=scene)',
      `resolved asset kind is "${asset.kind}", not "scene"; verify the GUID points to a scene pack entry`,
      { guid: guidStr },
    );
  }

  return ok({ guid: guidStr, kind: 'scene' });
}
