// @forgeax/engine-vite-plugin-rhi-debug -- dev-server RHI capture endpoint.
//
// Three dev-only hooks:
//   - configureServer (w13): mounts POST /__forgeax-debug/tape, which decodes a
//     browser-captured tape and writes it to disk byte-identical to the Node
//     finalize() tail (assembleReport single-writer, D-3 / AC-05); and
//     POST /__forgeax-debug/trigger, which broadcasts a capture request via
//     HMR custom event then synchronously waits for a /tape upload to resolve
//     a closure-level pending slot (D-1 / D-2 / AC-02--AC-06).
//   - config (w14): injects import.meta.env.FORGEAX_ENGINE_RHI_DEBUG = "1" so a
//     demo build that registers the plugin folds the guard flag to a literal
//     (AC-07 / C6); without the plugin the flag leaves no residue (prod-clean).
//
// HTTP errors never enter DebugError (OOS-6 / D-9); illegal bodies and trigger
// failures return a {error, hint} JSON envelope and write nothing (Fail Fast).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assembleReport, type PassOffset } from '@forgeax/engine-rhi-debug';
import type { Plugin, ViteDevServer } from 'vite';

const TAPE_ROUTE = '/__forgeax-debug/tape';
const TRIGGER_ROUTE = '/__forgeax-debug/trigger';
const DEFINE_KEY = 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG';

/** Validated shape of a POST /__forgeax-debug/tape body. */
interface TapeBody {
  readonly runId: string;
  readonly label?: string;
  readonly json: string;
  readonly blobBase64: string;
  readonly passOffsets: readonly PassOffset[];
  readonly valid: boolean;
}

/** Shape of a POST /__forgeax-debug/trigger body. */
interface TriggerBody {
  readonly frames?: number;
  readonly label?: string;
}

/** Sentinel value for Promise.race timeout to distinguish from a real result. */
const TIMEOUT_SENTINEL = Symbol('trigger-timeout');

type TriggerResult = { tapePath: string; reportPath: string; runId: string };

interface PendingTrigger {
  resolve: (result: TriggerResult) => void;
}

// Standard base64 (RFC 4648) -- canonical padding, no whitespace. Validated with
// two flat (no nested-quantifier) regexes so a large blob does not blow the V8
// regex stack: `(?:[A-Za-z0-9+/]{4})*` recurses per 4-char group and throws
// RangeError on multi-MB initialData payloads. CHARS checks the alphabet + at
// most 2 trailing '=' in a single linear pass; the length-multiple-of-4 and
// padding-position constraints are enforced separately below.
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

/** Validate canonical RFC 4648 base64 without nested-quantifier backtracking. */
function isValidBase64(s: string): boolean {
  if (s.length % 4 !== 0) return false;
  if (!BASE64_CHARS.test(s)) return false;
  // '=' may appear only as the final 1-2 chars; the flat regex already pins
  // padding to the tail, so a length-multiple-of-4 + alphabet match is sufficient.
  return true;
}

type ParseResult =
  | { readonly ok: true; readonly body: TapeBody }
  | { readonly ok: false; readonly error: string; readonly hint: string };

/** Validate a parsed JSON body against the five required fields (label optional). */
function parseTapeBody(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'invalid-body', hint: 'request body must be a JSON object' };
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.runId !== 'string' || b.runId.length === 0) {
    return { ok: false, error: 'missing-runId', hint: 'runId must be a non-empty string' };
  }
  if (typeof b.json !== 'string') {
    return {
      ok: false,
      error: 'missing-json',
      hint: 'json must be the serialized tape header+events string',
    };
  }
  if (typeof b.blobBase64 !== 'string') {
    return {
      ok: false,
      error: 'missing-blobBase64',
      hint: 'blobBase64 must be a base64 string of the tape blob',
    };
  }
  if (!isValidBase64(b.blobBase64)) {
    return {
      ok: false,
      error: 'invalid-blobBase64',
      hint: 'blobBase64 must be valid standard base64',
    };
  }
  if (!Array.isArray(b.passOffsets)) {
    return {
      ok: false,
      error: 'invalid-passOffsets',
      hint: 'passOffsets must be an array of pass offsets',
    };
  }
  if (typeof b.valid !== 'boolean') {
    return { ok: false, error: 'missing-valid', hint: 'valid must be a boolean' };
  }
  const body: TapeBody = {
    runId: b.runId,
    json: b.json,
    blobBase64: b.blobBase64,
    passOffsets: b.passOffsets as readonly PassOffset[],
    valid: b.valid,
  };
  return typeof b.label === 'string'
    ? { ok: true, body: { ...body, label: b.label } }
    : { ok: true, body };
}

interface MiddlewareRes {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string | Uint8Array): void;
}

function sendJson(res: MiddlewareRes, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readBody(req: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

/** Write the decoded tape to .forgeax-debug/<runId>, returning the two paths. */
function writeTape(body: TapeBody): { tapePath: string; reportPath: string } {
  const blob = Buffer.from(body.blobBase64, 'base64');
  const report = assembleReport({
    json: body.json,
    passOffsets: body.passOffsets,
    valid: body.valid,
  });
  const outDir = join('.forgeax-debug', body.runId);
  mkdirSync(outDir, { recursive: true });
  const tapePath = join(outDir, 'frame-0.tape.bin');
  const reportPath = join(outDir, 'frame-0.report.json');
  writeFileSync(tapePath, blob);
  // Pretty-print: the report is read by humans debugging captures; a single-line
  // dump of hundreds of events is unreadable. 2-space indent keeps it diffable.
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { tapePath, reportPath };
}

export function vitePluginRhiDebug(opts?: { triggerTimeoutMs?: number }): Plugin {
  const triggerTimeoutMs = opts?.triggerTimeoutMs ?? 30_000;

  return {
    name: 'forgeax:rhi-debug',

    config() {
      return { define: { [DEFINE_KEY]: JSON.stringify('1') } };
    },

    configureServer(server: ViteDevServer) {
      let pending: PendingTrigger | undefined;

      server.middlewares.use(async (req, res, next) => {
        const r = req as AsyncIterable<Uint8Array> & { url?: string; method?: string };
        const url = r.url ?? '';

        // Route dispatch: trigger or tape, else pass through.
        if (url === TRIGGER_ROUTE) {
          const out = res as unknown as MiddlewareRes;

          if (r.method !== 'POST') {
            out.setHeader('Allow', 'POST');
            sendJson(out, 405, {
              error: 'method-not-allowed',
              hint: `use POST to trigger a browser capture via ${TRIGGER_ROUTE}`,
            });
            return;
          }

          let raw: unknown;
          try {
            const text = await readBody(r);
            raw = text.length === 0 ? {} : JSON.parse(text);
          } catch {
            sendJson(out, 400, { error: 'invalid-json', hint: 'request body must be valid JSON' });
            return;
          }

          if (typeof raw !== 'object' || raw === null) {
            sendJson(out, 400, {
              error: 'invalid-body',
              hint: 'request body must be a JSON object',
            });
            return;
          }
          const body = raw as TriggerBody;

          if (typeof body.frames !== 'undefined' && typeof body.frames !== 'number') {
            sendJson(out, 400, { error: 'invalid-frames', hint: 'frames must be a number' });
            return;
          }
          if (typeof body.label !== 'undefined' && typeof body.label !== 'string') {
            sendJson(out, 400, { error: 'invalid-label', hint: 'label must be a string' });
            return;
          }

          // 409-busy = slot already occupied (D-3: dev-server-observable signal).
          if (pending !== undefined) {
            sendJson(out, 409, {
              error: 'recorder-busy',
              hint: 'a capture is already in progress; wait for it to complete and retry',
            });
            return;
          }

          // Store resolver + await with timeout.
          const deferred = new Promise<TriggerResult>((resolve) => {
            pending = { resolve };
          });

          const frames = body.frames ?? 1;
          const data: { frames: number; label?: string } = { frames };
          if (body.label !== undefined) {
            data.label = body.label;
          }
          server.ws.send({ type: 'custom', event: 'forgeax-debug:capture', data });

          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

          try {
            const result = await Promise.race([
              deferred,
              new Promise<typeof TIMEOUT_SENTINEL>((r) => {
                timeoutHandle = setTimeout(() => r(TIMEOUT_SENTINEL), triggerTimeoutMs);
              }),
            ]);

            if (result === TIMEOUT_SENTINEL) {
              sendJson(out, 503, {
                error: 'no-browser-tab',
                hint: 'no browser tab responded to the capture request; confirm the dev-server is running and a browser tab with HMR is open, then retry',
              });
            } else {
              sendJson(out, 200, result);
            }
          } finally {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            pending = undefined;
          }

          return;
        }

        if (url === TAPE_ROUTE) {
          const out = res as unknown as MiddlewareRes;
          if (r.method !== 'POST') {
            out.setHeader('Allow', 'POST');
            sendJson(out, 405, {
              error: 'method-not-allowed',
              hint: `use POST to upload a captured tape to ${TAPE_ROUTE}`,
            });
            return;
          }

          let raw: unknown;
          try {
            const text = await readBody(r);
            raw = text.length === 0 ? undefined : JSON.parse(text);
          } catch {
            sendJson(out, 400, { error: 'invalid-json', hint: 'request body must be valid JSON' });
            return;
          }

          const parsed = parseTapeBody(raw);
          if (!parsed.ok) {
            sendJson(out, 400, { error: parsed.error, hint: parsed.hint });
            return;
          }

          const { tapePath, reportPath } = writeTape(parsed.body);
          const result: TriggerResult = { tapePath, reportPath, runId: parsed.body.runId };
          sendJson(out, 200, result);

          // One-shot latch: resolve pending trigger if one is waiting (D-1 / AC-06).
          const slot = pending;
          if (slot !== undefined) {
            pending = undefined;
            slot.resolve(result);
          }

          return;
        }

        next();
      });
    },
  };
}

export default vitePluginRhiDebug;
