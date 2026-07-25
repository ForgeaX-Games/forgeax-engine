// @forgeax/engine-runtime — SSAO kernel + noise data generation.
//
// feat-20260612-hdrp-ssao M1 / w2.
//
// Implements the LO 5.9 host-side algorithm (research F1 + F2):
//  - generateSsaoKernel: 64 vec3 hemisphere samples with quadratic falloff
//    bias (lerp(0.1, 1.0, (i/64)^2)), deterministic given a seed.
//  - generateSsaoNoise: 4x4 vec3 rotation vectors (z=0 tangent-plane),
//    deterministic given a seed.
//
// Both are one-shot, host-side generated (requirements OOS-7: no runtime
// regeneration). Output fits directly into Float32Array for writeBuffer upload.
//
// The mulberry32 PRNG is used for deterministic reproducibility across
// runs — same seed always yields same kernel/noise (AC-03 snapshot).

const KERNEL_SIZE = 64;
const NOISE_SIZE = 16; // 4 x 4

/**
 * Mulberry32 PRNG — fast 32-bit deterministic generator.
 * Returns a float in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

/**
 * Generate 64 SSAO hemisphere sample vectors (tangent-space, z >= 0).
 *
 * Algorithm (LO 5.9, research F1):
 *  1. Random direction on unit sphere with z >= 0.
 *  2. Normalize.
 *  3. Scale by random [0,1].
 *  4. Scale by lerp(0.1, 1.0, (i/64)^2) for quadratic falloff.
 *
 * Each sample is returned as a `[x, y, z]` tuple in a `Float32Array`
 * slice — 64 slices of 3 floats each, packed contiguously for upload.
 *
 * @param seed Optional PRNG seed (default 0). Same seed always produces
 *   the same kernel.
 * @returns Array of 64 `[x, y, z]` arrays (each Float32Array length 3).
 */
export function generateSsaoKernel(seed: number = 0): readonly Float32Array[] {
  const rand = mulberry32(seed);
  const kernel: Float32Array[] = [];
  for (let i = 0; i < KERNEL_SIZE; i++) {
    // Step 1: random direction on unit hemisphere (z >= 0)
    let x = rand() * 2 - 1;
    let y = rand() * 2 - 1;
    let z = rand(); // [0, 1] => z >= 0 hemisphere
    // Step 1b: normalize
    const len = Math.sqrt(x * x + y * y + z * z);
    x /= len;
    y /= len;
    z /= len;
    // Step 2: random length [0, 1]
    const r = rand();
    x *= r;
    y *= r;
    z *= r;
    // Step 3: quadratic falloff — more samples near origin
    const scale = lerp(0.1, 1.0, (i / KERNEL_SIZE) * (i / KERNEL_SIZE));
    const sample = new Float32Array(3);
    sample[0] = x * scale;
    sample[1] = y * scale;
    sample[2] = z * scale;
    kernel.push(sample);
  }
  return kernel;
}

/**
 * Generate 4x4 noise rotation vectors (tangent-space, z = 0).
 *
 * Algorithm (LO 5.9, research F2):
 *  16 vec3 vectors with random xy directions and z = 0.
 *  Used by shader to rotate the 64-sample kernel per-pixel via
 *  tiled sampling (REPEAT addressing).
 *
 * Returns a flat Float32Array of 48 floats (16 vectors x 3
 * components each), suitable for upload as a 4x4 rgba32float texture.
 *
 * @param seed Optional PRNG seed (default 0).
 * @returns Float32Array of length 48.
 */
export function generateSsaoNoise(seed: number = 0): Float32Array {
  const rand = mulberry32(seed);
  const noise = new Float32Array(NOISE_SIZE * 3); // 16 * 3 = 48
  for (let i = 0; i < NOISE_SIZE; i++) {
    noise[i * 3 + 0] = rand() * 2 - 1;
    noise[i * 3 + 1] = rand() * 2 - 1;
    noise[i * 3 + 2] = 0; // tangent-plane rotation (z = 0)
  }
  return noise;
}
