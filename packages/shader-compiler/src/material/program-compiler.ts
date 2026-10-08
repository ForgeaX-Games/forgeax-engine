import { createHash } from 'node:crypto';
import { composeShader } from '@forgeax/engine-naga';
import { ok } from '@forgeax/engine-types';
import {
  type CompileResult,
  type compileShader,
  compileShaderProgram,
  compileShaderWithComposition,
} from '../compile.js';

type CachedProgram =
  | { readonly kind: 'composition'; readonly value: Promise<string>; readonly bytes: number }
  | { readonly kind: 'result'; readonly value: CompileResult; readonly bytes: number };

// Keep the source closure's selectors and the compiler-owned color projection.
// Malformed unused selectors still reach the real compiler's rejection path.
function referencedDefines(
  source: string,
  imports: Readonly<Record<string, string>>,
  defines: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const sources = [source, ...Object.values(imports)];
  return Object.fromEntries(
    Object.entries(defines).filter(
      ([name, value]) =>
        typeof value !== 'boolean' ||
        name === 'VERTEX_COLOR_AVAILABLE' ||
        sources.some((text) => text.includes(name)),
    ),
  );
}

// WGSL strings are immutable; copy only the independently mutable facts.
function copyResult(result: CompileResult): CompileResult {
  const copy = structuredClone({
    ...result,
    wgsl: '',
    manifestEntry: { ...result.manifestEntry, wgsl: '' },
  });
  return {
    ...copy,
    wgsl: result.wgsl,
    manifestEntry: { ...copy.manifestEntry, wgsl: result.manifestEntry.wgsl },
  };
}

/** Scoped reuse, bounded jointly across composition and exact validated results. */
export function createMaterialProgramCompiler(): typeof compileShader {
  const programs = new Map<string, CachedProgram>();
  let retainedBytes = 0;
  const retain = (key: string, entry: CachedProgram) => {
    // Bound both entry overhead and payload across both compilation stages.
    const budget = 16 * 1024 * 1024;
    retainedBytes -= programs.get(key)?.bytes ?? 0;
    programs.delete(key);
    if (entry.bytes > budget) return;
    while (programs.size >= 128 || retainedBytes + entry.bytes > budget) {
      // Exact results are cheaper to rebuild than their shared composition.
      const oldest =
        [...programs].find(([, candidate]) => candidate.kind === 'result') ??
        programs.entries().next().value;
      if (oldest === undefined) break;
      programs.delete(oldest[0]);
      retainedBytes -= oldest[1].bytes;
    }
    programs.set(key, entry);
    retainedBytes += entry.bytes;
  };
  const compose: typeof composeShader = async (source, imports = {}, defines = {}) => {
    // Preserve the Wasm boundary's boolean check for untyped JavaScript callers.
    if (Object.values(defines).some((value) => typeof value !== 'boolean'))
      return composeShader(source, imports, defines);
    // Absent names cannot affect composition. Literal matching conservatively keeps
    // names occurring in comments or longer identifiers; prepared branches stay in the key.
    const relevantDefines = referencedDefines(source, imports, defines);
    const input = JSON.stringify([source, imports, relevantDefines]);
    const key = `composition:${createHash('sha256').update(input).digest('hex')}`;
    const previous = programs.get(key);
    if (previous?.kind === 'composition') return previous.value;
    // Admit the in-flight work before awaiting it. Pending source bytes share
    // the existing entry/payload budget; success accounts for the resulting WGSL.
    const entry: CachedProgram = {
      kind: 'composition',
      value: composeShader(source, imports, defines),
      bytes: Buffer.byteLength(input),
    };
    retain(key, entry);
    try {
      const wgsl = await entry.value;
      // An evicted pending input must not re-enter the cache on completion.
      if (programs.get(key) === entry) retain(key, { ...entry, bytes: Buffer.byteLength(wgsl) });
      return wgsl;
    } catch (error) {
      if (programs.get(key) === entry) {
        programs.delete(key);
        retainedBytes -= entry.bytes;
      }
      throw error;
    }
  };
  const compileProgram: typeof compileShaderProgram = async (wgsl, options, locateSyntaxError) => {
    const key = `result:${createHash('sha256')
      .update(JSON.stringify([wgsl, options.renderEntries, options.dynamicOffsets ?? []]))
      .digest('hex')}`;
    const previous = programs.get(key);
    if (previous?.kind === 'result') return ok(copyResult(previous.value));
    // Entry, attachment format and dynamic-offset changes still validate fresh IR.
    const compiled = await compileShaderProgram(wgsl, options, locateSyntaxError);
    if (compiled.ok) {
      const value = copyResult(compiled.value);
      retain(key, {
        kind: 'result',
        value,
        bytes: Buffer.byteLength(
          JSON.stringify({
            ...value,
            manifestEntry: { ...value.manifestEntry, wgsl: '' },
          }),
        ),
      });
    }
    return compiled;
  };
  return (source, options = {}) =>
    compileShaderWithComposition(source, options, compose, compileProgram);
}
