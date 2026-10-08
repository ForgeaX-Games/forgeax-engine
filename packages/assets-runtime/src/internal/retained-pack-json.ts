// Capture optional platform methods without consulting response.text or function.call.
// The fast path assumes standard platform Body semantics, not arbitrary polyfills.
// A global subclass or adapter prototype must retain the original json-reader path.
const responsePrototype = globalThis.Response?.prototype;
const platformResponsePrototype =
  responsePrototype !== null &&
  typeof responsePrototype === 'object' &&
  Object.getPrototypeOf(responsePrototype) === Object.prototype
    ? responsePrototype
    : undefined;
const platformReadJson =
  platformResponsePrototype === undefined
    ? undefined
    : Object.getOwnPropertyDescriptor(platformResponsePrototype, 'json')?.value;
const platformReadText =
  platformResponsePrototype === undefined
    ? undefined
    : Object.getOwnPropertyDescriptor(platformResponsePrototype, 'text')?.value;

/** Retain only owner-parsed platform JSON; custom readers keep their original ownership. */
export async function readRetainedPackJson(response: Pick<Response, 'json'>): Promise<unknown> {
  const readJson = response.json;
  if (
    typeof platformReadJson === 'function' &&
    typeof platformReadText === 'function' &&
    readJson === platformReadJson &&
    Object.getPrototypeOf(response) === platformResponsePrototype &&
    !Object.hasOwn(response, 'json') &&
    !Object.hasOwn(response, 'text') &&
    Object.getOwnPropertyDescriptor(platformResponsePrototype, 'json')?.value ===
      platformReadJson &&
    Object.getOwnPropertyDescriptor(platformResponsePrototype, 'text')?.value === platformReadText
  ) {
    return parseRetainedPackJson(await Reflect.apply(platformReadText, response, []));
  }
  return Reflect.apply(readJson, response, []);
}

// Only JSON text parsed by this owner can acquire the retained-tree brand.
// Public cache objects, including proxies around parsed nodes, are never branded.
const parsedNodes = new WeakSet<object>();
const parsedKeys = new WeakMap<object, readonly string[]>();

export function parseRetainedPackJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const pending = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object') continue;
    parsedNodes.add(node);
    const keys = Reflect.ownKeys(node) as string[];
    parsedKeys.set(node, keys);
    for (const key of keys) {
      if (Array.isArray(node) && key === 'length') continue;
      pending.push((node as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Recheck current data descriptors and ownership; a parse-time brand alone is insufficient. */
export function isRetainedJsonTree(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || !parsedNodes.has(value)) return false;
  const pending = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node === 'string' || typeof node === 'boolean') continue;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) return false;
      continue;
    }
    if (typeof node !== 'object' || !parsedNodes.has(node) || visited.has(node)) return false;
    visited.add(node);
    const array = Array.isArray(node);
    if (Object.getPrototypeOf(node) !== (array ? Array.prototype : Object.prototype)) return false;
    const original = parsedKeys.get(node);
    const keys = Reflect.ownKeys(node);
    if (original === undefined || keys.length !== original.length) return false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (typeof key !== 'string' || key !== original[i]) return false;
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return false;
      if (array && key === 'length') {
        if (
          descriptor.enumerable ||
          !Number.isSafeInteger(descriptor.value) ||
          descriptor.value !== keys.length - 1
        )
          return false;
        continue;
      }
      if (!descriptor.enumerable) return false;
      pending.push(descriptor.value);
    }
  }
  return true;
}
