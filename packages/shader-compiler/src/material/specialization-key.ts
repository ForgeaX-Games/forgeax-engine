export type MaterialDefineValue =
  | { readonly type: 'undefined' }
  | { readonly type: 'bool'; readonly value: boolean }
  | { readonly type: 'int'; readonly value: number }
  | { readonly type: 'uint'; readonly value: number }
  | boolean
  | number
  | undefined;

export interface MaterialSpecializationPassInput {
  readonly name: string;
  readonly module: string;
  readonly entries?: Readonly<Record<string, string>>;
  readonly sourceClosure?: Readonly<Record<string, string>>;
  readonly defs?: Readonly<Record<string, MaterialDefineValue>>;
  readonly moduleSlots?: Readonly<Record<string, string>>;
  readonly renderState?: Readonly<Record<string, unknown>>;
}

export interface MaterialSpecializationKeyInput {
  readonly contractHash: string;
  readonly passes: readonly MaterialSpecializationPassInput[];
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
  readonly versions: {
    readonly profile: string;
    readonly adapter: string;
    readonly compiler: string;
  };
  readonly path?: string;
  readonly generation?: number;
}

export interface MaterialSpecializationKey {
  readonly preimage: string;
  readonly digest: string;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareKeys(left, right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

function normalizeDefine(value: MaterialDefineValue): Record<string, unknown> {
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'boolean') return { type: 'bool', value };
  if (typeof value === 'number') return { type: 'int', value };
  return value.type === 'undefined' ? { type: 'undefined' } : value;
}

function normalizeDefs(defs: Readonly<Record<string, MaterialDefineValue>> | undefined) {
  return Object.fromEntries(
    Object.entries(defs ?? {})
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([name, value]) => [name, normalizeDefine(value)]),
  );
}

function normalizeSlots(slots: Readonly<Record<string, string>> | undefined) {
  return Object.entries(slots ?? {})
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([name, module]) => ({ module, name }));
}

function normalizePass(pass: MaterialSpecializationPassInput) {
  return {
    name: pass.name,
    module: pass.module,
    entries: pass.entries ?? {},
    sourceClosure: pass.sourceClosure ?? {},
    defs: normalizeDefs(pass.defs),
    moduleSlots: normalizeSlots(pass.moduleSlots),
    renderState: pass.renderState ?? {},
  };
}

function normalizeInput(input: MaterialSpecializationKeyInput) {
  return {
    schema: 'forgeax.material.specialization.v1',
    contractHash: input.contractHash,
    passes: input.passes.map(normalizePass),
    vertexInputs: [...input.vertexInputs].sort((left, right) => {
      const leftLocation = Number(left.location ?? 0);
      const rightLocation = Number(right.location ?? 0);
      return leftLocation - rightLocation;
    }),
    versions: input.versions,
  };
}

const ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15] ?? 0;
      const b = words[index - 2] ?? 0;
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      words[index] = ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index++) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 =
        (h + sigma1 + choice + (ROUND_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

export function createMaterialSpecializationKey(
  input: MaterialSpecializationKeyInput,
): MaterialSpecializationKey {
  const preimage = canonical(normalizeInput(input));
  return { preimage, digest: sha256(preimage) };
}
