import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';

// Base64 chunks must end on a complete three-byte group.
const CHUNK_SIZE = 48 * 1024;

/** One canonical byte sequence, consumed either as JSON text or incrementally. */
function* canonicalDdcChunks(value: unknown): Generator<string> {
  const binary = new Map<object, Buffer>();
  function sortValue(input: unknown): unknown {
    if (input instanceof Uint8Array) {
      const encoded = { encoding: 'base64', bytes: '' };
      // Snapshot now: subsequent author getters may mutate the original bytes.
      binary.set(encoded, Buffer.from(input));
      return encoded;
    }
    if (Array.isArray(input)) return input.map(sortValue);
    if (input !== null && typeof input === 'object') {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        result[key] = sortValue((input as Record<string, unknown>)[key]);
      }
      return result;
    }
    return input;
  }

  function* emit(input: unknown, key: string, prefix = ''): Generator<string, boolean> {
    if (typeof input === 'string') {
      if (prefix) yield prefix;
      yield '"';
      for (let offset = 0; offset < input.length; ) {
        let end = Math.min(offset + CHUNK_SIZE, input.length);
        const last = input.charCodeAt(end - 1);
        const next = input.charCodeAt(end);
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end++;
        yield JSON.stringify(input.slice(offset, end)).slice(1, -1);
        offset = end;
      }
      yield '"';
      return true;
    }
    if (
      ((input !== null && typeof input === 'object') || typeof input === 'function') &&
      'toJSON' in input &&
      typeof input.toJSON === 'function'
    ) {
      // Native JSON owns arbitrary user callbacks, including their property key.
      // Producer POD and binary inputs take the bounded streaming path below.
      // Expose ordinary writable values before any callback can inspect them.
      for (const [wrapper, snapshot] of binary) {
        Object.assign(wrapper, { bytes: snapshot.toString('base64') });
      }
      binary.clear();
      const json = JSON.stringify({ [key]: input });
      if (json === '{}') return false;
      if (prefix) yield prefix;
      yield json.slice(JSON.stringify(key).length + 2, -1);
      return true;
    }
    if (input === null || typeof input !== 'object') {
      // JSON numbers use ECMAScript Number::toString, except non-finite values.
      // Large cooked byte arrays must not invoke the native JSON encoder per byte.
      const json =
        typeof input === 'number'
          ? Number.isFinite(input)
            ? String(input)
            : 'null'
          : JSON.stringify(input);
      if (json === undefined) return false;
      if (prefix) yield prefix;
      yield json;
      return true;
    }
    if (prefix) yield prefix;
    const bytes = binary.get(input);
    if (bytes !== undefined) {
      // This order predates streaming: binary wrappers bypass object sorting.
      yield '{"encoding":"base64","bytes":"';
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
        yield Buffer.from(
          bytes.buffer,
          bytes.byteOffset + offset,
          Math.min(CHUNK_SIZE, bytes.byteLength - offset),
        ).toString('base64');
      }
      yield '"}';
      return true;
    }
    if (Array.isArray(input)) {
      yield '[';
      let numbers = '';
      for (let index = 0; index < input.length; index++) {
        const item = input[index];
        // Cooked JSON contains large numeric byte arrays. Yield bounded runs,
        // rather than forwarding each byte through every ancestor generator.
        if (typeof item === 'number') {
          numbers += `${index > 0 ? ',' : ''}${Number.isFinite(item) ? String(item) : 'null'}`;
          if (numbers.length >= CHUNK_SIZE) {
            yield numbers;
            numbers = '';
          }
          continue;
        }
        if (numbers) {
          yield numbers;
          numbers = '';
        }
        if (index > 0) yield ',';
        if (!(yield* emit(item, String(index)))) yield 'null';
      }
      if (numbers) yield numbers;
      yield ']';
      return true;
    }
    yield '{';
    let first = true;
    // Object.keys retains ECMAScript integer-index order after canonical sorting.
    for (const property of Object.keys(input)) {
      if (
        yield* emit(
          (input as Record<string, unknown>)[property],
          property,
          `${first ? '' : ','}${JSON.stringify(property)}:`,
        )
      )
        first = false;
    }
    yield '}';
    return true;
  }
  if (!(yield* emit(sortValue(value), ''))) yield 'null';
}

export function writeCanonicalDdcJson(value: unknown, write: (chunk: string) => void): void {
  for (const chunk of canonicalDdcChunks(value)) write(chunk);
}

export function canonicalDdcDigest(value: unknown): string {
  const hash = createHash('sha256');
  // Small scalar/punctuation chunks must not cross the native hash boundary
  // individually. Bound the joined text while retaining exactly the same bytes.
  let pending = '';
  writeCanonicalDdcJson(value, (chunk) => {
    pending += chunk;
    if (pending.length >= CHUNK_SIZE) {
      hash.update(pending);
      pending = '';
    }
  });
  if (pending.length > 0) hash.update(pending);
  return hash.digest('hex');
}

/** Only reader-owned JSON/bytes: source callbacks must stay on the synchronous path. */
export async function canonicalDdcReadbackDigest(value: unknown): Promise<string> {
  const hash = createHash('sha256');
  let pending = '';
  let yieldedAt = performance.now();
  for (const chunk of canonicalDdcChunks(value)) {
    pending += chunk;
    if (pending.length >= CHUNK_SIZE) {
      hash.update(pending);
      pending = '';
      if (performance.now() - yieldedAt >= 8) {
        await setImmediate();
        yieldedAt = performance.now();
      }
    }
  }
  if (pending.length > 0) hash.update(pending);
  return hash.digest('hex');
}
