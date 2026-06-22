// Integration tests for POST /__forgeax-debug/tape (w10 + w11).
//
// w10: legal body -> writes .forgeax-debug/<runId>/frame-0.{tape.bin,report.json}
//   byte-identical to the Node finalize() tail (assembleReport single-writer,
//   D-3 / AC-05).
// w11: illegal body -> {error, hint} envelope, NO disk write (Fail Fast / AC-06).

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { assembleReport, finalizeToMemory } from '@forgeax/engine-rhi-debug';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { vitePluginRhiDebug } from '../index';
import { recordOneFrameToMemory } from './fixtures/record-frame';

// ─── Test harness: capture the connect middleware + drive it ─────────────────

interface CapturedRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(chunk?: string | Uint8Array): void;
}

function makeRes(): CapturedRes {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk === undefined) return;
      this.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    },
  };
}

type Handler = (req: unknown, res: unknown, next: () => void) => unknown;

function makeServer(): { server: unknown; getHandler(): Handler | undefined } {
  let handler: Handler | undefined;
  return {
    server: {
      middlewares: {
        use(h: Handler) {
          handler = h;
        },
      },
      watcher: { on: () => {} },
    },
    getHandler: () => handler,
  };
}

function mountHandler(): Handler {
  const cap = makeServer();
  const plugin = vitePluginRhiDebug();
  // configureServer is typed as ObjectHook<ServerHook>; unwrap to the function.
  const hook =
    typeof plugin.configureServer === 'function'
      ? plugin.configureServer
      : plugin.configureServer?.handler;
  hook?.call(undefined as never, cap.server as never);
  const handler = cap.getHandler();
  if (handler === undefined) throw new Error('plugin did not register a middleware');
  return handler;
}

/** Build a request object the middleware can read a JSON body from. */
function makeReq(opts: {
  url: string;
  method: string;
  body?: string | undefined;
}): Readable & { url: string; method: string } {
  const stream = Readable.from(opts.body === undefined ? [] : [Buffer.from(opts.body, 'utf-8')]);
  return Object.assign(stream, { url: opts.url, method: opts.method });
}

async function postTape(handler: Handler, body: unknown): Promise<CapturedRes> {
  const res = makeRes();
  const req = makeReq({
    url: '/__forgeax-debug/tape',
    method: 'POST',
    body: JSON.stringify(body),
  });
  await handler(req, res, () => {});
  return res;
}

// ─── cwd isolation: .forgeax-debug lands under a tmp dir ─────────────────────

let originalCwd: string;
let tmpRoot: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vprd-'));
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── w10: legal body byte-identical golden ───────────────────────────────────

describe('POST /__forgeax-debug/tape legal body (w10)', () => {
  it('writes frame-0.tape.bin + frame-0.report.json byte-identical to Node finalize tail', async () => {
    const { debugInst } = await recordOneFrameToMemory();
    const fm = finalizeToMemory(debugInst);
    expect(fm.ok).toBe(true);
    if (!fm.ok) return;
    const { runId, json, blob, passOffsets, valid } = fm.value;

    // Golden = exactly what the Node finalize() fs tail would write for this
    // in-memory finalize result (assembleReport single-writer + compact stringify).
    const goldenReport = JSON.stringify(assembleReport({ json, passOffsets, valid }));
    const goldenTape = blob;

    const handler = mountHandler();
    const res = await postTape(handler, {
      runId,
      json,
      blobBase64: Buffer.from(blob).toString('base64'),
      passOffsets,
      valid,
    });

    expect(res.statusCode).toBe(200);
    const returned = JSON.parse(res.body) as {
      tapePath: string;
      reportPath: string;
      runId: string;
    };
    expect(returned.runId).toBe(runId);
    expect(returned.tapePath.length).toBeGreaterThan(0);
    expect(returned.reportPath.length).toBeGreaterThan(0);

    const expectedDir = join('.forgeax-debug', runId);
    const tapePath = join(expectedDir, 'frame-0.tape.bin');
    const reportPath = join(expectedDir, 'frame-0.report.json');
    expect(existsSync(tapePath)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);

    const writtenTape = readFileSync(tapePath);
    expect(Buffer.from(writtenTape).equals(Buffer.from(goldenTape))).toBe(true);

    const writtenReport = readFileSync(reportPath, 'utf-8');
    expect(writtenReport).toBe(goldenReport);
  });

  it('accepts an optional label without breaking the legal path', async () => {
    const { debugInst } = await recordOneFrameToMemory();
    const fm = finalizeToMemory(debugInst);
    expect(fm.ok).toBe(true);
    if (!fm.ok) return;
    const { runId, json, blob, passOffsets, valid } = fm.value;

    const handler = mountHandler();
    const res = await postTape(handler, {
      runId,
      label: 'my-frame',
      json,
      blobBase64: Buffer.from(blob).toString('base64'),
      passOffsets,
      valid,
    });

    expect(res.statusCode).toBe(200);
    expect(existsSync(join('.forgeax-debug', runId, 'frame-0.tape.bin'))).toBe(true);
  });
});

// ─── w11: illegal body envelope, no disk write ───────────────────────────────

describe('POST /__forgeax-debug/tape illegal body (w11)', () => {
  async function legalBody(): Promise<Record<string, unknown>> {
    const { debugInst } = await recordOneFrameToMemory();
    const fm = finalizeToMemory(debugInst);
    if (!fm.ok) throw new Error('finalizeToMemory failed in fixture');
    const { runId, json, blob, passOffsets, valid } = fm.value;
    return {
      runId,
      json,
      blobBase64: Buffer.from(blob).toString('base64'),
      passOffsets,
      valid,
    };
  }

  it.each([
    'runId',
    'json',
    'blobBase64',
    'passOffsets',
    'valid',
  ])('missing required field %s -> {error, hint} envelope, no disk write', async (field) => {
    const body = await legalBody();
    const runId = body.runId as string;
    delete body[field];

    const handler = mountHandler();
    const res = await postTape(handler, body);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const envelope = JSON.parse(res.body) as { error: string; hint: string };
    expect(typeof envelope.error).toBe('string');
    expect(envelope.error.length).toBeGreaterThan(0);
    expect(typeof envelope.hint).toBe('string');
    expect(envelope.hint.length).toBeGreaterThan(0);

    expect(existsSync(join('.forgeax-debug', runId))).toBe(false);
  });

  it('illegal base64 in blobBase64 -> envelope, no disk write', async () => {
    const body = await legalBody();
    const runId = body.runId as string;
    body.blobBase64 = '!!!not-valid-base64!!!';

    const handler = mountHandler();
    const res = await postTape(handler, body);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const envelope = JSON.parse(res.body) as { error: string; hint: string };
    expect(envelope.error.length).toBeGreaterThan(0);
    expect(envelope.hint.length).toBeGreaterThan(0);
    expect(existsSync(join('.forgeax-debug', runId))).toBe(false);
  });

  it('passOffsets not an array -> envelope, no disk write', async () => {
    const body = await legalBody();
    const runId = body.runId as string;
    body.passOffsets = 'not-an-array';

    const handler = mountHandler();
    const res = await postTape(handler, body);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(existsSync(join('.forgeax-debug', runId))).toBe(false);
  });

  it('non-POST method -> 405 envelope with Allow header', async () => {
    const handler = mountHandler();
    const res = makeRes();
    const req = makeReq({ url: '/__forgeax-debug/tape', method: 'GET' });
    await handler(req, res, () => {});

    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toContain('POST');
    const envelope = JSON.parse(res.body) as { error: string; hint: string };
    expect(envelope.error.length).toBeGreaterThan(0);
    expect(envelope.hint.length).toBeGreaterThan(0);
  });
});
