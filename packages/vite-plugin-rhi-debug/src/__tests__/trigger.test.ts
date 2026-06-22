// Integration tests for POST /__forgeax-debug/trigger (t1).
//
// t1: AC-02 sync 200 -- trigger handler returns after tape resolves the
//     pending slot, returning HTTP 200 + { tapePath, reportPath, runId }.

import { existsSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { finalizeToMemory } from '@forgeax/engine-rhi-debug';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { vitePluginRhiDebug } from '../index';
import { recordOneFrameToMemory } from './fixtures/record-frame';

// --- Test harness ----------------------------------------------------------

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

interface WsSpy {
  sends: unknown[];
  send(payload: unknown): void;
}

function makeServer(): {
  server: unknown;
  getHandler(): Handler | undefined;
  getWsSpy(): WsSpy;
} {
  let handler: Handler | undefined;
  const wsSpy: WsSpy = {
    sends: [],
    send(payload: unknown) {
      this.sends.push(payload);
    },
  };
  return {
    server: {
      middlewares: {
        use(h: Handler) {
          handler = h;
        },
      },
      watcher: { on: () => {} },
      ws: wsSpy,
    },
    getHandler: () => handler,
    getWsSpy: () => wsSpy,
  };
}

function mountHandler(opts?: { triggerTimeoutMs?: number }): { handler: Handler; wsSpy: WsSpy } {
  const cap = makeServer();
  const plugin = vitePluginRhiDebug(opts);
  const hook =
    typeof plugin.configureServer === 'function'
      ? plugin.configureServer
      : plugin.configureServer?.handler;
  hook?.call(undefined as never, cap.server as never);
  const handler = cap.getHandler();
  if (handler === undefined) throw new Error('plugin did not register a middleware');
  return { handler, wsSpy: cap.getWsSpy() };
}

function makeReq(opts: {
  url: string;
  method: string;
  body?: string | undefined;
}): Readable & { url: string; method: string } {
  const stream = Readable.from(opts.body === undefined ? [] : [Buffer.from(opts.body, 'utf-8')]);
  return Object.assign(stream, { url: opts.url, method: opts.method });
}

async function postTrigger(
  handler: Handler,
  body: { frames?: number; label?: string },
): Promise<CapturedRes> {
  const res = makeRes();
  const req = makeReq({
    url: '/__forgeax-debug/trigger',
    method: 'POST',
    body: JSON.stringify(body),
  });
  await handler(req, res, () => {});
  return res;
}

async function postTape(handler: Handler, body: Record<string, unknown>): Promise<CapturedRes> {
  const res = makeRes();
  const req = makeReq({
    url: '/__forgeax-debug/tape',
    method: 'POST',
    body: JSON.stringify(body),
  });
  await handler(req, res, () => {});
  return res;
}

async function legalTapeBody(): Promise<Record<string, unknown>> {
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

// --- cwd isolation ---------------------------------------------------------

let originalCwd: string;
let tmpRoot: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vprd-trigger-'));
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

// --- t1: AC-02 sync 200 ---------------------------------------------------

describe('POST /__forgeax-debug/trigger sync 200 (t1)', () => {
  it('returns 200 with tapePath/reportPath/runId after tape resolves the slot', async () => {
    const tapeBody = await legalTapeBody();
    const { handler, wsSpy } = mountHandler({ triggerTimeoutMs: 5000 });

    // Fire trigger. readBody completes immediately for Readable.from([buf]),
    // so the handler reaches await Promise.race (slot occupied) before we
    // await the returned promise.
    const triggerPromise = postTrigger(handler, { frames: 1, label: 'test' });

    // Yield to the event loop so the handler reads the body and reaches
    // server.ws.send before we inspect the spy.
    await new Promise((r) => setTimeout(r, 0));

    // ws.send must have been called with the custom capture event.
    expect(wsSpy.sends.length).toBeGreaterThanOrEqual(1);
    const sent = wsSpy.sends[0] as {
      type: string;
      event: string;
      data: { frames: number; label: string };
    };
    expect(sent.type).toBe('custom');
    expect(sent.event).toBe('forgeax-debug:capture');
    expect(sent.data.frames).toBe(1);
    expect(sent.data.label).toBe('test');

    // Resolve the slot by posting a tape.
    const tapeRes = await postTape(handler, tapeBody);
    expect(tapeRes.statusCode).toBe(200);

    // Now the trigger should resolve.
    const triggerRes = await triggerPromise;
    expect(triggerRes.statusCode).toBe(200);

    const body = JSON.parse(triggerRes.body) as {
      tapePath: string;
      reportPath: string;
      runId: string;
    };
    expect(typeof body.tapePath).toBe('string');
    expect(body.tapePath.length).toBeGreaterThan(0);
    expect(typeof body.reportPath).toBe('string');
    expect(body.reportPath.length).toBeGreaterThan(0);
    expect(typeof body.runId).toBe('string');
    expect(body.runId.length).toBeGreaterThan(0);

    // Files must exist on disk.
    expect(existsSync(join('.forgeax-debug', tapeBody.runId as string, 'frame-0.tape.bin'))).toBe(
      true,
    );
    expect(
      existsSync(join('.forgeax-debug', tapeBody.runId as string, 'frame-0.report.json')),
    ).toBe(true);
  });

  it('resolves with label omitted from ws.send data when label is not provided', async () => {
    const tapeBody = await legalTapeBody();
    const { handler, wsSpy } = mountHandler({ triggerTimeoutMs: 5000 });

    const triggerPromise = postTrigger(handler, { frames: 3 });

    await new Promise((r) => setTimeout(r, 0));

    expect(wsSpy.sends.length).toBeGreaterThanOrEqual(1);
    const sent = wsSpy.sends[0] as {
      type: string;
      event: string;
      data: { frames: number };
    };
    expect(sent.data.frames).toBe(3);
    // label must not appear in data when not provided.
    expect('label' in sent.data).toBe(false);

    await postTape(handler, tapeBody);
    const triggerRes = await triggerPromise;
    expect(triggerRes.statusCode).toBe(200);
  });
});

// --- t2: AC-03 trigger 503 timeout ----------------------------------------

describe('POST /__forgeax-debug/trigger 503 timeout (t2)', () => {
  it('returns 503 no-browser-tab after triggerTimeoutMs with no tape resolving', async () => {
    const { handler } = mountHandler({ triggerTimeoutMs: 50 });

    const start = Date.now();
    const res = await postTrigger(handler, { frames: 1 });
    const elapsed = Date.now() - start;

    expect(res.statusCode).toBe(503);

    const body = JSON.parse(res.body) as { error: string; hint: string };
    expect(body.error).toBe('no-browser-tab');
    expect(typeof body.hint).toBe('string');
    expect(body.hint.length).toBeGreaterThan(0);

    // Must finish in << 30s; 50ms timeout + overhead < 5s is plenty.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('clears the slot after timeout so a subsequent trigger works', async () => {
    const { handler } = mountHandler({ triggerTimeoutMs: 50 });

    // First trigger times out.
    const res1 = await postTrigger(handler, { frames: 1 });
    expect(res1.statusCode).toBe(503);

    // Second trigger should also timeout (slot was cleared, not stuck).
    const tapeBody = await legalTapeBody();

    const triggerPromise = postTrigger(handler, { frames: 1 });
    // Yield to the event loop so the handler stores pending before tape arrives.
    await new Promise((r) => setTimeout(r, 0));
    // Resolve the second trigger with a tape.
    await postTape(handler, tapeBody);
    const res2 = await triggerPromise;
    expect(res2.statusCode).toBe(200);

    const body = JSON.parse(res2.body) as {
      tapePath: string;
      reportPath: string;
      runId: string;
    };
    expect(body.tapePath.length).toBeGreaterThan(0);
  });
});

// --- t3: AC-04 409 busy + AC-06 multi-tab latch ---------------------------

describe('POST /__forgeax-debug/trigger 409 busy (t3a)', () => {
  it('returns immediate 409 when slot is occupied by in-flight trigger', async () => {
    const { handler, wsSpy } = mountHandler({ triggerTimeoutMs: 5000 });

    // Occupy the slot with a trigger that will not be resolved.
    // Fire but don't await — handler runs in background.
    void postTrigger(handler, { frames: 1 });

    // Drain microtasks + a few macrotask ticks so readBody completes
    // and the handler stores pending + calls ws.send.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 5));

    // At this point ws.send should have been called if the handler
    // progressed past readBody. If not, the test will fail at the
    // expect below which is the correct assertion.
    expect(wsSpy.sends.length).toBeGreaterThanOrEqual(1);

    // Second trigger while the first is still pending -> immediate 409.
    const res2 = await postTrigger(handler, { frames: 1 });

    expect(res2.statusCode).toBe(409);
    const body = JSON.parse(res2.body) as { error: string; hint: string };
    expect(body.error).toBe('recorder-busy');
    expect(typeof body.hint).toBe('string');
    expect(body.hint.length).toBeGreaterThan(0);

    // The first trigger will eventually time out (5s). We don't wait.
  });
});

describe('POST /__forgeax-debug/trigger multi-tab one-shot latch (t3b)', () => {
  it('returns first tape result; second tape writes disk but does not re-resolve', async () => {
    const tapeBody1 = await legalTapeBody();
    const tapeBody2 = await legalTapeBody();
    // Ensure runIds differ so both tapes write to distinct disk dirs.
    expect(tapeBody1.runId).not.toBe(tapeBody2.runId);

    const { handler } = mountHandler({ triggerTimeoutMs: 5000 });

    // Fire trigger.
    const triggerPromise = postTrigger(handler, { frames: 1, label: 'multi' });

    // Yield to the event loop so the handler stores pending.
    await new Promise((r) => setTimeout(r, 0));

    // First tape resolves the slot.
    const tapeRes1 = await postTape(handler, tapeBody1);
    expect(tapeRes1.statusCode).toBe(200);

    const triggerRes = await triggerPromise;
    expect(triggerRes.statusCode).toBe(200);
    const triggerBody = JSON.parse(triggerRes.body) as {
      tapePath: string;
      reportPath: string;
      runId: string;
    };
    // The trigger response should carry the first tape's runId.
    expect(triggerBody.runId).toBe(tapeBody1.runId);

    // Second tape (arriving later, simulating another tab) still writes to
    // disk but does not affect the already-resolved trigger.
    const tapeRes2 = await postTape(handler, tapeBody2);
    expect(tapeRes2.statusCode).toBe(200);
    const tapeBody2Parsed = JSON.parse(tapeRes2.body) as {
      tapePath: string;
      runId: string;
    };
    expect(tapeBody2Parsed.runId).toBe(tapeBody2.runId);

    expect(existsSync(join('.forgeax-debug', tapeBody1.runId as string, 'frame-0.tape.bin'))).toBe(
      true,
    );
    expect(existsSync(join('.forgeax-debug', tapeBody2.runId as string, 'frame-0.tape.bin'))).toBe(
      true,
    );
  });
});
