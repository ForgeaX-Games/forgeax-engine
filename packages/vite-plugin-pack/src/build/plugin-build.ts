import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ImporterRegistry, ImportRunnerFs, RunImportMeta } from '@forgeax/engine-import';
import { loadAssetConfig } from '@forgeax/engine-pack/config';
import { resolveAssetSource } from '@forgeax/engine-pack/resolve';
import type { PackIndexEntry } from '@forgeax/engine-types';
import { buildCatalogProjection } from '../build-catalog.js';
import { compressArtifact } from '../compress-artifact.js';
import { readDdcMetrics } from '../ddc-cache.js';
import { buildGuidToMetaMap } from '../dev/watcher.js';
import { productAssetsByGuid, projectUiBuildArtifacts } from '../import-products.js';
import { importTextureEntry } from '../import-texture.js';
import type { PluginPackOptions } from '../index.js';
import { finalizePackage, type LogicalPackage } from '../package-finalizer.js';
import { produceSourcePackage } from '../producer/source-package.js';
import {
  loadSharedPackInput,
  projectPackIndexUrl,
  projectSharedPackCatalog,
  resolvePackBuildInputs,
} from '../shared-build-inputs.js';
import { dedupeFinalizedUiEntries, finalizeUiArtifact } from '../ui-pack-finalizer.js';
import { projectAssetProduction } from './asset-production.js';

export interface MinimalPluginContext {
  emitFile(asset: {
    type: 'asset';
    fileName?: string;
    name?: string;
    originalFileName?: string;
    source: string | Uint8Array;
  }): string;
  getFileName(referenceId: string): string;
}

interface PluginBuildCallbacks {
  upgradeLegacyAuthoredPack(pack: AuthoredPackInput): AuthoredPackInput;
  readCookedAuthoredPack(sourcePath: string): Promise<
    | {
        readonly logicalPackage: LogicalPackage;
        readonly refsByGuid: ReadonlyMap<string, readonly string[]>;
      }
    | undefined
  >;
}

interface AuthoredPackAssetInput {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly execution?: 'direct' | 'cooked';
  readonly payload: Record<string, unknown>;
  readonly refs?: readonly string[];
  readonly artifacts?: Readonly<Record<string, unknown>>;
}

interface AuthoredPackInput {
  readonly schemaVersion?: string;
  readonly assets?: readonly AuthoredPackAssetInput[];
}

interface PluginBuildContext {
  readonly opts: PluginPackOptions;
  readonly registeredImporterKeys: ReadonlySet<string>;
  readonly importerRegistry: ImporterRegistry;
  readonly fsForImport: ImportRunnerFs;
  readonly callbacks: PluginBuildCallbacks;
  readonly cookedCurrentProjection: Record<string, unknown>;
  readonly directCurrentProjection: Record<string, unknown>;
  readonly authoredCookedCurrentProjection: Record<string, unknown>;
}

function readCompressionOverride(importSettings: unknown): 'none' | 'zstd' | undefined {
  if (importSettings === null || typeof importSettings !== 'object') return undefined;
  const compression = (importSettings as { compression?: unknown }).compression;
  return compression === 'none' || compression === 'zstd' ? compression : undefined;
}

async function readOverrideFromMeta(
  metaPath: string | undefined,
): Promise<'none' | 'zstd' | undefined> {
  if (metaPath === undefined) return undefined;
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as { importSettings?: unknown };
    return readCompressionOverride(meta.importSettings);
  } catch {
    return undefined;
  }
}

function isProceduralAliasMeta(meta: unknown): boolean {
  if (meta === null || typeof meta !== 'object') return false;
  const candidate = meta as { importer?: unknown; importSettings?: unknown };
  if (candidate.importer !== 'gltf') return false;
  if (candidate.importSettings === null || typeof candidate.importSettings !== 'object') {
    return false;
  }
  return (candidate.importSettings as { geometry?: unknown }).geometry === 'procedural';
}

export function createPluginBuild(context: PluginBuildContext) {
  const {
    opts,
    registeredImporterKeys,
    importerRegistry,
    fsForImport,
    callbacks,
    cookedCurrentProjection: COOKED_CURRENT_PROJECTION,
    directCurrentProjection: DIRECT_CURRENT_PROJECTION,
    authoredCookedCurrentProjection: AUTHORED_COOKED_CURRENT_PROJECTION,
  } = context;
  let buildArtifactStage: { readonly root: string; readonly files: Set<string> } | undefined;
  const scanOptions = opts.ignorePath === undefined ? {} : { ignorePath: opts.ignorePath };

  async function stageBuildArtifact(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
    if (
      normalized.length === 0 ||
      normalized.split('/').some((part) => part === '..' || part.length === 0)
    ) {
      throw new Error(`build artifact path must stay output-relative: ${path}`);
    }
    if (buildArtifactStage === undefined) {
      await mkdir(resolve(process.cwd(), 'node_modules/.cache'), { recursive: true });
      const root = await mkdtemp(resolve(process.cwd(), 'node_modules/.cache/forgeax-pack-'));
      buildArtifactStage = { root, files: new Set() };
    }
    const destination = resolve(buildArtifactStage.root, normalized);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    buildArtifactStage.files.add(normalized);
  }

  async function generateBundle(this: MinimalPluginContext): Promise<void> {
    const cwd = process.cwd();
    const { roots, basePrefix } = resolvePackBuildInputs(opts);
    const sharedManifest = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    if (sharedManifest !== undefined) {
      const shared = loadSharedPackInput(sharedManifest);
      if (
        shared.catalog !== undefined &&
        process.env.FORGEAX_SHARED_APP_INPUTS_MODE !== 'catalog-only'
      ) {
        if (shared.payloadRoot === undefined) {
          throw new Error(`shared pack manifest lacks payload for full mode: ${sharedManifest}`);
        }
        const emitted = new Set<string>();
        for (const entry of shared.catalog) {
          const outputPath = entry.packageUrl.replace(/^\/+/, '');
          if (emitted.has(outputPath)) continue;
          emitted.add(outputPath);
          this.emitFile({
            type: 'asset',
            fileName: outputPath,
            source: readFileSync(resolve(shared.payloadRoot, outputPath)),
          });
        }
      }
      if (shared.catalog !== undefined) {
        this.emitFile({
          type: 'asset',
          fileName: 'pack-index.json',
          source: JSON.stringify(projectSharedPackCatalog(shared.catalog, opts.base)),
        });
        return;
      }
      // A shader-only shared producer deliberately has no asset capability.
      // Fall through to the app's own roots so pack remains the sole owner of
      // its catalog, URL projection, and deployment payload.
    }
    const { paths } = loadAssetConfig(cwd);
    const projection = await buildCatalogProjection(
      roots,
      opts.base,
      registeredImporterKeys,
      scanOptions,
    );
    if (projection.authority !== 'authoritative') {
      throw new Error(
        JSON.stringify({
          code: 'catalog-degraded',
          authority: projection.authority,
          diagnostics: projection.diagnostics,
        }),
      );
    }
    const entries = [...projection.entries];

    if (process.env.FORGEAX_SHARED_APP_INPUTS_MODE === 'catalog-only') {
      // Catalog probes validate metadata and browser/HMR wiring; the producer job owns full payload import.
      const catalog = projectSharedPackCatalog(entries, opts.base).map((entry) =>
        entry.packageUrl.startsWith('/assets/')
          ? entry
          : {
              ...entry,
              packageUrl: projectPackIndexUrl(basePrefix, `assets/${entry.guid.toLowerCase()}.bin`),
            },
      );
      this.emitFile({
        type: 'asset',
        fileName: 'pack-index.json',
        source: JSON.stringify(catalog),
      });
      return;
    }

    // Import step (M3 / w28, AC-21): the image import no longer inlines
    // `parseImage` here. It routes through the build-time `imageImporter`
    // (@forgeax/engine-image) -- the same Importer the @forgeax/engine-import
    // runner dispatches `meta.importer === 'image'` to (D-9: the image import
    // SSOT lives in engine-image). For each `kind: 'texture'` row we build a
    // one-subAsset `ImportContext` and call `imageImporter.import(ctx)`; the
    // returned `TextureAsset` payload carries the imported RGBA bytes (`data`)
    // plus `width` / `height`, which we extract into a hashed `.bin`
    // (D-1: untouched bytes; D-2: `name: '<guid-lowercase>'` + Rollup default
    // `assetFileNames` => `assets/<guid>-<hash>.bin`). The returned
    // `referenceId` bridges the GUID namespace to Rollup's hash namespace;
    // `getFileName(refId)` resolves the final hashed filename after emit.
    //
    // Pack-index entries are mutated in place (`packageUrl` -> hashed `.bin`;
    // `metadata.width / height` from the imported image). Non-image rows
    // (`mesh` / `scene` / `material`) flow through untouched. .hdr rows
    // (D-2: .hdr extension -> imageImporter HDR arm) are imported here;
    // other unknown extensions (no standard mime / no .hdr discriminant)
    // are passed through with the raw packageUrl so the catalog is not
    // silently dropped.
    // AC-01: guid -> meta path so the texture arm can honor an explicit
    // importSettings.compression override (built once, reused by the mesh arm
    // below as allGuidToMeta).
    const guidToMetaBuild = await buildGuidToMetaMap(roots, scanOptions);
    const authoredPackUrls = new Map<string, string>();
    const authoredPackUrlsBySource = new Map<string, string>();
    const authoredCookedRefs = new Map<string, ReadonlyMap<string, readonly string[]>>();
    for (const entry of entries) {
      if (
        !entry.packageUrl.endsWith('.pack.json') ||
        entry.packageUrl.includes('/__forgeax-ddc/') ||
        authoredPackUrls.has(entry.packageUrl)
      ) {
        continue;
      }
      const sourcePath = resolve(cwd, entry.sourcePath);
      const source = readFileSync(sourcePath, 'utf-8');
      const parsed = callbacks.upgradeLegacyAuthoredPack(JSON.parse(source) as AuthoredPackInput);
      if (parsed.schemaVersion !== '2.0.0') continue;
      const cooked = await callbacks.readCookedAuthoredPack(sourcePath);
      if (cooked !== undefined) {
        const firstGuid = entry.guid.toLowerCase();
        const finalized = await finalizePackage(
          cooked.logicalPackage,
          { write: () => {} },
          {
            base: basePrefix === '' ? '/' : basePrefix,
            packagePath: `assets/${firstGuid}.pack.json`,
            artifactPath: (guid, key) => `${guid}/${key}.bin`,
          },
        );
        for (const artifact of finalized.artifacts) {
          await stageBuildArtifact(`assets/${artifact.path}`, artifact.bytes);
        }
        const packRef = this.emitFile({
          type: 'asset',
          name: `${firstGuid}.pack.json`,
          originalFileName: sourcePath,
          source: JSON.stringify(finalized.pack),
        });
        const packUrl = projectPackIndexUrl(basePrefix, this.getFileName(packRef));
        authoredPackUrls.set(entry.packageUrl, packUrl);
        authoredPackUrlsBySource.set(entry.sourcePath, packUrl);
        authoredCookedRefs.set(entry.packageUrl, cooked.refsByGuid);
        continue;
      }
      const packRef = this.emitFile({
        type: 'asset',
        name: `${entry.guid.toLowerCase()}.pack.json`,
        originalFileName: sourcePath,
        source: JSON.stringify(parsed),
      });
      const packUrl = projectPackIndexUrl(basePrefix, this.getFileName(packRef));
      authoredPackUrls.set(entry.packageUrl, packUrl);
      authoredPackUrlsBySource.set(entry.sourcePath, packUrl);
    }
    const importedEntries: PackIndexEntry[] = [];
    for (const entry of entries) {
      const metaPath = guidToMetaBuild.get(entry.guid.toLowerCase());
      if (metaPath !== undefined) {
        let metaRaw: unknown;
        try {
          metaRaw = JSON.parse(readFileSync(metaPath, 'utf-8'));
        } catch {
          metaRaw = undefined;
        }
        if (isProceduralAliasMeta(metaRaw)) {
          // A procedural alias has no source payload to cook: the runtime
          // resolves its GUID onto a process-static builtin mesh. Keeping the
          // source-meta row in a production pack-index would advertise a
          // package URL that cannot be emitted or fetched, while routing it
          // through gltfImporter would reject the intentional `.stub` source.
          continue;
        }
      }
      // gap-3 (w5): the pure import logic now lives in the shared
      // `importTextureEntry` SSOT (import-texture.ts), used by both this build
      // arm and the dev POST /__import path (D-1). The shared fn returns
      // `{ skipped }` for any row that is not an importable image / .hdr
      // (non-texture kind, missing metadata, unknown extension, importer
      // throw, or absent produced asset) -- pass those through unchanged.
      const imported = await importTextureEntry(entry, {
        cwd,
        metaPath: guidToMetaBuild.get(entry.guid.toLowerCase()),
      });
      if ('skipped' in imported) {
        // Surface real import failures as a warning; silent pass-through for
        // benign non-importable rows (non-texture / unknown extension). The
        // benign-vs-real classification is the shared fn's `real` flag (one
        // SSOT), no longer a `skipped` string-prefix match here.
        if (imported.real) {
          console.warn(`[forgeax-pack] ${imported.skipped}`);
        }
        const packageUrl = authoredPackUrls.get(entry.packageUrl);
        const cookedRefs = authoredCookedRefs.get(entry.packageUrl)?.get(entry.guid.toLowerCase());
        importedEntries.push(
          packageUrl === undefined
            ? entry
            : {
                ...entry,
                packageUrl,
                ...(entry.sourcePath.endsWith('.pack.json')
                  ? authoredCookedRefs.has(entry.packageUrl)
                    ? AUTHORED_COOKED_CURRENT_PROJECTION
                    : DIRECT_CURRENT_PROJECTION
                  : COOKED_CURRENT_PROJECTION),
                ...(cookedRefs === undefined ? {} : { refs: cookedRefs }),
              },
        );
        continue;
      }
      // emitFile name '<guid-lowercase>' (D-2) + originalFileName for
      // Rollup's automatic addWatchFile hook (research F1). The imported bytes
      // (rgba8 / rgba16float) come from the shared import fn; the packageUrl
      // rewrite (emitFile + getFileName) stays here, the build arm owning it.
      // (B) Texture arm build: compress after importTextureEntry, before emitFile (D-3).
      // AC-01: honor an explicit importSettings.compression override from the meta.
      const texBuildOverride = await readOverrideFromMeta(
        guidToMetaBuild.get(entry.guid.toLowerCase()),
      );
      const compressedTex = await compressArtifact({
        bytes: imported.bytes,
        kind: 'texture',
        isPackJson: false,
        ...(texBuildOverride !== undefined ? { override: texBuildOverride } : {}),
        // Carry the importer's resolved delivery encoding so a Basis KTX2 row
        // records its basis-* discriminant (loader transcode dispatch) instead
        // of the STRATEGY_TABLE 'none' default (which fell through to a scheme=1
        // KTX2 reject). Build path SSOT with the dev arm.
        ...(imported.metadata.compression !== undefined
          ? { alreadyCompressed: imported.metadata.compression }
          : {}),
      });
      const texturePackagePath = `assets/${entry.guid.toLowerCase()}.pack.json`;
      const artifactCodec =
        compressedTex.compression === 'basis-etc1s'
          ? { name: 'basis', profile: 'etc1s' }
          : compressedTex.compression === 'basis-uastc'
            ? { name: 'basis', profile: 'uastc-ldr' }
            : compressedTex.compression === 'basis-uastc-hdr'
              ? { name: 'basis', profile: 'uastc-hdr' }
              : undefined;
      const texturePackage = await finalizePackage(
        {
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid: entry.guid,
              kind: entry.kind,
              payload: {
                kind: entry.kind,
                width: imported.metadata.width ?? 0,
                height: imported.metadata.height ?? 0,
                format: imported.metadata.format,
                colorSpace: imported.metadata.colorSpace,
                mipmap: imported.metadata.mipmap,
              },
              refs: [],
              artifacts: {
                body: {
                  mediaType: 'application/octet-stream',
                  ...(artifactCodec === undefined ? {} : { assetCodec: artifactCodec }),
                  bytes: compressedTex.compressed,
                },
              },
            },
          ],
        },
        { write: () => {} },
        {
          base: basePrefix === '' ? '/' : basePrefix,
          packagePath: texturePackagePath,
          artifactPath: (guid) => `${guid.toLowerCase()}/body.bin`,
        },
      );
      for (const artifact of texturePackage.artifacts) {
        await stageBuildArtifact(`assets/${artifact.path}`, artifact.bytes);
      }
      this.emitFile({
        type: 'asset',
        fileName: texturePackagePath,
        originalFileName: resolve(cwd, entry.sourcePath),
        source: JSON.stringify(texturePackage.pack),
      });
      const texturePackageUrl = texturePackage.packageUrl;
      importedEntries.push({
        // Keep the catalog's producer-owned identity/projection facts when the
        // package URL moves from authored source to the shipped DDC package.
        // Rebuilding this row from only four fields made production builds
        // lose `name`, `sourcePath`, and imported-output lifecycle evidence;
        // runtime then fell back to the generated GUID pack filename even
        // though the authored source was still `sky.hdr`.
        ...entry,
        packageUrl: texturePackageUrl,
        ...COOKED_CURRENT_PROJECTION,
      });
    }

    // M4 / w33 (AC-21): full pre-import for the shipped form. For every meta
    // sidecar, call the import runner to produce the DDC (.pack.json) and emit
    // it as a Rollup asset. This ensures the shipped bundle carries all DDC
    // artefacts, not just the texture .bin import output. After this step the
    // catalog entries' packageUrl fields point to the hashed asset paths
    // (Rollup names), matching the import step's convention.
    //
    // For meta files whose DDC already exists on disk (e.g. pre-generated by
    // the CLI), the import runner re-imports them idempotently (GUID
    // import-stable iron law produces the same output). The runner also
    // validates the GUID set; `importer: 'shader'` is skipped.
    //
    // guidToMetaBuild (built above the texture arm) tells us which meta declares
    // each entry's GUID. Group entries by their declaring meta so we call
    // `runImport` once per meta (one pass produces all sub-assets).
    const guidSeen = new Set<string>();
    const finalizedUiUrls = new Map<string, string>();
    const emittedPackUrls = new Map<string, string>();

    for (const entry of importedEntries) {
      if (guidSeen.has(entry.guid.toLowerCase())) continue;
      const metaPath = guidToMetaBuild.get(entry.guid.toLowerCase());
      if (metaPath === undefined) {
        // Self-contained packs are already final payloads. Emit each source
        // pack once and point every asset row in that pack at the shipped
        // Rollup asset. They must not enter the importer/DDC path.
        if (entry.sourcePath.endsWith('.pack.json')) {
          let packUrl = emittedPackUrls.get(entry.sourcePath);
          if (packUrl === undefined) {
            packUrl = authoredPackUrlsBySource.get(entry.sourcePath);
          }
          if (packUrl === undefined) {
            const packPath = resolve(cwd, entry.sourcePath);
            const packRef = this.emitFile({
              type: 'asset',
              name: `${entry.guid.toLowerCase()}.pack.json`,
              originalFileName: packPath,
              source: await readFile(packPath, 'utf-8'),
            });
            packUrl = projectPackIndexUrl(basePrefix, this.getFileName(packRef));
            emittedPackUrls.set(entry.sourcePath, packUrl);
          } else {
            emittedPackUrls.set(entry.sourcePath, packUrl);
          }
          for (let index = 0; index < importedEntries.length; index += 1) {
            const candidate = importedEntries[index];
            if (candidate?.sourcePath === entry.sourcePath) {
              importedEntries[index] = { ...candidate, packageUrl: packUrl };
            }
          }
        }
        // Non-meta rows are already final and do not need an importer.
        guidSeen.add(entry.guid.toLowerCase());
        continue;
      }

      // Parse the meta and call runImport for the whole sidecar at once.
      let rm: unknown;
      try {
        rm = JSON.parse(await readFile(metaPath, 'utf-8'));
      } catch {
        // Skip unreadable meta; the entry stays in the catalog as-is.
        guidSeen.add(entry.guid.toLowerCase());
        continue;
      }
      const meta = rm as {
        importer: string;
        source?: string;
        importSettings?: unknown;
        sourceOverrides?: unknown;
        subAssets: ReadonlyArray<{ guid: string; sourceIndex: number; kind: string }>;
      };
      const subAssets = meta.subAssets;

      // Mark all sub-asset GUIDs as seen so we don't re-import this meta twice.
      for (const sub of subAssets) {
        guidSeen.add(sub.guid.toLowerCase());
      }

      // Pass1 (the import step above) already decoded these images, emitted the
      // hashed `.bin`, and folded width/height/format/colorSpace/mipmap into the
      // pack-index row's `packageUrl` + `metadata`. The runtime textureLoader
      // dispatches on `entry.kind === 'texture'` and reads only that `.bin` + the
      // inline pack-index metadata; it never fetches the per-image `.pack.json`
      // that runImport would emit here. Re-running the full import for an
      // `importer: 'image'` meta therefore re-decodes every image a second time
      // and emits a `.pack.json` Rollup asset nothing consumes. Skip it. glTF /
      // FBX metas (whose texture sub-assets are a disjoint GUID set produced by
      // their own importer) and any other importer still flow through below.
      if (meta.importer === 'image') {
        continue;
      }

      const sourceResult = resolveAssetSource(metaPath, meta.source, paths);
      if (!sourceResult.ok) {
        console.warn(
          `[forgeax-pack] source resolution failed for ${metaPath}: ${sourceResult.error.code} — skipping pre-import`,
        );
        continue;
      }

      const runMeta: RunImportMeta = {
        importer: meta.importer,
        source: sourceResult.value,
        subAssets,
        buildPack: false,
      };
      if (meta.importSettings !== undefined) {
        (runMeta as { importSettings?: Readonly<Record<string, unknown>> }).importSettings =
          meta.importSettings as Readonly<Record<string, unknown>>;
      }
      if (meta.sourceOverrides !== undefined) {
        (runMeta as { sourceOverrides?: unknown }).sourceOverrides = meta.sourceOverrides;
      }

      const sourcePackage = await produceSourcePackage({
        meta: runMeta,
        registry: importerRegistry,
        fs: fsForImport,
      });
      if (!sourcePackage.ok) {
        throw new Error(
          `[forgeax-pack] source package production failed for ${metaPath}: ${sourcePackage.error.code} - ${sourcePackage.error.hint}`,
        );
      }

      if (meta.importer === 'ui') {
        const uiGuid = subAssets[0]?.guid;
        if (uiGuid === undefined) continue;
        const artifactPaths = new Map<string, string>();
        const uiAsset = sourcePackage.value.product.assets[0];
        const transportArtifacts = projectUiBuildArtifacts(
          Object.entries(uiAsset?.artifacts ?? {}).map(([path, artifact]) => ({
            path,
            mimeType: artifact.mediaType,
            bytes: artifact.bytes,
          })),
          (artifact) => artifact.path,
        );
        for (const artifact of transportArtifacts) {
          const ref = this.emitFile({
            type: 'asset',
            name: artifact.path,
            originalFileName: artifact.path,
            source: artifact.bytes,
          });
          artifactPaths.set(artifact.path, this.getFileName(ref));
        }
        const finalized = finalizeUiArtifact(sourcePackage.value.product as never, {
          artifactUrl: (artifact) =>
            projectPackIndexUrl(basePrefix, artifactPaths.get(artifact.path) ?? artifact.path),
        });
        if (!finalized.ok) {
          throw new Error(
            `[forgeax-pack] UI finalizer failed for ${metaPath}: ${finalized.error.code}`,
          );
        }
        const uiProduct = {
          ...sourcePackage.value.product,
          assets: sourcePackage.value.product.assets.map((asset, index) =>
            index === 0 ? { ...asset, payload: finalized.value.asset } : asset,
          ),
        };
        const uiPackage = await finalizePackage(
          projectAssetProduction(uiProduct).logicalPackage,
          { write: () => {} },
          {
            base: basePrefix,
            packagePath: `assets/${uiGuid}.pack.json`,
            artifactPath: (_guid, key) => {
              const emittedPath = artifactPaths.get(key);
              if (emittedPath === undefined) {
                throw new Error(`UI artifact ${key} was not emitted for ${metaPath}`);
              }
              return emittedPath.replace(/^assets\//, '');
            },
          },
        );
        const uiRef = this.emitFile({
          type: 'asset',
          name: `${uiGuid}.pack.json`,
          originalFileName: metaPath,
          source: JSON.stringify(uiPackage.pack),
        });
        const uiPath = projectPackIndexUrl(basePrefix, this.getFileName(uiRef));
        finalizedUiUrls.set(uiGuid.toLowerCase(), uiPath);
        const rowIndex = importedEntries.findIndex(
          (entry) => entry.guid.toLowerCase() === uiGuid.toLowerCase(),
        );
        if (rowIndex >= 0 && importedEntries[rowIndex] !== undefined) {
          importedEntries[rowIndex] = { ...importedEntries[rowIndex], packageUrl: uiPath };
        }
        continue;
      }

      // Emit the .pack.json DDC as a small Rollup asset. Binary artifacts are
      // staged separately so Rollup never retains the complete cooked product
      // graph while rendering the application bundle.
      // Project the product once, then stop retaining the importer-owned POD
      // graph. `logicalPackageFromImportProduct` removes inline mesh/texture
      // payload bytes when the asset already has a body artifact; keeping the
      // original product alive through finalization would otherwise retain a
      // second large graph beside the artifact bytes.
      const importedProduct = sourcePackage.value.product;
      const logicalPackage = sourcePackage.value.logicalPackage;
      const productByGuid = productAssetsByGuid(importedProduct);
      const packagePath = `assets/${subAssets[0]?.guid ?? 'pack'}.pack.json`;
      const finalized = await finalizePackage(
        logicalPackage,
        { write: () => {} },
        {
          base: basePrefix,
          packagePath,
          artifactPath: (guid, key) => `${guid}-${key}.bin`,
        },
      );
      for (const artifact of finalized.artifacts) {
        await stageBuildArtifact(`assets/${artifact.path}`, artifact.bytes);
      }
      const pack = finalized.pack;
      const packJson = JSON.stringify(pack);
      const packRef = this.emitFile({
        type: 'asset',
        name: `${subAssets[0]?.guid ?? 'pack'}.pack.json`,
        originalFileName: metaPath,
        source: packJson,
      });
      const packUrl = projectPackIndexUrl(basePrefix, this.getFileName(packRef));

      // Update all entries from this meta to point to the Pack v2 envelope.
      for (const sub of subAssets) {
        const idx = importedEntries.findIndex(
          (e) => e.guid.toLowerCase() === sub.guid.toLowerCase(),
        );
        if (idx >= 0 && importedEntries[idx] !== undefined) {
          const existing = importedEntries[idx];
          if (existing !== undefined) {
            // Carry the DDC's outgoing dependency edges into the shipped
            // pack-index row so the prod Content Browser dependency graph
            // sees them without re-fetching the .pack.json body.
            const ddcAsset = productByGuid.get(sub.guid.toLowerCase());
            importedEntries[idx] = {
              ...existing,
              packageUrl: packUrl,
              ...COOKED_CURRENT_PROJECTION,
              ...(ddcAsset?.refs !== undefined
                ? { refs: ddcAsset.refs.map((ref) => ref.guid) }
                : {}),
            };
          }
        }
      }
    }

    const productionCatalog = dedupeFinalizedUiEntries(importedEntries, finalizedUiUrls);
    this.emitFile({
      type: 'asset',
      fileName: 'pack-index.json',
      source: JSON.stringify(productionCatalog),
    });
  }

  async function writeBundle(options: { readonly dir?: string | undefined }): Promise<void> {
    const factsDir = process.env.FORGEAX_BUILD_METRICS_DIR;
    if (factsDir !== undefined) {
      try {
        mkdirSync(factsDir, { recursive: true });
        const metrics = readDdcMetrics();
        writeFileSync(
          resolve(factsDir, `pack-${process.pid}.json`),
          `${JSON.stringify({
            assetCookHitCount: metrics.hitCount,
            assetCookMissCount: metrics.missCount,
            assetCookWriteFailureCount: metrics.writeFailureCount,
          })}\n`,
        );
      } catch {
        // Build facts are diagnostic only; cache failures remain fail-open.
      }
    }
    const stage = buildArtifactStage;
    if (stage === undefined) return;
    if (options.dir === undefined) {
      throw new Error('forgeax:pack staged artifacts require a directory output');
    }
    const outputDir = resolve(process.cwd(), options.dir);
    try {
      for (const relative of stage.files) {
        const source = resolve(stage.root, relative);
        const destination = resolve(outputDir, relative);
        await mkdir(dirname(destination), { recursive: true });
        await rename(source, destination);
      }
    } finally {
      await rm(stage.root, { recursive: true, force: true });
      buildArtifactStage = undefined;
    }
  }

  async function closeBundle(): Promise<void> {
    const stage = buildArtifactStage;
    buildArtifactStage = undefined;
    if (stage !== undefined) await rm(stage.root, { recursive: true, force: true });
  }

  return { generateBundle, writeBundle, closeBundle };
}
