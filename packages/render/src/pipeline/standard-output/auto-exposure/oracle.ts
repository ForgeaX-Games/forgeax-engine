import { AUTO_EXPOSURE_PRESET_V1 } from './preset';

const RGB_TO_XYZ_D65 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
] as const;
const D65_XYZ = [0.95047, 1, 1.08883] as const;
const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
] as const;
const BRADFORD_INVERSE = [
  [0.9869929, -0.1470543, 0.1599627],
  [0.4323053, 0.5183603, 0.0492912],
  [-0.0085287, 0.0400428, 0.9684867],
] as const;

function multiply3(
  matrix: readonly (readonly number[])[],
  value: readonly [number, number, number],
): [number, number, number] {
  const row0 = matrix[0] ?? [0, 0, 0];
  const row1 = matrix[1] ?? [0, 0, 0];
  const row2 = matrix[2] ?? [0, 0, 0];
  return [
    (row0[0] ?? 0) * value[0] + (row0[1] ?? 0) * value[1] + (row0[2] ?? 0) * value[2],
    (row1[0] ?? 0) * value[0] + (row1[1] ?? 0) * value[1] + (row1[2] ?? 0) * value[2],
    (row2[0] ?? 0) * value[0] + (row2[1] ?? 0) * value[1] + (row2[2] ?? 0) * value[2],
  ];
}

function blackbodyWhitePoint(temperature: number): [number, number, number] {
  if (temperature === 6504) return [...D65_XYZ];
  const t = Math.min(40000, Math.max(1000, temperature));
  const x =
    t <= 4000
      ? -0.2661239e9 / t ** 3 - 0.234358e6 / t ** 2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y =
    t <= 2222
      ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x / y, 1, (1 - x - y) / y];
}

export function luminanceHistogram(
  pixels: readonly (readonly [number, number, number, number])[],
  bins = AUTO_EXPOSURE_PRESET_V1.histogramBins,
): Uint32Array {
  const histogram = new Uint32Array(bins);
  const min = AUTO_EXPOSURE_PRESET_V1.logLuminanceMin;
  const max = AUTO_EXPOSURE_PRESET_V1.logLuminanceMax;
  for (const pixel of pixels) {
    const luminance = 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2];
    if (!Number.isFinite(luminance) || luminance <= 0) continue;
    const normalized = (Math.log2(luminance) - min) / (max - min);
    const index = Math.min(bins - 1, Math.max(0, Math.floor(normalized * bins)));
    const bucket = histogram[index];
    if (bucket !== undefined) histogram[index] = bucket + 1;
  }
  return histogram;
}

/**
 * Mirror the fixed shader-side center weighting for deterministic tests. The
 * sample list is row-major over the metering grid (one sample per 4x4 block),
 * so the helper never changes the texture-read/sample-count contract.
 */
export function centerWeight(
  block: readonly [number, number],
  sampleGrid: readonly [number, number],
): number {
  const centerX = (sampleGrid[0] - 1) * 0.5;
  const centerY = (sampleGrid[1] - 1) * 0.5;
  const extentX = Math.max(centerX, 1);
  const extentY = Math.max(centerY, 1);
  const offsetX = (block[0] - centerX) / extentX;
  const offsetY = (block[1] - centerY) / extentY;
  const radial = Math.max(0, 1 - offsetX * offsetX - offsetY * offsetY);
  return 1 + Math.min(2, Math.floor(radial * 2 + 0.5));
}

export function weightedLuminanceHistogram(
  pixels: readonly (readonly [number, number, number, number])[],
  sampleGrid: readonly [number, number],
  bins = AUTO_EXPOSURE_PRESET_V1.histogramBins,
): Uint32Array {
  const histogram = new Uint32Array(bins);
  const min = AUTO_EXPOSURE_PRESET_V1.logLuminanceMin;
  const max = AUTO_EXPOSURE_PRESET_V1.logLuminanceMax;
  const width = Math.max(1, Math.floor(sampleGrid[0]));
  const height = Math.max(1, Math.floor(sampleGrid[1]));
  for (let index = 0; index < Math.min(pixels.length, width * height); index += 1) {
    const pixel = pixels[index];
    if (pixel === undefined) continue;
    const luminance = 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2];
    if (!Number.isFinite(luminance) || luminance <= 0) continue;
    const normalized = (Math.log2(luminance) - min) / (max - min);
    const bucket = Math.min(bins - 1, Math.max(0, Math.floor(normalized * bins)));
    const row = Math.floor(index / width);
    const column = index - row * width;
    const weight = centerWeight([column, row], [width, height]);
    const current = histogram[bucket];
    if (current !== undefined) histogram[bucket] = current + weight;
  }
  return histogram;
}

/** Fixed product target mapping used to compare GPU adaptation with a CPU oracle. */
export function autoExposureTarget(
  histogram: Uint32Array,
  compensationEv: number,
  rangeEv: readonly [number, number],
  fallback: number,
): number {
  if (
    ![compensationEv, rangeEv[0], rangeEv[1], fallback].every(Number.isFinite) ||
    fallback <= 0 ||
    rangeEv[0] > rangeEv[1]
  ) {
    return fallback;
  }
  const total = histogram.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return fallback;
  const lowRank = Math.min(total, Math.floor(total * 0.05));
  const highRank = Math.min(total, Math.max(lowRank + 1, Math.ceil(total * 0.95)));
  let cumulative = 0;
  let clippedTotal = 0;
  let clippedWeightedLog = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    const count = histogram[index] ?? 0;
    const begin = cumulative;
    cumulative += count;
    const keptBegin = Math.max(begin, lowRank);
    const keptEnd = Math.min(cumulative, highRank);
    if (keptEnd > keptBegin) {
      const kept = keptEnd - keptBegin;
      clippedTotal += kept;
      clippedWeightedLog +=
        kept *
        (AUTO_EXPOSURE_PRESET_V1.logLuminanceMin +
          (index + 0.5) *
            ((AUTO_EXPOSURE_PRESET_V1.logLuminanceMax - AUTO_EXPOSURE_PRESET_V1.logLuminanceMin) /
              histogram.length));
    }
  }
  if (clippedTotal <= 0) return fallback;
  const averageLog = clippedWeightedLog / clippedTotal;
  const measuredExposure = 2 ** -averageLog * AUTO_EXPOSURE_PRESET_V1.middleGray;
  if (!Number.isFinite(measuredExposure)) return fallback;
  const targetEv = Math.min(
    rangeEv[1],
    Math.max(rangeEv[0], Math.log2(Math.max(measuredExposure, 1e-6)) + compensationEv),
  );
  const target = 2 ** targetEv;
  return Number.isFinite(target) && target > 0 ? target : fallback;
}

export function histogramPercentile(histogram: Uint32Array, percentile: number): number {
  const total = histogram.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  const target = Math.min(total - 1, Math.max(0, Math.floor(percentile * total)));
  let accumulated = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    accumulated += histogram[index] ?? 0;
    if (accumulated > target) {
      return (
        AUTO_EXPOSURE_PRESET_V1.logLuminanceMin +
        ((index + 0.5) / histogram.length) *
          (AUTO_EXPOSURE_PRESET_V1.logLuminanceMax - AUTO_EXPOSURE_PRESET_V1.logLuminanceMin)
      );
    }
  }
  return AUTO_EXPOSURE_PRESET_V1.logLuminanceMax;
}

export function adaptExposure(
  current: number,
  target: number,
  deltaTime: number,
  upRate: number,
  downRate: number,
): number {
  if (![current, target, deltaTime, upRate, downRate].every(Number.isFinite)) return current;
  if (deltaTime <= 0 || current === target) return current;
  const rate = target > current ? Math.max(0, upRate) : Math.max(0, downRate);
  if (rate === 0) return current;
  const amount = 1 - Math.exp(-rate * deltaTime);
  return current + (target - current) * amount;
}

export function bradfordAdaptD65(
  rgb: readonly [number, number, number],
  temperature: number,
): [number, number, number] {
  if (temperature === 6504) return [rgb[0], rgb[1], rgb[2]];
  const source = multiply3(BRADFORD, D65_XYZ);
  const target = multiply3(BRADFORD, blackbodyWhitePoint(temperature));
  const scale: [number, number, number] = [
    target[0] / source[0],
    target[1] / source[1],
    target[2] / source[2],
  ];
  const adaptedLms = multiply3(BRADFORD, multiply3(RGB_TO_XYZ_D65, rgb));
  const adaptedXyz = multiply3(BRADFORD_INVERSE, [
    adaptedLms[0] * scale[0],
    adaptedLms[1] * scale[1],
    adaptedLms[2] * scale[2],
  ]);
  return [adaptedXyz[0] / 0.95047, adaptedXyz[1], adaptedXyz[2] / 1.08883];
}

function labPivot(value: number): number {
  const epsilon = (6 / 29) ** 3;
  const kappa = (29 / 3) ** 3;
  return value > epsilon ? Math.cbrt(value) : value * kappa + 4 / 29;
}

export function linearRgbToLab(rgb: readonly [number, number, number]): [number, number, number] {
  const xyz = multiply3(RGB_TO_XYZ_D65, rgb);
  const x = labPivot(xyz[0] / D65_XYZ[0]);
  const y = labPivot(xyz[1] / D65_XYZ[1]);
  const z = labPivot(xyz[2] / D65_XYZ[2]);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function ciede2000(
  first: readonly [number, number, number],
  second: readonly [number, number, number],
): number {
  const [l1, a1, b1] = first;
  const [l2, a2, b2] = second;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;
  const c1Prime = Math.hypot(a1Prime, b1);
  const c2Prime = Math.hypot(a2Prime, b2);
  const h1 = hueAngle(a1Prime, b1);
  const h2 = hueAngle(a2Prime, b2);
  const deltaL = l2 - l1;
  const deltaC = c2Prime - c1Prime;
  const deltaH = hueDelta(h1, h2, c1Prime * c2Prime);
  const deltaBigH = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(deltaH / 2);
  const lBar = (l1 + l2) / 2;
  const cBarPrime = (c1Prime + c2Prime) / 2;
  const hBar = hueMean(h1, h2);
  const t =
    1 -
    0.17 * Math.cos(hBar - Math.PI / 6) +
    0.24 * Math.cos(2 * hBar) +
    0.32 * Math.cos(3 * hBar + Math.PI / 30) -
    0.2 * Math.cos(4 * hBar - (21 * Math.PI) / 60);
  const deltaTheta =
    ((30 * Math.PI) / 180) * Math.exp(-((((hBar * 180) / Math.PI - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarPrime ** 7 / (cBarPrime ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cBarPrime;
  const sh = 1 + 0.015 * cBarPrime * t;
  const rt = -Math.sin(2 * deltaTheta) * rc;
  return Math.sqrt(
    (deltaL / sl) ** 2 +
      (deltaC / sc) ** 2 +
      (deltaBigH / sh) ** 2 +
      rt * (deltaC / sc) * (deltaBigH / sh),
  );
}

function hueAngle(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const angle = Math.atan2(b, a);
  return angle >= 0 ? angle : angle + 2 * Math.PI;
}

function hueDelta(first: number, second: number, chromaProduct: number): number {
  if (chromaProduct === 0) return 0;
  const delta = second - first;
  if (Math.abs(delta) <= Math.PI) return delta;
  return delta > 0 ? delta - 2 * Math.PI : delta + 2 * Math.PI;
}

function hueMean(first: number, second: number): number {
  if (Math.abs(first - second) <= Math.PI) return (first + second) / 2;
  return (first + second + (first + second < 2 * Math.PI ? 2 * Math.PI : -2 * Math.PI)) / 2;
}
