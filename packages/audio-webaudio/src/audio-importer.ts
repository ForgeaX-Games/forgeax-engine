// audio-importer.ts - the build-time audioImporter (feat-20260603-asset-import-loader-injection M3 / w25).
//
// The `{ key: 'audio', import }` Importer the @forgeax/engine-import runner
// dispatches a `*.meta.json` with `importer: 'audio'` to.
//
// SEMANTIC HETEROGENEITY (plan-strategy D-3 / requirements AC-18 callout):
// audio is NOT like image / gltf. There is no JS decoder to strip out of the
// runtime bundle -- the runtime decodes audio with the native Web Audio
// `AudioContext.decodeAudioData` (clip-loader.ts), and the browser owns codec
// selection (wav / mp3 / ogg / flac). So this importer is NOT a bundle
// optimization: AC-16's bundle-delta evidence is image-only and does NOT
// apply to audio. The audioImporter's value is the UNIFIED IMPORT ENTRY -- it
// lets an audio source flow through the same declare -> import -> load
// pipeline (meta.importer='audio') as every other asset family, so an AI user
// reads one consistent import surface instead of an audio special case.
//
// The importer body MUST NOT call `AudioContext` / `decodeAudioData`: decode is
// the runtime loader's job (clip-loader.ts, which fetches the source URL and
// decodes in the browser). A decoded `AudioClipAsset` carries an `AudioBuffer`,
// a runtime-only Web Audio object that cannot be produced at build time. The
// importer therefore emits a thin pass-through descriptor (`kind: 'audio'` +
// the source path) under the meta-declared GUID; the runtime resolves it to a
// decoded clip at load time.
//
// GUID import-stable iron law: every produced GUID comes from `ctx.subAssets[]`.

import type { ImportContext, ImportedAsset, Importer, ImportResult } from '@forgeax/engine-types';

/** Audio output identity is semantic and independent of source path/index. */
export function sourceKeyForAudioOutput(kind = 'audio'): string | undefined {
  const normalizedKind = kind.trim();
  return normalizedKind.length === 0 ? undefined : `audio:${normalizedKind}`;
}

function audioMediaType(source: string): string {
  const lower = source.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.flac')) return 'audio/flac';
  return 'application/octet-stream';
}
async function importAudio(ctx: ImportContext): Promise<ImportResult> {
  // Probe the source is readable so a missing file fails the build (the runner
  // already probes, but this keeps the importer self-validating, P3). No decode
  // happens here -- decodeAudioData is the runtime loader's job.
  const read = await ctx.readSource();
  if (!read.ok) {
    throw new Error(
      `audioImporter: readSource failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`,
    );
  }

  const out: ImportedAsset[] = [];
  for (const sub of ctx.subAssets) {
    if (sub.kind !== 'audio') continue;
    // Thin pass-through descriptor: the runtime audio loader fetches the source
    // URL and decodes via the browser, so the build-time payload carries only
    // the source reference (no AudioBuffer; cast through the Asset slot like the
    // other importers' build-time POD-vs-runtime-handle bridges).
    const payload = { kind: 'audio', source: ctx.source } as unknown as ImportedAsset['payload'];
    out.push({
      guid: sub.guid,
      kind: 'audio',
      payload,
      refs: [],
      artifacts: {
        source: {
          mediaType: audioMediaType(ctx.source),
          assetCodec: { name: 'browser-audio' },
          bytes: read.value,
        },
      },
    });
  }
  return { ok: true, value: { assets: out, sourceDependencies: [ctx.source] } };
}

/**
 * The audio {@link Importer}. Register it into an `ImporterRegistry` so the
 * import runner dispatches `meta.importer === 'audio'` sidecars here.
 *
 * @example
 * ```ts
 * import { ImporterRegistry } from '@forgeax/engine-import';
 * import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
 * const importers = new ImporterRegistry();
 * importers.register(audioImporter);
 * ```
 */
export const audioImporter: Importer = {
  key: 'audio',
  import: importAudio,
};
