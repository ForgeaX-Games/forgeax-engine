export type PipelineGroup2Contract = 'mesh' | 'skin' | 'cluster' | 'skin-cluster';

/** Immutable facts about one composed source, shared across material passes and GPU devices. */
export interface MaterialShaderProgram {
  readonly source: string;
  readonly identity: string;
  readonly group2: PipelineGroup2Contract;
  readonly probeBlendRecordRequired: boolean;
}

export function createMaterialShaderProgram(source: string): MaterialShaderProgram {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
  const bindings = [
    ...withoutComments.matchAll(/@group\s*\(\s*2\s*\)\s*@binding\s*\(\s*(\d+)\s*\)/gu),
  ].map((match) => Number(match[1]));
  const skin = bindings.includes(1) || bindings.includes(2);
  const cluster = bindings.some((binding) => binding >= 3);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Object.freeze({
    source,
    identity: `${source.length}:${hash >>> 0}`,
    group2: skin ? (cluster ? 'skin-cluster' : 'skin') : cluster ? 'cluster' : 'mesh',
    probeBlendRecordRequired:
      /@group\s*\(\s*3\s*\)\s*@binding\s*\(\s*1\s*\)\s*var\s*<\s*storage\s*(?:,\s*read\s*)?>\s*\w+\s*:\s*array\s*<\s*vec4\s*<\s*f32\s*>\s*>/u.test(
        withoutComments,
      ),
  });
}
