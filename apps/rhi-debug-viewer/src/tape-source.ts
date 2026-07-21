// tape-source -- pair match + reconstruct {header,events} from .tape.bin + report.json
//
// Pure TS module (zero React, zero GPU). Accepts two File objects, matches them
// by frame-N prefix, extracts {header, events} from the report JSON, and calls
// deserializeTape to produce a Result<Tape, TapeSourceError>.
//
// D-3 (plan-strategy): NEVER trust report.json.passOffsets (render-only, may
// lack compute passes). Strip passOffsets and valid — tree truth comes from
// events recalculation via extended computePassOffsets (M1).
//
// Edge cases handled:
//   - Missing pair file -> explicit error
//   - JSON parse failure -> tape-format-version-mismatch
//   - File read failure -> structured error

import type { Tape } from '@forgeax/engine-rhi-debug';
import { DebugError, deserializeTape } from '@forgeax/engine-rhi-debug';
import type { Result } from '@forgeax/engine-types';
import { err } from '@forgeax/engine-types';

const PAIR_PATTERN = /^frame-(\d+)\.(tape\.bin|report\.json|json)$/;

/** Pre-deserialization error: pair mismatch or file I/O failure. */
export interface TapeSourceError {
  readonly kind: 'missing-pair' | 'read-failure';
  readonly message: string;
}

/** Union of pre-deserialization errors and deserializeTape's structured DebugError. */
export type TapeLoadError = TapeSourceError | DebugError;

/**
 * Match two File objects by their frame-N prefix.
 *
 * Returns a { bin, json } pair if one file matches *.tape.bin and the other
 * matches *.report.json (or *.json) with the same frame index.
 */
function matchPair(files: readonly File[]): { bin: File; json: File } | null {
  const byFrame = new Map<number, { bin?: File; json?: File }>();

  for (const file of files) {
    const m = file.name.match(PAIR_PATTERN);
    if (!m) continue;
    const idx = Number(m[1]);
    const ext = m[2];
    let entry = byFrame.get(idx);
    if (!entry) {
      entry = {};
      byFrame.set(idx, entry);
    }
    if (ext === 'tape.bin') {
      entry.bin = file;
    } else {
      entry.json = file;
    }
  }

  for (const [, entry] of byFrame) {
    if (entry.bin && entry.json) {
      return { bin: entry.bin, json: entry.json };
    }
  }

  return null;
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsText(file);
  });
}

async function readFileAsBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Load a Tape from a pair of File objects (.tape.bin + report.json).
 *
 * Steps:
 * 1. Match files by frame-N prefix.
 * 2. Read the JSON file, parse it, extract {header, events}.
 * 3. Re-JSON.stringify {header, events} to produce the first argument for deserializeTape.
 * 4. Read the binary blob.
 * 5. Call deserializeTape(reconstructedJson, blob).
 *
 * D-3: passOffsets and valid fields from report.json are DISCARDED.
 */
export async function loadTapeFromFiles(
  files: readonly File[],
): Promise<Result<Tape, TapeLoadError>> {
  const pair = matchPair(files);
  if (!pair) {
    return err({
      kind: 'missing-pair' as const,
      message:
        'No matching .tape.bin + report.json pair found. Drop both frame-N.tape.bin and frame-N.report.json files.',
    });
  }

  let jsonText: string;
  try {
    jsonText = await readFileAsText(pair.json);
  } catch {
    return err({
      kind: 'read-failure' as const,
      message: `Failed to read ${pair.json.name}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return err(
      new DebugError({
        code: 'tape-format-version-mismatch',
        expected: `valid JSON tape data with header and events`,
        hint: `${pair.json.name} is not valid JSON; the file may be corrupted`,
        detail: { tapeVersion: -1, expectedVersion: -1 },
      }),
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('header' in parsed) ||
    !('events' in parsed)
  ) {
    return err(
      new DebugError({
        code: 'tape-format-version-mismatch',
        expected: `JSON object with 'header' and 'events' fields`,
        hint: `${pair.json.name} has unexpected shape; expected report.json with header and events`,
        detail: { tapeVersion: -1, expectedVersion: -1 },
      }),
    );
  }

  const report = parsed as Record<string, unknown>;

  // D-3: extract only {header, events}, discard passOffsets and valid
  const reconstructed = JSON.stringify({
    header: report.header,
    events: report.events,
  });

  let blob: Uint8Array;
  try {
    blob = await readFileAsBytes(pair.bin);
  } catch {
    return err({
      kind: 'read-failure' as const,
      message: `Failed to read ${pair.bin.name}`,
    });
  }

  const result = deserializeTape(reconstructed, blob);
  // deserializeTape returns Result<Tape, DebugError>. DebugError is a
  // member of TapeLoadError (= TapeSourceError | DebugError), so the
  // structural discriminated union widens correctly at the call site
  // when consumers check `error.code` (DebugError) or `error.kind` (TapeSourceError).
  return result as unknown as Result<Tape, TapeLoadError>;
}

/** Load the paired capture artifacts that the editor opens in the reviewer. */
export async function loadTapeFromUrls(
  tapeUrl: string,
  reportUrl: string,
): Promise<Result<Tape, TapeLoadError>> {
  try {
    const [tapeResponse, reportResponse] = await Promise.all([fetch(tapeUrl), fetch(reportUrl)]);
    if (!tapeResponse.ok || !reportResponse.ok) {
      return err({
        kind: 'read-failure' as const,
        message: `Failed to fetch capture artifacts (${tapeResponse.status}/${reportResponse.status})`,
      });
    }

    const [tape, report] = await Promise.all([tapeResponse.blob(), reportResponse.blob()]);
    return loadTapeFromFiles([
      new File([tape], 'frame-0.tape.bin'),
      new File([report], 'frame-0.report.json', { type: 'application/json' }),
    ]);
  } catch {
    return err({
      kind: 'read-failure' as const,
      message: 'Failed to fetch capture artifacts. Confirm the editor dev server is still running.',
    });
  }
}
