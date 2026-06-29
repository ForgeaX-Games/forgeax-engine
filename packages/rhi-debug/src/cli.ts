#!/usr/bin/env node
// @forgeax/engine-rhi-debug/src/cli -- capture-frame / inspect-at CLI subcommands.
//
// Provides two CLI subcommands for frame recording and offline inspection.
// Follows forgeax-console CLI style with --help output containing flag tables
// and example invocations (charter F1 + P1: AI subagent self-learns via --help).
//
// Subcommands:
//   capture-frame --frames=N --label=X --target=ws://host:port   -> output JSON
//   inspect-at <tapePath> <drawIdx> --fields=bindings,rt --target=...  -> output JSON
//
// The JSON-RPC inspector uses InspectorClient.execute(script) where `script`
// is a JavaScript expression string sent to the `execute` method.
// We compose script strings that invoke the debug.* RPC methods registered
// on the Registry.
//
// Offline inspect (m4 / w23 + w24): `inspect-offline <tapePath> <drawIdx>`
// reads an on-disk L1 tape (frame-0.tape.bin + frame-0.report.json), boots a
// fresh dawn-node device, replays to drawIdx, and emits a structured
// InspectReport JSON + an RT PNG -- no live engine / WS connection. It composes
// the existing deserializeTape + createReplay + inspector.inspectAt primitives;
// the inspector / replayer cores are untouched (OOS-5). No new DebugErrorCode
// is introduced (OOS-6 / C2): the entry returns the existing DebugError union.
//
// Related: requirements AC-22 / IS-7; m7-2.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { defaultConnect } from '@forgeax/engine-types/inspector-client';
import { DebugError } from './errors';
import { findEventIdxForDraw } from './inspect-core';
import { inspectAt as inspectAtCore } from './inspector';
import type { CreateShaderModuleFn } from './recorder';
import { createReplay } from './replayer';
import { deserializeTape } from './tape-format';
import type { InspectFields, InspectReport } from './types';

type OfflineResult =
  | { readonly ok: true; readonly value: { readonly report: InspectReport } }
  | { readonly ok: false; readonly error: DebugError };

// ============================================================================
// Help text generation
// ============================================================================

/**
 * Capture frame help text with flag table and example invocation.
 */
export function getCaptureFrameHelp(): string {
  return [
    'Usage: capture-frame [--frames=N] [--label=STR] [--target=WS]',
    '',
    'Capture N frames from a running forgeax engine via WebSocket JSON-RPC.',
    '',
    'Flags:',
    '  --frames=N     Number of frames to capture (default: 1).',
    '  --label=STR    Optional label for the capture run.',
    '  --target=WS    WebSocket target URL (default: ws://localhost:5732).',
    '',
    'Example:',
    '  forgeax-engine-console capture-frame --frames=1 --label=test',
    '',
    'Output:',
    '  JSON object with tapePaths array containing runId, tapePath, and reportPath.',
  ].join('\n');
}

/**
 * Inspect at help text with flag table and example invocation.
 */
export function getInspectAtHelp(): string {
  return [
    'Usage: inspect-at <tapePath> <drawIdx> [--fields=LIST] [--target=WS]',
    '',
    'Inspect a specific draw index within a captured tape.',
    '',
    'Arguments:',
    '  tapePath     Path to the .tape.bin file to inspect.',
    '  drawIdx      Global draw event index to inspect (integer >= 0).',
    '',
    'Flags:',
    '  --fields=LIST   Comma-separated fields to include: bindings,drawCall,rt (default: all).',
    '  --target=WS     WebSocket target URL (default: ws://localhost:5732).',
    '',
    'Example:',
    '  forgeax-engine-console inspect-at .forgeax-debug/2026-06-12T120000Z-abcd/frame-0.tape.bin 42 --fields=bindings,rt',
    '',
    'Output:',
    '  JSON InspectReport with frameIdx, drawIdx, passIdx, and requested fields.',
  ].join('\n');
}

/**
 * Inspect-offline help text with flag table and example invocation.
 */
export function getInspectOfflineHelp(): string {
  return [
    'Usage: inspect-offline <tapePath> <drawIdx> [--fields=LIST]',
    '',
    'Inspect a draw index in an on-disk tape WITHOUT a running engine. Reads',
    'frame-0.tape.bin + frame-0.report.json, boots a fresh dawn-node device,',
    'replays the frame, and emits a structured InspectReport JSON + RT PNG.',
    '',
    'Arguments:',
    '  tapePath     Path to the .tape.bin file (its .report.json sits alongside).',
    '  drawIdx      Global draw event index to inspect (integer >= 0).',
    '',
    'Flags:',
    '  --fields=LIST   Comma-separated fields to include: bindings,drawCall,rt (default: all).',
    '',
    'Example:',
    '  forgeax-rhi-debug inspect-offline .forgeax-debug/<runId>/frame-0.tape.bin 0',
    '',
    'Output:',
    '  JSON InspectReport with frameIdx, drawIdx, passIdx, bindings, drawCall, and rt (PNG path).',
    '  Requires an importable dawn-node backend (@forgeax/engine-rhi-webgpu or -rhi-wgpu).',
  ].join('\n');
}

/**
 * Trigger-browser help text with flag table and example invocation.
 */
export function getTriggerBrowserHelp(): string {
  return [
    'Usage: trigger-browser [--frames=N] [--label=STR] [--dev-url=URL]',
    '',
    'Trigger a browser tab to capture frames via the dev-server HMR channel.',
    '',
    'Flags:',
    '  --frames=N     Number of frames to capture (default: 1).',
    '  --label=STR    Optional label for the capture run.',
    '  --dev-url=URL  Dev-server URL (default: http://localhost:5173).',
    '',
    'Example:',
    '  forgeax-rhi-debug trigger-browser --frames=1 --label=sponza-black',
    '',
    'Output:',
    '  tapePath: path to the .tape.bin file.',
    '  reportPath: path to the .report.json file.',
    '  runId: unique run identifier.',
  ].join('\n');
}

// ============================================================================
// Trigger-browser argument parsing (pure, no side effects -- testable SSOT)
// ============================================================================

/** Parsed trigger-browser arguments from the CLI flag set. */
export interface TriggerBrowserArgs {
  readonly frames: number;
  readonly label: string | undefined;
  readonly devUrl: string;
}

/** Result of parseTriggerBrowserArgs: success with parsed args or error with message + exit code. */
export type TriggerBrowserParseResult =
  | { readonly ok: true; readonly value: TriggerBrowserArgs }
  | {
      readonly ok: false;
      readonly error: string;
      readonly helpText: string;
      readonly exitCode: number;
    };

/**
 * Parse trigger-browser CLI flags into a TriggerBrowserArgs struct.
 *
 * Pure function: no process.exit / process.stdout.write / fetch side effects.
 * Callers (triggerBrowserDispatch, tests) handle printing and exit themselves.
 *
 * Flags: --frames=N (default 1), --label=STR (optional), --dev-url=URL (default http://localhost:5173).
 * --help/-h returns a parse result with the help text and exitCode 0.
 * Unknown flags return an error result with exitCode 1.
 */
export function parseTriggerBrowserArgs(args: readonly string[]): TriggerBrowserParseResult {
  let frames = 1;
  let label: string | undefined;
  let devUrl = 'http://localhost:5173';

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      return { ok: false, error: '', helpText: getTriggerBrowserHelp(), exitCode: 0 };
    }

    const frameMatch = arg.match(/^--frames=(\d+)$/);
    if (frameMatch) {
      const v = frameMatch[1];
      if (v !== undefined) frames = parseInt(v, 10);
      continue;
    }

    const labelMatch = arg.match(/^--label=(.+)$/);
    if (labelMatch) {
      const v = labelMatch[1];
      if (v !== undefined) label = v;
      continue;
    }

    const devUrlMatch = arg.match(/^--dev-url=(.+)$/);
    if (devUrlMatch) {
      const v = devUrlMatch[1];
      if (v !== undefined) devUrl = v;
      continue;
    }

    return {
      ok: false,
      error: `Unknown argument: ${arg}`,
      helpText: getTriggerBrowserHelp(),
      exitCode: 1,
    };
  }

  return { ok: true, value: { frames, label, devUrl } };
}

// ============================================================================
// CLI command implementations
// ============================================================================

/**
 * Execute capture-frame command.
 *
 * Connects to the target WebSocket, sends an execute script that calls
 * debug.captureFrame via the RPC Registry, and outputs the result as JSON.
 */
export async function runCaptureFrame(options: {
  frames: number;
  label: string | undefined;
  target: string | undefined;
}): Promise<void> {
  const target = options.target ?? 'ws://localhost:5732';
  const connectResult = await defaultConnect(target);
  if (!connectResult.ok) {
    process.stderr.write(`Error: [${connectResult.error.code}] ${connectResult.error.hint}\n`);
    process.exit(1);
  }
  const client = connectResult.value;

  try {
    // Build the script: call debug.captureFrame with frames + optional label
    const framesJson = JSON.stringify(options.frames);
    const labelExpr = options.label !== undefined ? JSON.stringify(options.label) : 'undefined';
    const script = `debug.captureFrame({ frames: ${framesJson}, label: ${labelExpr} })`;

    const rawResult = await client.execute(script);
    const result = rawResult as Record<string, unknown> | undefined;

    if (result !== undefined && typeof result === 'object' && result.error !== undefined) {
      const err = result.error as { code?: string; hint?: string };
      process.stderr.write(
        `Error: [${err.code ?? 'unknown'}] ${err.hint ?? JSON.stringify(result.error)}\n`,
      );
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(result ?? {}, null, 2));
    process.stdout.write('\n');
    await client.dispose();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

/**
 * Execute inspect-at command.
 *
 * Connects to the target WebSocket, sends an execute script that calls
 * debug.inspectAt via the RPC Registry, and outputs the result as JSON.
 */
export async function runInspectAt(options: {
  tapePath: string;
  drawIdx: number;
  fields: string | undefined;
  target: string | undefined;
}): Promise<void> {
  const target = options.target ?? 'ws://localhost:5732';
  const connectResult = await defaultConnect(target);
  if (!connectResult.ok) {
    process.stderr.write(`Error: [${connectResult.error.code}] ${connectResult.error.hint}\n`);
    process.exit(1);
  }
  const client = connectResult.value;

  try {
    // Build the script: call debug.inspectAt with tapePath, drawIdx, optional fields
    const tapePathJson = JSON.stringify(options.tapePath);
    const drawIdxJson = JSON.stringify(options.drawIdx);
    const fieldsExpr =
      options.fields !== undefined
        ? JSON.stringify(options.fields.split(',').map((f) => f.trim()))
        : 'undefined';
    const script = `debug.inspectAt({ tapePath: ${tapePathJson}, drawIdx: ${drawIdxJson}, fields: ${fieldsExpr} })`;

    const rawResult = await client.execute(script);
    const result = rawResult as Record<string, unknown> | undefined;

    if (result !== undefined && typeof result === 'object' && result.error !== undefined) {
      const err = result.error as { code?: string; hint?: string };
      process.stderr.write(
        `Error: [${err.code ?? 'unknown'}] ${err.hint ?? JSON.stringify(result.error)}\n`,
      );
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(result ?? {}, null, 2));
    process.stdout.write('\n');
    await client.dispose();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

// ============================================================================
// Offline inspect-at entry (w23 + w24)
// ============================================================================

// findEventIdxForDraw is the shared draw->event SSOT, imported from inspect-core
// (drops the former local copy; the adapter.ts copy stays per OOS-5).

interface DawnDevicePack {
  readonly device: RhiDevice;
  readonly createShaderModule: CreateShaderModuleFn;
}

/**
 * Boot a fresh dawn-node RhiDevice for offline replay (w24).
 *
 * Mirrors e2e.dawn.test.ts:loadDawnRhi -- prefers the dawn-node webgpu binding,
 * falls back to the wgpu wasm backend (which needs ensureReady()). Returns
 * undefined when no dawn-capable backend is importable so the caller can emit
 * an actionable error rather than crash.
 */
/**
 * Inject globalThis.navigator.gpu via the `webgpu` npm package so the dawn-node
 * @forgeax/engine-rhi-webgpu backend can requestAdapter from a bare `node`
 * process. No-op when navigator.gpu already exists (e.g. vitest already mounted
 * it via vitest.setup-webgpu.ts, or a browser). Mirrors the smoke-dawn.mjs +
 * vitest.setup-webgpu.ts bootstrap (research §F-1 / D-P2). Best-effort: a
 * missing/failed binding leaves navigator.gpu unset so the rhi-webgpu
 * requestAdapter returns not-ok and loadDawnDevice falls through to rhi-wgpu.
 */
async function ensureWebgpuGlobal(): Promise<void> {
  const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  if (nav !== undefined && nav.gpu !== undefined) return;
  try {
    const { create, globals } = (await import(/* @vite-ignore */ 'webgpu')) as unknown as {
      create: (flags: readonly string[]) => unknown;
      globals: Record<string, unknown>;
    };
    Object.assign(globalThis as Record<string, unknown>, globals);
    if (
      !('navigator' in globalThis) ||
      (globalThis as { navigator?: unknown }).navigator === undefined
    ) {
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        configurable: true,
        writable: true,
      });
    }
    Object.defineProperty((globalThis as { navigator: { gpu?: unknown } }).navigator, 'gpu', {
      value: create([]),
      configurable: true,
      writable: true,
    });
  } catch {
    // webgpu binding unavailable -- fall through; the rhi-wgpu wasm backend or
    // an actionable recorder-not-attached error covers this path.
  }
}

async function loadDawnDevice(): Promise<DawnDevicePack | undefined> {
  await ensureWebgpuGlobal();
  const tryBackend = async (pkg: string): Promise<DawnDevicePack | undefined> => {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(/* @vite-ignore */ pkg)) as unknown as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if ('ensureReady' in mod && typeof mod.ensureReady === 'function') {
      await (mod.ensureReady as () => Promise<unknown>)();
    }
    const rhi = mod.rhi as
      | { requestAdapter(): Promise<{ ok: boolean; value: unknown; error?: unknown }> }
      | undefined;
    if (rhi === undefined) return undefined;
    const adapterRes = await rhi.requestAdapter();
    if (!adapterRes.ok) return undefined;
    const adapter = adapterRes.value as {
      requestDevice(): Promise<{ ok: boolean; value: RhiDevice }>;
    };
    const devRes = await adapter.requestDevice();
    if (!devRes.ok) return undefined;
    return {
      device: devRes.value,
      createShaderModule: mod.createShaderModule as CreateShaderModuleFn,
    };
  };
  return (
    (await tryBackend('@forgeax/engine-rhi-webgpu')) ??
    (await tryBackend('@forgeax/engine-rhi-wgpu'))
  );
}

/**
 * Offline inspect-at: read an on-disk L1 tape, replay it on a dawn-node device,
 * and produce an InspectReport (JSON + RT PNG path).
 *
 * `device` / `createShaderModule` are injectable for tests; when omitted the
 * entry boots a fresh dawn-node device via loadDawnDevice(). The PNG is written
 * to the tape's own directory (path.dirname(tapePath)); the returned report's
 * `rt` field is its path.
 *
 * Returns the existing DebugError union on failure (OOS-6: no new error code).
 */
export async function runOfflineInspectAt(opts: {
  readonly tapePath: string;
  readonly drawIdx: number;
  readonly fields: readonly InspectFields[] | undefined;
  readonly device?: RhiDevice | undefined;
  readonly createShaderModule?: CreateShaderModuleFn | undefined;
}): Promise<OfflineResult> {
  // Resolve the replay device: injected (tests) or freshly booted (CLI).
  let device = opts.device;
  let createShaderModule = opts.createShaderModule;
  if (device === undefined) {
    const pack = await loadDawnDevice();
    if (pack === undefined) {
      return {
        ok: false,
        error: new DebugError({
          code: 'recorder-not-attached',
          expected: 'an importable dawn-node RHI backend for offline replay',
          hint: 'install @forgeax/engine-rhi-webgpu (dawn-node) or @forgeax/engine-rhi-wgpu (wasm); offline inspect needs a live device to replay + read back the RT',
        }),
      };
    }
    device = pack.device;
    createShaderModule ??= pack.createShaderModule;
  }

  // Reassemble the deserializeTape JSON form from the two L1 files (mirror of
  // adapter.ts:inspectAt on-disk schema, derive-don't-duplicate read side).
  let blobBuf: Buffer;
  let reportRaw: string;
  try {
    blobBuf = fs.readFileSync(opts.tapePath);
    const reportPath = opts.tapePath.replace(/\.tape\.bin$/, '.report.json');
    reportRaw = fs.readFileSync(reportPath, 'utf-8');
  } catch (e) {
    return {
      ok: false,
      error: new DebugError({
        code: 'tape-format-version-mismatch',
        expected: 'frame-0.tape.bin + frame-0.report.json present at the tape path',
        hint: `failed to read tape files for '${opts.tapePath}': ${e instanceof Error ? e.message : String(e)}`,
      }),
    };
  }

  let reportObj: { header: unknown; events: unknown };
  try {
    reportObj = JSON.parse(reportRaw) as { header: unknown; events: unknown };
  } catch {
    return {
      ok: false,
      error: new DebugError({
        code: 'tape-format-version-mismatch',
        expected: 'a parseable JSON report file alongside the tape binary',
        hint: `failed to parse the .report.json for '${opts.tapePath}'`,
      }),
    };
  }

  const json = JSON.stringify({ header: reportObj.header, events: reportObj.events });
  const blob = new Uint8Array(blobBuf.buffer, blobBuf.byteOffset, blobBuf.byteLength).slice();
  const tapeResult = deserializeTape(json, blob);
  if (!tapeResult.ok) {
    return { ok: false, error: tapeResult.error };
  }
  const tape = tapeResult.value;

  const replayResult = createReplay(tape, device, createShaderModule);
  if (!replayResult.ok) {
    return { ok: false, error: replayResult.error };
  }
  const replay = replayResult.value;

  const targetEventIdx = findEventIdxForDraw(tape.events, opts.drawIdx);
  if (targetEventIdx === -1) {
    return {
      ok: false,
      error: new DebugError({
        code: 'replay-step-out-of-range',
        expected: `drawIdx ${opts.drawIdx} present in tape`,
        hint: 'tape contains fewer draw calls than the requested drawIdx',
        detail: {
          requestedStep: opts.drawIdx,
          currentStep: 0,
          totalEvents: tape.events.length,
        },
      }),
    };
  }

  // Commit through the target draw: replay up to & including it, then end +
  // finish + submit the enclosing pass so its color attachment holds the
  // draws-0..N CUMULATIVE pixels (not the whole composited frame). This is what
  // makes inspecting draw #N show the frame as it stood right after draw N, and
  // is the empty-frame guard too (a mid-pass attachment is uncommitted/black, so
  // we synthesize the commit). committed:false (depth-only / compute pass) is
  // not an error here; the inspect report's rt field surfaces the no-color case
  // via readbackDrawRt when 'rt' is requested.
  const commitResult = await replay.commitThroughDraw(opts.drawIdx);
  if (!commitResult.ok) {
    return { ok: false, error: commitResult.error };
  }

  const outputDir = path.dirname(opts.tapePath);
  const reportResult = await inspectAtCore(
    replay,
    opts.drawIdx,
    tape.events,
    opts.fields,
    device,
    outputDir,
  );
  if (!reportResult.ok) {
    return { ok: false, error: reportResult.error };
  }

  return { ok: true, value: { report: reportResult.value } };
}

// ============================================================================
// Main CLI entry (parseArgs-style dispatch)
// ============================================================================

/**
 * Parse and dispatch CLI arguments.
 *
 * Expects argv in the form:
 *   node cli.mjs capture-frame --frames=1 --label=test
 *   node cli.mjs inspect-at <tapePath> 42 --fields=bindings,rt
 *   node cli.mjs inspect-offline <tapePath> 42 --fields=bindings,rt
 */
const USAGE =
  'Usage: rhi-debug-cli <capture-frame|inspect-at|inspect-offline|trigger-browser> [args...]\n';

export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2); // skip node and script path

  if (args.length === 0) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const subcommand = args[0];

  if (subcommand === 'capture-frame') {
    await captureFrameDispatch(args.slice(1));
  } else if (subcommand === 'inspect-at') {
    await inspectAtDispatch(args.slice(1));
  } else if (subcommand === 'inspect-offline') {
    await inspectOfflineDispatch(args.slice(1));
  } else if (subcommand === 'trigger-browser') {
    await triggerBrowserDispatch(args.slice(1));
  } else {
    process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
    process.stderr.write(USAGE);
    process.exit(1);
  }
}

/**
 * Parse capture-frame arguments and dispatch.
 */
async function captureFrameDispatch(args: string[]): Promise<void> {
  let frames = 1;
  let label: string | undefined;
  let target: string | undefined;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(getCaptureFrameHelp());
      process.stdout.write('\n');
      process.exit(0);
    }

    const frameMatch = arg.match(/^--frames=(\d+)$/);
    if (frameMatch) {
      const v = frameMatch[1];
      if (v !== undefined) frames = parseInt(v, 10);
      continue;
    }

    const labelMatch = arg.match(/^--label=(.+)$/);
    if (labelMatch) {
      const v = labelMatch[1];
      if (v !== undefined) label = v;
      continue;
    }

    const targetMatch = arg.match(/^--target=(.+)$/);
    if (targetMatch) {
      const v = targetMatch[1];
      if (v !== undefined) target = v;
      continue;
    }

    process.stderr.write(`Unknown argument: ${arg}\n`);
    process.exit(1);
  }

  await runCaptureFrame({ frames, label, target });
}

/**
 * Parse inspect-at arguments and dispatch.
 */
async function inspectAtDispatch(args: string[]): Promise<void> {
  let tapePath: string | undefined;
  let drawIdx: number | undefined;
  let fields: string | undefined;
  let target: string | undefined;
  let position = 0;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(getInspectAtHelp());
      process.stdout.write('\n');
      process.exit(0);
    }

    const fieldsMatch = arg.match(/^--fields=(.+)$/);
    if (fieldsMatch) {
      const v = fieldsMatch[1];
      if (v !== undefined) fields = v;
      continue;
    }

    const targetMatch = arg.match(/^--target=(.+)$/);
    if (targetMatch) {
      const v = targetMatch[1];
      if (v !== undefined) target = v;
      continue;
    }

    // Positional arguments
    if (!arg.startsWith('--')) {
      if (position === 0) {
        tapePath = arg;
        position++;
      } else if (position === 1) {
        const idx = parseInt(arg, 10);
        if (Number.isNaN(idx)) {
          process.stderr.write(`Invalid drawIdx: ${arg} (must be an integer)\n`);
          process.exit(1);
        }
        drawIdx = idx;
        position++;
      } else {
        process.stderr.write(`Unknown extra argument: ${arg}\n`);
        process.exit(1);
      }
    }
  }

  if (tapePath === undefined) {
    process.stderr.write('Missing required argument: <tapePath>\n');
    process.exit(1);
  }
  if (drawIdx === undefined) {
    process.stderr.write('Missing required argument: <drawIdx>\n');
    process.exit(1);
  }

  await runInspectAt({ tapePath, drawIdx, fields, target });
}

/**
 * Parse inspect-offline arguments and dispatch (w24).
 *
 * No WS target: this path reads the tape from disk and boots a dawn-node device
 * itself. On success, prints the InspectReport JSON to stdout; on failure,
 * prints the DebugError code + hint to stderr and exits 1 (no new error code;
 * the dawn-backend-unavailable case maps to the existing recorder-not-attached
 * code, OOS-6).
 */
async function inspectOfflineDispatch(args: string[]): Promise<void> {
  let tapePath: string | undefined;
  let drawIdx: number | undefined;
  let fields: string | undefined;
  let position = 0;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(getInspectOfflineHelp());
      process.stdout.write('\n');
      process.exit(0);
    }

    const fieldsMatch = arg.match(/^--fields=(.+)$/);
    if (fieldsMatch) {
      const v = fieldsMatch[1];
      if (v !== undefined) fields = v;
      continue;
    }

    if (!arg.startsWith('--')) {
      if (position === 0) {
        tapePath = arg;
        position++;
      } else if (position === 1) {
        const idx = parseInt(arg, 10);
        if (Number.isNaN(idx) || idx < 0) {
          process.stderr.write(`Invalid drawIdx: ${arg} (must be an integer >= 0)\n`);
          process.exit(1);
        }
        drawIdx = idx;
        position++;
      } else {
        process.stderr.write(`Unknown extra argument: ${arg}\n`);
        process.exit(1);
      }
      continue;
    }

    process.stderr.write(`Unknown argument: ${arg}\n`);
    process.exit(1);
  }

  if (tapePath === undefined) {
    process.stderr.write('Missing required argument: <tapePath>\n');
    process.exit(1);
  }
  if (drawIdx === undefined) {
    process.stderr.write('Missing required argument: <drawIdx>\n');
    process.exit(1);
  }

  const parsedFields =
    fields !== undefined
      ? (fields.split(',').map((f) => f.trim()) as readonly InspectFields[])
      : undefined;

  const result = await runOfflineInspectAt({
    tapePath,
    drawIdx,
    fields: parsedFields,
  });
  if (!result.ok) {
    process.stderr.write(`Error: [${result.error.code}] ${result.error.hint}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result.value.report, null, 2));
  process.stdout.write('\n');
}

/**
 * Parse trigger-browser arguments and dispatch.
 *
 * Mirror of captureFrameDispatch: flag-only parser (no positional args),
 * same --frames / --label regex form, but uses --dev-url instead of --target.
 * After parsing, fetch POST <devUrl>/__forgeax-debug/trigger and print
 * the three result paths or an {error,hint} envelope to stderr.
 *
 * plan-strategy D-6: error printing mirrors uploadTape envelope +
 * cli.ts existing Error: [${code}] ${hint} style (cli.ts:145).
 * plan-strategy D-7: --dev-url default http://localhost:5173.
 *
 * Flag parsing is delegated to parseTriggerBrowserArgs (pure, exported SSOT
 * so tests can assert parsing logic directly without needing fetch side effects).
 */
async function triggerBrowserDispatch(args: string[]): Promise<void> {
  const parseResult = parseTriggerBrowserArgs(args);
  if (!parseResult.ok) {
    if (parseResult.exitCode === 0) {
      process.stdout.write(parseResult.helpText);
      process.stdout.write('\n');
      process.exit(0);
    }
    process.stderr.write(`${parseResult.error}\n`);
    if (parseResult.helpText.length > 0) {
      process.stderr.write(parseResult.helpText);
      process.stderr.write('\n');
    }
    process.exit(1);
  }

  const { frames, label, devUrl } = parseResult.value;

  const body: { frames: number; label?: string } = { frames };
  if (label !== undefined) {
    body.label = label;
  }

  try {
    const response = await fetch(`${devUrl}/__forgeax-debug/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const result = (await response.json()) as {
        tapePath: string;
        reportPath: string;
        runId: string;
      };
      process.stdout.write(`tapePath: ${result.tapePath}\n`);
      process.stdout.write(`reportPath: ${result.reportPath}\n`);
      process.stdout.write(`runId: ${result.runId}\n`);
    } else {
      let envelope: { error?: string; hint?: string } = {};
      try {
        envelope = (await response.json()) as { error?: string; hint?: string };
      } catch {
        // Non-JSON error body; use status text.
      }
      process.stderr.write(
        `Error: [${envelope.error ?? response.statusText}] ${envelope.hint ?? ''}\n`,
      );
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

// ============================================================================
// Module entry -- run main() when invoked as a script (node dist/cli.mjs ...)
// ============================================================================

// Guard so importing this module (tests, the ./cli subpath) does not auto-run
// the CLI. When tsup bundles to dist/cli.mjs with the package.json#bin entry,
// `node dist/cli.mjs <subcommand>` matches import.meta.url against argv[1].
const invokedPath =
  typeof process !== 'undefined' && Array.isArray(process.argv) ? process.argv[1] : undefined;
if (invokedPath !== undefined && import.meta.url === new URL(`file://${invokedPath}`).href) {
  main(process.argv).catch((e: unknown) => {
    process.stderr.write(`Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
