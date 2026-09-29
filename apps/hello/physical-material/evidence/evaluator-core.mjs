export const REFERENCE_VERSION = 'physical-material-reference-v5';

export function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= typeof value === 'string' ? value.charCodeAt(index) : value[index] ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function halfToFloat(value) {
  const sign = (value & 0x8000) === 0 ? 1 : -1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export function readRoiBytes(bytes, roi, width, bytesPerPixel = 8) {
  const result = new Uint8Array(roi.width * roi.height * bytesPerPixel);
  for (let row = 0; row < roi.height; row += 1) {
    const source = ((roi.y + row) * width + roi.x) * bytesPerPixel;
    result.set(bytes.subarray(source, source + roi.width * bytesPerPixel), row * roi.width * bytesPerPixel);
  }
  return result;
}

export function linearHdrMean(bytes, width, roi, label = 'roi') {
  const mean = [0, 0, 0];
  let samples = 0;
  for (let row = roi.y; row < roi.y + roi.height; row += 1) {
    for (let column = roi.x; column < roi.x + roi.width; column += 1) {
      const offset = (row * width + column) * 8;
      const rgb = [
        halfToFloat((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)),
        halfToFloat((bytes[offset + 2] ?? 0) | ((bytes[offset + 3] ?? 0) << 8)),
        halfToFloat((bytes[offset + 4] ?? 0) | ((bytes[offset + 5] ?? 0) << 8)),
      ];
      if (!rgb.every(Number.isFinite)) {
        throw new Error(`${label}: non-finite linear HDR sample at ${column},${row}; bytes=${[...bytes.slice(offset, offset + 8)].join(',')}`);
      }
      mean[0] += rgb[0];
      mean[1] += rgb[1];
      mean[2] += rgb[2];
      samples += 1;
    }
  }
  if (samples === 0) throw new Error('linear HDR ROI is empty');
  return mean.map((value) => value / samples);
}

export function projectLinearHdrRoi(bytes, width, roi, label = 'roi') {
  const rawBytes = readRoiBytes(bytes, roi, width);
  let nonZeroBytes = 0;
  let nonZeroAlphaPixels = 0;
  for (const byte of rawBytes) if (byte !== 0) nonZeroBytes += 1;
  for (let offset = 0; offset < rawBytes.length; offset += 8) {
    if (rawBytes[offset + 6] !== 0 || rawBytes[offset + 7] !== 0) nonZeroAlphaPixels += 1;
  }
  return {
    roi,
    rawBytes,
    rawHash: fnv1a(rawBytes),
    nonZeroBytes,
    nonZeroAlphaPixels,
    linearHdrMean: linearHdrMean(bytes, width, roi, label),
  };
}

export function objectCoverage(bytes, width, roi, clearColor) {
  let objectPixels = 0;
  const totalPixels = roi.width * roi.height;
  for (let row = roi.y; row < roi.y + roi.height; row += 1) {
    for (let column = roi.x; column < roi.x + roi.width; column += 1) {
      const offset = (row * width + column) * 8;
      const rgb = [
        halfToFloat((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)),
        halfToFloat((bytes[offset + 2] ?? 0) | ((bytes[offset + 3] ?? 0) << 8)),
        halfToFloat((bytes[offset + 4] ?? 0) | ((bytes[offset + 5] ?? 0) << 8)),
      ];
      if (rgb.some((value, index) => Math.abs(value - clearColor[index]) > 0.002)) objectPixels += 1;
    }
  }
  return { kind: 'clear-color-difference', objectPixels, totalPixels, coverage: objectPixels / totalPixels };
}

export function createLinearHdrRoiEvidence(bytes, width, roi, label = 'roi', clearColor) {
  const projected = projectLinearHdrRoi(bytes, width, roi, label);
  return {
    ...projected,
    observed: {
      nonZeroBytes: projected.nonZeroBytes,
      nonZeroAlphaPixels: projected.nonZeroAlphaPixels,
      linearHdrMean: projected.linearHdrMean,
    },
    ...(clearColor === undefined ? {} : { objectMask: objectCoverage(bytes, width, roi, clearColor) }),
  };
}

export function resolveCaseRoi(item, index, plan, projection = { roiWidth: 50, roiHeight: 75 }) {
  return plan?.roi ?? item?.roi ?? {
    x: (index % 4) * projection.roiWidth,
    y: Math.floor(index / 4) * projection.roiHeight,
    width: projection.roiWidth,
    height: projection.roiHeight,
  };
}

export function referenceBytes(plan) {
  return JSON.stringify({
    expectedLinearHdrMean: plan.expectedLinearHdrMean,
    source: plan.referenceSource,
    revision: plan.referenceRevision,
    configHash: plan.referenceConfigHash,
    camera: plan.camera,
    roi: plan.roi,
    metric: plan.metric,
    epsilon: plan.epsilon,
  });
}

export function finiteVector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

export function maxDelta(actual, expected) {
  return Math.max(
    Math.abs(actual[0] - expected[0]),
    Math.abs(actual[1] - expected[1]),
    Math.abs(actual[2] - expected[2]),
  );
}

export function evaluateCaseRecordCore(record, plan, referenceHashValid) {
  if (record === undefined || plan === undefined) {
    return { verdict: 'fail', reason: 'case-reference-missing' };
  }
  if (record.reference?.referenceId !== plan.referenceId) {
    return { verdict: 'fail', reason: 'reference-identity-mismatch' };
  }
  if (record.reference?.metric !== plan.metric || record.reference?.epsilon !== plan.epsilon) {
    return { verdict: 'fail', reason: 'reference-metric-mismatch' };
  }
  if (
    record.reference?.referenceSource !== plan.referenceSource ||
    record.reference?.referenceRevision !== plan.referenceRevision ||
    record.reference?.referenceConfigHash !== plan.referenceConfigHash ||
    record.reference?.referenceHash !== plan.referenceHash
  ) {
    return { verdict: 'fail', reason: 'reference-provenance-mismatch' };
  }
  if (record.readback?.status !== 'ok' || record.readback?.colorSpace !== 'linear-hdr') {
    return { verdict: 'fail', reason: 'linear-hdr-readback-required' };
  }
  if (record.readback?.format !== 'rgba16float') {
    return { verdict: 'fail', reason: 'linear-hdr-format-required' };
  }
  if (record.readback?.frameId === undefined || record.readback?.pipelineId !== 'forgeax::standard' || typeof record.readback?.backendId !== 'string') {
    return { verdict: 'fail', reason: 'observation-identity-missing' };
  }
  if (typeof record.rawHash !== 'string' || record.rawHash.length === 0) {
    return { verdict: 'fail', reason: 'raw-roi-hash-missing' };
  }
  if (!finiteVector(record.observed?.linearHdrMean)) {
    return { verdict: 'fail', reason: 'linear-hdr-observation-missing' };
  }
  const objectMask = record.objectMask;
  if (
    objectMask === undefined ||
    !Number.isFinite(objectMask.coverage) ||
    objectMask.totalPixels <= 0 ||
    objectMask.objectPixels <= 0 ||
    objectMask.coverage <= 0.01
  ) {
    return { verdict: 'fail', reason: 'object-coverage-missing' };
  }
  if (!finiteVector(plan.expectedLinearHdrMean) || typeof plan.referenceSource !== 'string' || typeof plan.referenceRevision !== 'string' || typeof plan.referenceConfigHash !== 'string' || typeof plan.referenceHash !== 'string') {
    return { verdict: 'fail', reason: 'reference-values-missing' };
  }
  if (!referenceHashValid) {
    return { verdict: 'fail', reason: 'reference-artifact-hash-mismatch' };
  }
  const delta = maxDelta(record.observed.linearHdrMean, plan.expectedLinearHdrMean);
  return delta <= plan.epsilon
    ? { verdict: 'pass', reason: 'reference-within-tolerance', delta, epsilon: plan.epsilon }
    : { verdict: 'fail', reason: 'reference-out-of-tolerance', delta, epsilon: plan.epsilon };
}

export function evaluatePairedSentinelsCore(sentinels) {
  const required = ['factor-zero-base-parity', 'default-custom-surface-physical-parity', 'additive-coat-falsifier'];
  const missing = required.filter((name) => sentinels?.[name] === undefined);
  if (missing.length > 0) return { verdict: 'fail', reason: 'sentinel-missing', missing };
  const factorZero = sentinels['factor-zero-base-parity'];
  if (!finiteVector(factorZero.base) || !finiteVector(factorZero.factorZero) || typeof factorZero.epsilon !== 'number') {
    return { verdict: 'fail', reason: 'factor-zero-parity-failed' };
  }
  if (maxDelta(factorZero.base, factorZero.factorZero) > factorZero.epsilon) {
    return { verdict: 'fail', reason: 'factor-zero-parity-failed' };
  }
  const surface = sentinels['default-custom-surface-physical-parity'];
  if (!finiteVector(surface.defaultSurface) || !finiteVector(surface.customSurface) || typeof surface.epsilon !== 'number') {
    return { verdict: 'fail', reason: 'surface-parity-failed' };
  }
  if (maxDelta(surface.defaultSurface, surface.customSurface) > surface.epsilon) {
    return { verdict: 'fail', reason: 'surface-parity-failed' };
  }
  const falsifier = sentinels['additive-coat-falsifier'];
  const additiveEnergyDelta = falsifier.mutatedEnergy - falsifier.baselineEnergy;
  if (
    !Number.isFinite(falsifier.baselineEnergy) ||
    !Number.isFinite(falsifier.mutatedEnergy) ||
    falsifier.metric !== 'linear-rgb-l1' ||
    !Number.isFinite(falsifier.baselineNoise) ||
    !Number.isFinite(falsifier.energyTolerance) ||
    additiveEnergyDelta <= Math.max(falsifier.baselineNoise, falsifier.energyTolerance)
  ) {
    return { verdict: 'fail', reason: 'additive-falsifier-did-not-fail' };
  }
  return {
    verdict: 'pass',
    reason: 'paired-sentinels-valid',
    additiveEnergyDelta,
    additiveEnergyRelativeDelta: additiveEnergyDelta / Math.max(Math.abs(falsifier.baselineEnergy), Number.EPSILON),
  };
}
