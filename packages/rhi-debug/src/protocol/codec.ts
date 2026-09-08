import { err, ok, type Result } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import pako from 'pako';
import { createRhiDebugError } from '../errors';
import {
  type RhiCallEvent,
  TAPE_FORMAT_VERSION,
  TAPE_MAGIC,
  type Tape,
  type TapeBlobCompression,
  type TapeEncodeOptions,
} from './types';
import { validateTape } from './validation';

const MAGIC_BYTES = new TextEncoder().encode(TAPE_MAGIC);
const HEADER_BYTES = MAGIC_BYTES.byteLength + 12;

interface WireBlob {
  readonly hash: string;
  readonly offset: number;
  readonly length: number;
  readonly compression: TapeBlobCompression;
  readonly digest: string;
}

interface WireTape {
  readonly header: Tape['header'];
  readonly bootstrap: Tape['bootstrap'];
  readonly events: readonly RhiCallEvent[];
  readonly blobs: readonly WireBlob[];
}

export function encodeTape(
  tape: Tape,
  options: TapeEncodeOptions = {},
): Result<Uint8Array, ReturnType<typeof createRhiDebugError<'tape-invalid'>>> {
  const validation = validateTape(tape);
  if (!validation.ok) return validation;
  const compression = options.compression ?? tape.blobs[0]?.compression ?? 'none';
  const payloads: Uint8Array[] = [];
  const blobs: WireBlob[] = [];
  let offset = 0;
  for (const blob of tape.blobs) {
    const raw = new Uint8Array(blob.bytes);
    const payload = compression === 'gzip' ? pako.gzip(raw) : raw;
    payloads.push(payload);
    blobs.push({
      hash: blob.hash,
      offset,
      length: payload.byteLength,
      compression,
      digest: digestBytes(payload),
    });
    offset += payload.byteLength;
  }
  const wire: WireTape = {
    header: { ...tape.header, blobCount: blobs.length },
    bootstrap: tape.bootstrap,
    events: tape.events,
    blobs,
  };
  const json = canonicalJson(wire);
  const jsonBytes = new TextEncoder().encode(json);
  const output = new Uint8Array(HEADER_BYTES + jsonBytes.byteLength + offset);
  output.set(MAGIC_BYTES, 0);
  const view = new DataView(output.buffer);
  view.setUint32(MAGIC_BYTES.byteLength, TAPE_FORMAT_VERSION, true);
  view.setUint32(MAGIC_BYTES.byteLength + 4, jsonBytes.byteLength, true);
  view.setUint32(MAGIC_BYTES.byteLength + 8, offset, true);
  output.set(jsonBytes, HEADER_BYTES);
  let cursor = HEADER_BYTES + jsonBytes.byteLength;
  for (const payload of payloads) {
    output.set(payload, cursor);
    cursor += payload.byteLength;
  }
  return ok(output);
}

export function decodeTape(
  bytes: Uint8Array,
): Result<
  Tape,
  | ReturnType<typeof createRhiDebugError<'tape-invalid'>>
  | ReturnType<typeof createRhiDebugError<'tape-version-unsupported'>>
> {
  const legacy = decodeLegacyVersion(bytes);
  if (legacy !== undefined)
    return err(
      createRhiDebugError('tape-version-unsupported', { foundVersion: legacy, expectedVersion: 7 }),
    );
  if (bytes.byteLength < HEADER_BYTES)
    return err(
      createRhiDebugError('tape-invalid', { stage: 'decode', cause: 'container is truncated' }),
    );
  for (let i = 0; i < MAGIC_BYTES.byteLength; i++) {
    if (bytes[i] !== MAGIC_BYTES[i])
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'decode',
          cause: 'magic does not match RHITAPE',
        }),
      );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(MAGIC_BYTES.byteLength, true);
  if (version !== TAPE_FORMAT_VERSION)
    return err(
      createRhiDebugError('tape-version-unsupported', {
        foundVersion: version,
        expectedVersion: 7,
      }),
    );
  const jsonLength = view.getUint32(MAGIC_BYTES.byteLength + 4, true);
  const payloadLength = view.getUint32(MAGIC_BYTES.byteLength + 8, true);
  const payloadStart = HEADER_BYTES + jsonLength;
  if (payloadStart > bytes.byteLength || payloadStart + payloadLength !== bytes.byteLength) {
    return err(
      createRhiDebugError('tape-invalid', {
        stage: 'decode',
        cause: 'container length is out of bounds',
      }),
    );
  }
  let wire: WireTape;
  try {
    wire = JSON.parse(
      new TextDecoder().decode(bytes.subarray(HEADER_BYTES, payloadStart)),
    ) as WireTape;
  } catch {
    return err(
      createRhiDebugError('tape-invalid', { stage: 'decode', cause: 'canonical JSON is invalid' }),
    );
  }
  if (
    wire.header?.formatVersion !== TAPE_FORMAT_VERSION ||
    !Array.isArray(wire.events) ||
    !Array.isArray(wire.blobs)
  ) {
    return err(
      createRhiDebugError('tape-invalid', {
        stage: 'validate',
        cause: 'required v7 fields are missing',
      }),
    );
  }
  const payload = bytes.subarray(payloadStart);
  const decodedBlobs = [];
  for (const blob of wire.blobs) {
    if (
      !Number.isInteger(blob.offset) ||
      !Number.isInteger(blob.length) ||
      blob.offset < 0 ||
      blob.length < 0 ||
      blob.offset + blob.length > payload.byteLength
    ) {
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: 'blob table entry is out of bounds',
        }),
      );
    }
    const stored = payload.slice(blob.offset, blob.offset + blob.length);
    if (digestBytes(stored) !== blob.digest)
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: `blob digest mismatch for ${blob.hash}`,
        }),
      );
    let raw: Uint8Array;
    try {
      raw = blob.compression === 'gzip' ? new Uint8Array(pako.ungzip(stored)) : stored;
    } catch {
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'decode',
          cause: `blob decompression failed for ${blob.hash}`,
        }),
      );
    }
    decodedBlobs.push({ hash: blob.hash, bytes: raw, compression: blob.compression });
  }
  const tape: Tape = {
    header: { ...wire.header, formatVersion: TAPE_FORMAT_VERSION, blobCount: decodedBlobs.length },
    bootstrap: wire.bootstrap ?? [],
    events: wire.events,
    blobs: decodedBlobs,
  };
  const validation = validateTape(tape);
  if (!validation.ok) return validation;
  return ok(tape);
}

function decodeLegacyVersion(bytes: Uint8Array): number | undefined {
  if (bytes.length === 0 || bytes[0] !== 123) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { formatVersion?: unknown };
    return typeof parsed.formatVersion === 'number' && parsed.formatVersion !== 7
      ? parsed.formatVersion
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${bytesToHex(sha256(bytes))}`;
}
