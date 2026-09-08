// @forgeax/engine-rhi-debug/browser -- browser-only capture transport.

import { err, ok, type Result } from '@forgeax/engine-types';
import type { RhiDebugError } from './errors';
import type { CaptureFrameOptions, EncodedTape, RecorderAttachment } from './recorder/session';

export interface BrowserCaptureProvider {
  captureFrame(options?: CaptureFrameOptions): Promise<Result<EncodedTape, RhiDebugError>>;
}

export interface BrowserCaptureOptions {
  readonly endpoint?: string;
  readonly runId?: string;
  readonly capture?: CaptureFrameOptions;
  readonly signal?: AbortSignal;
}

export interface BrowserArtifactRef {
  readonly kind: 'rhi-tape';
  readonly digest: string;
  readonly path?: string;
}

export type BrowserCaptureError =
  | {
      readonly code: 'browser-capture-transport-unavailable';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly endpoint: string };
    }
  | {
      readonly code: 'browser-capture-upload-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly endpoint: string; readonly status: number };
    }
  | {
      readonly code: 'browser-capture-response-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly endpoint: string; readonly cause: string };
    };

export function browserCaptureProvider(attachment: RecorderAttachment): BrowserCaptureProvider {
  return attachment;
}

export async function captureAndUpload(
  provider: BrowserCaptureProvider,
  options: BrowserCaptureOptions = {},
): Promise<Result<BrowserArtifactRef, RhiDebugError | BrowserCaptureError>> {
  const captureOptions = mergeCaptureOptions(options.capture, options.signal);
  const captured = await provider.captureFrame(captureOptions);
  if (!captured.ok) return captured;
  return uploadTape(captured.value, options);
}

export async function uploadTape(
  tape: Pick<EncodedTape, 'bytes' | 'digest'>,
  options: BrowserCaptureOptions = {},
): Promise<Result<BrowserArtifactRef, BrowserCaptureError>> {
  const endpoint = options.endpoint ?? '/__forgeax-debug/tape';
  const runId = options.runId ?? createRunId();
  const url = `${endpoint}?runId=${encodeURIComponent(runId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-forgeax-rhitape' },
      body: copyBytes(tape.bytes),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return err({
      code: 'browser-capture-transport-unavailable',
      expected: 'the configured RHI tape endpoint to accept a browser upload',
      hint: 'start the Vite RHI-debug transport or provide a reachable endpoint',
      detail: { endpoint },
    });
  }

  if (!response.ok) {
    return err({
      code: 'browser-capture-upload-failed',
      expected: 'the RHI tape endpoint to accept the validated artifact',
      hint: 'inspect the endpoint response and retry one capture',
      detail: { endpoint, status: response.status },
    });
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch (cause) {
    return err({
      code: 'browser-capture-response-invalid',
      expected: 'the RHI tape endpoint to return a JSON artifact reference',
      hint: 'check the dev transport response body before retrying',
      detail: { endpoint, cause: String(cause) },
    });
  }
  if (!isArtifactRef(value)) {
    return err({
      code: 'browser-capture-response-invalid',
      expected: 'the RHI tape endpoint to return a rhi-tape artifact reference',
      hint: 'check the endpoint contract and capture again',
      detail: { endpoint, cause: 'response is not a rhi-tape artifact reference' },
    });
  }
  return ok(value);
}

function mergeCaptureOptions(
  capture: CaptureFrameOptions | undefined,
  signal: AbortSignal | undefined,
): CaptureFrameOptions | undefined {
  if (capture === undefined && signal === undefined) return undefined;
  return { ...capture, ...(signal === undefined ? {} : { signal }) };
}

function createRunId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  return randomUUID === undefined
    ? `rhi-capture-${Date.now().toString(36)}`
    : `rhi-capture-${randomUUID()}`;
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function isArtifactRef(value: unknown): value is BrowserArtifactRef {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as {
    readonly kind?: unknown;
    readonly digest?: unknown;
    readonly path?: unknown;
  };
  return (
    candidate.kind === 'rhi-tape' &&
    typeof candidate.digest === 'string' &&
    (candidate.path === undefined || typeof candidate.path === 'string')
  );
}
