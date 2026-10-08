/** Omit only shader bytes whose verified external transport is already published. */
export function projectMaterialPackTransport(pack: unknown): unknown {
  if (pack === null || typeof pack !== 'object') return pack;
  const document = pack as Record<string, unknown>;
  if (!Array.isArray(document.assets)) return pack;
  return {
    ...document,
    assets: document.assets.map((raw: unknown) => {
      if (raw === null || typeof raw !== 'object') return raw;
      const asset = raw as Record<string, unknown>;
      if (asset.kind !== 'material' || asset.payload === null || typeof asset.payload !== 'object')
        return raw;
      const payload = asset.payload as Record<string, unknown>;
      const field =
        payload.schemaVersion === 'material-cook/4'
          ? undefined
          : payload.cooked !== undefined
            ? 'cooked'
            : 'record';
      const record = field === undefined ? payload : payload[field];
      if (record === null || typeof record !== 'object') return raw;
      const cooked = record as Record<string, unknown>;
      if (cooked.schemaVersion !== 'material-cook/4' || !Array.isArray(cooked.programs)) return raw;
      const descriptors = asset.artifacts as Record<string, unknown> | undefined;
      const projected = {
        ...cooked,
        programs: cooked.programs.map((rawProgram: unknown) => {
          if (rawProgram === null || typeof rawProgram !== 'object') return rawProgram;
          const program = rawProgram as Record<string, unknown>;
          if (program.artifact === null || typeof program.artifact !== 'object') return rawProgram;
          const artifact = program.artifact as Record<string, unknown>;
          if (typeof artifact.path !== 'string' || descriptors?.[artifact.path] === undefined)
            return rawProgram;
          const { bytes: _bytes, ...externalArtifact } = artifact;
          return { ...program, artifact: externalArtifact };
        }),
      };
      return {
        ...asset,
        payload: field === undefined ? projected : { ...payload, [field]: projected },
      };
    }),
  };
}
