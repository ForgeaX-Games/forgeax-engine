import { createHash } from 'node:crypto';
import { ok } from '@forgeax/engine-types';
import { type CompileResult, compileShader } from '../index.js';

/** Pack-owned reuse of exact compiler inputs; never caches material publication or failures. */
export function createMaterialProgramCompiler(): typeof compileShader {
  const programs = new Map<string, { value: CompileResult; bytes: number }>();
  let retainedBytes = 0;
  return async (source, options = {}) => {
    const key = createHash('sha256')
      .update(JSON.stringify([source, options]))
      .digest('hex');
    const previous = programs.get(key);
    if (previous !== undefined) return ok(structuredClone(previous.value));
    const compiled = await compileShader(source, options);
    if (!compiled.ok) return compiled;
    const bytes = Buffer.byteLength(JSON.stringify(compiled.value));
    // Bound both entry overhead and payload. Oversize programs still compile normally.
    const budget = 16 * 1024 * 1024;
    if (bytes <= budget) {
      while (programs.size >= 64 || retainedBytes + bytes > budget) {
        const oldest = programs.entries().next().value;
        if (oldest === undefined) break;
        programs.delete(oldest[0]);
        retainedBytes -= oldest[1].bytes;
      }
      // A concurrent caller may have populated the same input while this one compiled.
      retainedBytes -= programs.get(key)?.bytes ?? 0;
      programs.set(key, { value: structuredClone(compiled.value), bytes });
      retainedBytes += bytes;
    }
    return compiled;
  };
}
