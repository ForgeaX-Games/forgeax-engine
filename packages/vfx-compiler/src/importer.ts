import {
  IMPORT_ERROR_HINTS,
  type ImportContext,
  type ImportDiagnostic,
  ImportError,
  type Importer,
  type ImportResult,
  type ParticleEffectAsset,
} from '@forgeax/engine-types';
import type { ParticleEffectSource } from '@forgeax/engine-vfx';
import { PARTICLE_PROGRAM_ARTIFACT_KEY } from './canonicalize.js';
import { cookParticleEffect, type ParticleCookError } from './cook.js';
import type { ParticleOperatorRegistry } from './operator-registry.js';

const PARTICLE_EFFECT_IMPORTER_KEY = 'particle-effect';

function diagnostic(
  sourcePath: string,
  error: {
    readonly code: string;
    readonly expected: string;
    readonly hint: string;
    readonly detail: unknown;
  },
): ImportDiagnostic {
  return {
    code: error.code,
    severity: 'error',
    sourcePath,
    sourceRange: { start: 0, end: 0, line: 1, column: 1 },
    rule: 'particle-effect-source',
    expected: error.expected,
    actual: JSON.stringify(error.detail),
    hint: error.hint,
  };
}

function validationFailure(
  sourcePath: string,
  error: {
    readonly code: string;
    readonly expected: string;
    readonly hint: string;
    readonly detail: unknown;
  },
): ImportError {
  return new ImportError({
    code: 'source-validation-failed',
    expected: error.expected,
    hint: error.hint,
    detail: { diagnostics: [diagnostic(sourcePath, error)] },
  });
}

function parseFailure(sourcePath: string, error: unknown): ImportError {
  const reason = error instanceof Error ? error.message : String(error);
  return new ImportError({
    code: 'source-validation-failed',
    expected: 'source bytes to contain valid ParticleEffectSource JSON',
    hint: 'repair the source JSON and validate it against the ParticleEffectSource schema',
    detail: {
      diagnostics: [
        {
          code: 'vfx-source-json-invalid',
          severity: 'error',
          sourcePath,
          sourceRange: { start: 0, end: 0, line: 1, column: 1 },
          rule: 'particle-effect-source-json',
          expected: 'valid JSON',
          actual: reason,
          hint: 'repair the source JSON and retry the import',
        },
      ],
    },
  });
}

function sourceReadFailure(ctx: ImportContext, error: unknown): ImportError {
  return new ImportError({
    code: 'source-read-failed',
    expected: `readable source file "${ctx.source}"`,
    hint: IMPORT_ERROR_HINTS['source-read-failed'],
    detail: {
      source: ctx.source,
      reason: error instanceof Error ? error.message : String(error),
    },
  });
}

function cookFailure(ctx: ImportContext, error: ParticleCookError): ImportError {
  return validationFailure(ctx.source, error);
}

function parseSource(ctx: ImportContext, bytes: Uint8Array): ParticleEffectSource | ImportError {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as ParticleEffectSource;
  } catch (error) {
    return parseFailure(ctx.source, error);
  }
}

function isParticleEffectDeclaration(ctx: ImportContext): boolean {
  return ctx.subAssets.some((subAsset) => subAsset.kind === PARTICLE_EFFECT_IMPORTER_KEY);
}

function createProduct(
  ctx: ImportContext,
  source: ParticleEffectSource,
  registry: ParticleOperatorRegistry,
): ImportResult<ParticleEffectAsset> {
  const cooked = cookParticleEffect(source, registry);
  if (!cooked.ok) return { ok: false, error: cookFailure(ctx, cooked.error) };

  const declaration = ctx.subAssets.find(
    (subAsset) => subAsset.kind === PARTICLE_EFFECT_IMPORTER_KEY,
  );
  if (declaration === undefined) {
    return { ok: true, value: { assets: [], sourceDependencies: [] } };
  }

  return {
    ok: true,
    value: {
      assets: [
        {
          guid: declaration.guid,
          kind: PARTICLE_EFFECT_IMPORTER_KEY,
          payload: cooked.value.asset,
          refs: cooked.value.refs,
          artifacts: {
            [PARTICLE_PROGRAM_ARTIFACT_KEY]: {
              mediaType: cooked.value.program.mimeType,
              bytes: cooked.value.program.bytes,
            },
          },
        },
      ],
      sourceDependencies: [],
    },
  };
}

/** Build-time importer for ParticleEffectSource sidecars. */
export function particleEffectImporter(registry: ParticleOperatorRegistry): Importer {
  return {
    key: PARTICLE_EFFECT_IMPORTER_KEY,
    async import(ctx): Promise<ImportResult<ParticleEffectAsset>> {
      if (!isParticleEffectDeclaration(ctx)) {
        return { ok: true, value: { assets: [], sourceDependencies: [] } };
      }

      const read = await ctx.readSource();
      if (!read.ok) return { ok: false, error: sourceReadFailure(ctx, read.error) };

      const parsed = parseSource(ctx, read.value);
      if (parsed instanceof ImportError) return { ok: false, error: parsed };
      return createProduct(ctx, parsed, registry);
    },
  };
}

export { PARTICLE_EFFECT_IMPORTER_KEY };
