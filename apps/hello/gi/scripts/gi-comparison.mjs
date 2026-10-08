// Reference-owned coverage keeps a missing GI pixel in every lane's denominator.
// Accumulation layout is the path tracer's 80-byte POD record, not image brightness.
export function referenceCoverage(accumulation, pixels) {
  if (accumulation.length !== pixels * 20) throw new Error('invalid reference record count');
  const words = new Uint32Array(
    accumulation.buffer, accumulation.byteOffset, accumulation.length,
  );
  return Uint8Array.from({ length: pixels }, (_, pixel) => {
    const row = pixel * 20;
    if (words[row + 3] === 0 || words[row + 7] !== 0)
      throw new Error(`invalid reference sample at pixel ${pixel}`);
    return words[row + 16] === 0xffffffff ? 0 : 1;
  });
}

// Temporal edits change the viewing camera. Use its same-frame raster rows,
// including black surfaces, rather than the converged image's brightness.
export function rasterCoverage(observation, width, height) {
  const { metadata, bytes, records } = observation ?? {};
  if (observation?.domain !== 'visible-surface' || metadata?.format !== 'rgba32uint' ||
      metadata.width !== width || metadata.height !== height ||
      metadata.bytesPerRow < width * 16 || bytes?.byteLength < metadata.bytesPerRow * height || bytes === undefined ||
      !(records instanceof Uint32Array) || records.length % 16 !== 0)
    throw new Error('invalid raster coverage observation');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint8Array.from({ length: width * height }, (_, pixel) => {
    const address = view.getUint32(Math.floor(pixel / width) * metadata.bytesPerRow + (pixel % width) * 16, true);
    if (address > records.length / 16) throw new Error(`invalid raster row at pixel ${pixel}`);
    return address === 0 ? 0 : 1;
  });
}

// Duplicate selectors previously produced a mislabeled "exact" control.
export function optionReader(args) {
  const seen = new Set();
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    if (seen.has(arg)) throw new Error(`duplicate option ${arg}`);
    seen.add(arg);
  }
  return (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`missing value for --${name}`);
    return value;
  };
}

// Replay timestamps may be null (missing/inverted native counters). Keep those
// passes visible; a sum of measured passes is neither complete nor frame latency.
export function replayTimingSummary(passes, works) {
  const kinds = new Map(works.map((work) => [work.workIndex, work.kind]));
  const groups = new Map();
  for (const pass of passes) {
    const stage = (pass.label ?? `<${pass.kind}>`)
      .replace(/\.\d+\./g, '.')
      .replace(/-\d+(-bounce-\d+)?$/g, '')
      .replace(/material-\d+/g, 'material-*');
    const group = groups.get(stage) ?? {
      stage, passes: 0, measuredPasses: 0, dispatches: 0, draws: 0, measuredPassSumMs: 0,
    };
    group.passes++;
    for (const index of pass.workIndices) {
      const kind = kinds.get(index) ?? '';
      if (kind.startsWith('dispatch')) group.dispatches++;
      else if (kind.startsWith('draw')) group.draws++;
    }
    if (Number.isFinite(pass.gpuNanoseconds) && pass.gpuNanoseconds >= 0) {
      group.measuredPasses++;
      group.measuredPassSumMs += pass.gpuNanoseconds / 1e6;
    }
    groups.set(stage, group);
  }
  const stages = [...groups.values()].sort((a, b) => b.measuredPassSumMs - a.measuredPassSumMs);
  const measuredPasses = stages.reduce((sum, stage) => sum + stage.measuredPasses, 0);
  return {
    status: measuredPasses === passes.length && passes.length > 0 ? 'complete' : 'partial',
    passes: passes.length, measuredPasses,
    measuredPassSumMs: stages.reduce((sum, stage) => sum + stage.measuredPassSumMs, 0),
    semantics: 'sum of measured replay pass durations; not exclusive cost or frame latency',
    rawPasses: passes, stages,
  };
}
