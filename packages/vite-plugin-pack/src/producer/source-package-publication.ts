import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { type DdcEntry, DdcEntryStore, DdcLifecycle, ddcOutputDigest } from '@forgeax/engine-ddc';
import { canonicalizeLogicalPackage, finalizePackage } from '../package-finalizer.js';
import type { SourcePackageProduct } from './source-package.js';
import {
  normalizeSourcePackageError,
  type SourcePackageError,
  type SourcePackageErrorContext,
  sourcePackageError,
} from './source-package-errors.js';

export interface SourcePackageDependency {
  readonly path: string;
  readonly digest: string;
}

export interface SourcePackageDdcInput {
  readonly schemaVersion: string;
  readonly importer: string;
  readonly importerVersion: string;
  readonly producerFingerprint: string;
  readonly codec: string;
  readonly settings: unknown;
  readonly sourceDependencies: readonly SourcePackageDependency[];
  readonly declaredGuids: readonly string[];
  readonly targetProfile: string;
  readonly publish?: unknown;
}

export interface SourcePackageDdcEntryInput {
  readonly root: string;
  readonly entry: DdcEntry;
  readonly context: SourcePackageErrorContext;
}

export type SourcePackageDdcPublicationResult =
  | { readonly ok: true; readonly head: Awaited<ReturnType<DdcLifecycle['inspect']>> }
  | { readonly ok: false; readonly error: SourcePackageError };

export interface SourcePackageDdcRecord {
  readonly key: string;
  readonly input: SourcePackageDdcInput;
}

export interface SourcePackageRouteOverride {
  readonly omitArtifact?: string;
}

export interface SourcePackagePublicationInput {
  readonly ddcRoot: string;
  readonly routeRoot: string;
  readonly ddcInput: SourcePackageDdcInput;
  readonly source: SourcePackageProduct;
  readonly route?: SourcePackageRouteOverride;
}

export interface PublishedSourcePackage {
  readonly key: string;
  readonly anchorGuid: string;
  readonly packageUrl: string;
  readonly semanticDigest: string;
  readonly cacheHit: boolean;
}

export type SourcePackagePublicationResult =
  | { readonly ok: true; readonly value: PublishedSourcePackage }
  | { readonly ok: false; readonly error: SourcePackageError };

type SourcePackageProducer = () => Promise<SourcePackageProduct>;

export interface SourcePackagePublicationOptions {
  readonly ddcRoot: string;
  readonly routeRoot: string;
  readonly ddcInput: SourcePackageDdcInput;
  readonly produce: SourcePackageProducer;
}

export interface SourcePackageCoalescer {
  ensure<T>(key: string, produce: () => Promise<T>): Promise<T>;
  invalidate(key: string): void;
}

export function createSourcePackageCoalescer(): SourcePackageCoalescer {
  const inFlight = new Map<string, Promise<unknown>>();
  return {
    ensure<T>(key: string, produce: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing as Promise<T>;
      const current = produce().finally(() => inFlight.delete(key));
      inFlight.set(key, current);
      return current;
    },
    invalidate(key: string): void {
      inFlight.delete(key);
    },
  };
}

interface StoredSourcePackage {
  readonly input: SourcePackageDdcInput;
  readonly pack: SourcePackageProduct['pack'];
  readonly semanticDigest: string;
  readonly anchorGuid: string;
  readonly packageUrl: string;
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function semanticInput(input: SourcePackageDdcInput): Record<string, unknown> {
  return {
    schemaVersion: input.schemaVersion,
    importer: input.importer,
    importerVersion: input.importerVersion,
    producerFingerprint: input.producerFingerprint,
    codec: input.codec,
    settings: input.settings,
    sourceDependencies: [...input.sourceDependencies]
      .map((dependency) => ({ path: dependency.path, digest: dependency.digest }))
      .sort((left, right) =>
        `${left.path}\0${left.digest}`.localeCompare(`${right.path}\0${right.digest}`),
      ),
    declaredGuids: [...input.declaredGuids].map((guid) => guid.toLowerCase()).sort(),
    targetProfile: input.targetProfile,
  };
}

export function sourcePackageDdcKey(input: SourcePackageDdcInput): string {
  return createHash('sha256')
    .update(stable(semanticInput(input)))
    .digest('hex');
}

export function isCurrentSourcePackageDdc(
  record: SourcePackageDdcRecord,
  input: SourcePackageDdcInput,
): boolean {
  return (
    record.key === sourcePackageDdcKey(input) &&
    stable(semanticInput(record.input)) === stable(semanticInput(input))
  );
}

function context(input: SourcePackagePublicationInput): SourcePackageErrorContext {
  return {
    sourceMeta: input.source.product.sourceDependencies[0] ?? '<source-meta>',
    anchorGuid: input.source.anchorGuid,
    affectedGuids: input.source.declaredGuids,
    producer: `source-package/${input.ddcInput.importer}`,
    importer: input.ddcInput.importer,
  };
}

function entryFor(
  input: SourcePackagePublicationInput,
  key: string,
  packageUrl: string,
  semanticDigest: string,
): DdcEntry {
  const artifacts: Record<string, { mediaType: string; bytes: Uint8Array }> = {};
  for (const asset of input.source.logicalPackage.assets) {
    for (const [localKey, artifact] of Object.entries(asset.artifacts)) {
      if (artifact === undefined) continue;
      artifacts[`${asset.guid}/${localKey}`] = {
        mediaType: artifact.mediaType,
        bytes: artifact.bytes,
      };
    }
  }
  const payload: StoredSourcePackage = {
    input: input.ddcInput,
    pack: jsonSafe(input.source.pack) as SourcePackageProduct['pack'],
    semanticDigest,
    anchorGuid: input.source.anchorGuid,
    packageUrl,
  };
  const base = {
    key,
    guid: input.source.anchorGuid,
    payload,
    refs: input.source.pack.assets.flatMap((asset) => asset.refs),
    artifacts,
    receipt: {
      guid: input.source.anchorGuid,
      key,
      producer: `source-package/${input.ddcInput.importer}`,
      inputFingerprint: key,
      outputDigest: '',
    },
  } satisfies DdcEntry;
  return { ...base, receipt: { ...base.receipt, outputDigest: ddcOutputDigest(base) } };
}

export async function publishSourcePackageDdc(
  input: SourcePackageDdcEntryInput,
): Promise<SourcePackageDdcPublicationResult> {
  const lifecycle = new DdcLifecycle(input.root);
  const lease = await lifecycle.begin(input.entry.guid, input.entry.key);
  try {
    await new DdcEntryStore(input.root).write(input.entry);
  } catch (error) {
    await lifecycle.fail(lease, {
      code: 'source-package-ddc-failed',
      detail: String(error),
    });
    return {
      ok: false,
      error: sourcePackageError('source-package-ddc-failed', input.context, {
        stage: 'ddc',
        reason: error instanceof Error ? error.message : String(error),
      }),
    };
  }
  const commit = await lifecycle.commit(lease, input.entry.key);
  if (commit.result !== 'current') {
    return {
      ok: false,
      error: sourcePackageError('source-package-ddc-failed', input.context, {
        stage: 'ddc',
        reason: `DDC lifecycle commit returned ${commit.result}`,
      }),
    };
  }
  return { ok: true, head: await lifecycle.inspect(input.entry.guid, input.entry.key) };
}

async function routeHasCompletePackage(
  routeRoot: string,
  anchorGuid: string,
  packageUrl: string,
): Promise<boolean> {
  const packageName = packageUrl.split('/').pop() ?? packageUrl;
  const stagedPackagePath = join(routeRoot, packageUrl.replace(/^\//, ''));
  const installedPackagePath = join(routeRoot, packageName);
  const packagePath =
    (await stat(stagedPackagePath)
      .then(() => stagedPackagePath)
      .catch(() => undefined)) ?? installedPackagePath;
  try {
    const pack = JSON.parse(await readFile(packagePath, 'utf8')) as {
      readonly assets?: readonly {
        readonly artifacts?: Readonly<
          Record<string, { readonly path: string; readonly byteLength: number }>
        >;
      }[];
    };
    if (!Array.isArray(pack.assets)) return false;
    for (const asset of pack.assets) {
      const artifacts = asset.artifacts ?? {};
      for (const artifact of Object.values(artifacts) as readonly {
        readonly path: string;
        readonly byteLength: number;
      }[]) {
        const info = await stat(join(routeRoot, artifact.path));
        if (info.size !== artifact.byteLength) return false;
      }
    }
    return pack.assets.length > 0 && packagePath.endsWith(`${anchorGuid}.pack.json`);
  } catch {
    return false;
  }
}

async function installRoute(stage: string, routeRoot: string, packageUrl: string): Promise<void> {
  await mkdir(routeRoot, { recursive: true });
  const files: string[] = [];
  async function collect(directory: string): Promise<void> {
    const entries = await (await import('node:fs/promises')).readdir(directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await collect(absolute);
      else files.push(absolute);
    }
  }
  await collect(stage);
  const packageFile = files.find((file) => file.endsWith('.pack.json'));
  for (const file of files.filter((candidate) => candidate !== packageFile).sort()) {
    const target = join(routeRoot, relative(stage, file));
    await mkdir(resolve(target, '..'), { recursive: true });
    await rename(file, target);
  }
  if (packageFile !== undefined) {
    const packageName = packageUrl.split('/').pop() ?? packageUrl;
    const target = join(routeRoot, packageName);
    await mkdir(resolve(target, '..'), { recursive: true });
    await rename(packageFile, target);
  }
}

export async function publishSourcePackage(
  input: SourcePackagePublicationInput,
): Promise<SourcePackagePublicationResult> {
  const key = sourcePackageDdcKey(input.ddcInput);
  const semanticDigest = createHash('sha256')
    .update(canonicalizeLogicalPackage(input.source.logicalPackage))
    .digest('hex');
  const stage = await mkdtemp(join(resolve(input.routeRoot, '..'), '.source-package-route-'));
  try {
    const finalized = await finalizePackage(
      input.source.logicalPackage,
      {
        write: async (path, bytes) => {
          if (input.route?.omitArtifact === path) return;
          const destination = join(stage, path);
          await mkdir(resolve(destination, '..'), { recursive: true });
          await import('node:fs/promises').then(({ writeFile }) => writeFile(destination, bytes));
        },
      },
      {
        base: '/',
        packagePath: `assets/${input.source.anchorGuid}.pack.json`,
        artifactPath: (guid, localKey) => `${guid}/${localKey}.bin`,
      },
    );
    if (!(await routeHasCompletePackage(stage, input.source.anchorGuid, finalized.packageUrl))) {
      return {
        ok: false,
        error: sourcePackageError('source-package-publication-invalid', context(input), {
          stage: 'route-integrity',
          reason: 'staged Pack body or artifact closure failed route verification',
        }),
      };
    }
    const ddc = await publishSourcePackageDdc({
      root: input.ddcRoot,
      entry: entryFor(input, key, finalized.packageUrl, semanticDigest),
      context: context(input),
    });
    if (!ddc.ok) {
      return {
        ok: false,
        error: ddc.error,
      };
    }
    await installRoute(stage, input.routeRoot, finalized.packageUrl);
    return {
      ok: true,
      value: {
        key,
        anchorGuid: input.source.anchorGuid,
        packageUrl: finalized.packageUrl,
        semanticDigest,
        cacheHit: false,
      },
    };
  } catch (error) {
    return { ok: false, error: normalizeSourcePackageError(error, context(input)) };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export function createSourcePackagePublication(options: SourcePackagePublicationOptions): {
  ensure(): Promise<SourcePackagePublicationResult>;
} {
  let inFlight: Promise<SourcePackagePublicationResult> | undefined;
  const ensure = async (): Promise<SourcePackagePublicationResult> => {
    const key = sourcePackageDdcKey(options.ddcInput);
    const existing = await new DdcEntryStore(options.ddcRoot).read(key);
    if (existing !== null) {
      const stored = existing.payload as StoredSourcePackage;
      if (
        isCurrentSourcePackageDdc({ key, input: stored.input }, options.ddcInput) &&
        (await routeHasCompletePackage(options.routeRoot, stored.anchorGuid, stored.packageUrl))
      ) {
        return {
          ok: true,
          value: {
            key,
            anchorGuid: stored.anchorGuid,
            packageUrl: stored.packageUrl,
            semanticDigest: stored.semanticDigest,
            cacheHit: true,
          },
        };
      }
    }
    const source = await options.produce();
    return publishSourcePackage({
      ddcRoot: options.ddcRoot,
      routeRoot: options.routeRoot,
      ddcInput: options.ddcInput,
      source,
    });
  };
  return {
    ensure(): Promise<SourcePackagePublicationResult> {
      if (inFlight === undefined) {
        inFlight = ensure().finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    },
  };
}
