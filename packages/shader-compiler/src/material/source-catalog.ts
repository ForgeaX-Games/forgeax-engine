import type { MaterialError, Result } from '@forgeax/engine-types';
import { createMaterialError, err, ok } from '@forgeax/engine-types';

export interface MaterialSourceInput {
  readonly source: string;
  readonly path: string;
  readonly virtual?: boolean;
}

export interface MaterialSourceRecord extends MaterialSourceInput {
  readonly moduleId: string;
  readonly provenance: 'engine' | 'project';
}

export interface MaterialSourceCatalogInput {
  readonly engine: readonly MaterialSourceInput[];
  readonly project: readonly MaterialSourceInput[];
}

const MODULE_ID_RE = /^\s*#define_import_path\s+([A-Za-z0-9_-]+(?:::[A-Za-z0-9_-]+)*)\s*$/m;

function moduleIdOf(source: MaterialSourceInput): string | undefined {
  return MODULE_ID_RE.exec(source.source)?.[1];
}

function namespaceOf(moduleId: string): string {
  return moduleId.split('::')[0] ?? moduleId;
}

function missingModule(
  moduleId: string,
  source: string,
): Result<MaterialSourceRecord, MaterialError> {
  return err(
    createMaterialError('shader-module-not-found', {
      code: 'shader-module-not-found',
      module: moduleId,
      source,
    }),
  );
}

function duplicateModule(moduleId: string, sources: readonly string[]): MaterialError {
  return createMaterialError('shader-module-id-duplicate', {
    code: 'shader-module-id-duplicate',
    module: moduleId,
    sources,
  });
}

function moduleIdError(
  code: 'shader-module-id-missing' | 'shader-module-namespace-reserved',
  source: MaterialSourceInput,
  moduleId?: string,
): MaterialError {
  if (code === 'shader-module-id-missing') {
    return createMaterialError(code, { code, source: source.path });
  }
  const namespace = namespaceOf(moduleId ?? '');
  return createMaterialError(code, { code, module: moduleId ?? '', namespace });
}

export class MaterialSourceCatalog {
  readonly #modules: ReadonlyMap<string, MaterialSourceRecord>;

  constructor(records: readonly MaterialSourceRecord[]) {
    this.#modules = new Map(records.map((record) => [record.moduleId, record]));
  }

  get(moduleId: string): Result<MaterialSourceRecord, MaterialError> {
    const record = this.#modules.get(moduleId);
    if (record !== undefined) return ok(record);
    return missingModule(moduleId, moduleId);
  }

  resolve(moduleId: string, source: string): Result<MaterialSourceRecord, MaterialError> {
    const record = this.#modules.get(moduleId);
    if (record !== undefined) return ok(record);
    return missingModule(moduleId, source);
  }

  entries(): readonly MaterialSourceRecord[] {
    return [...this.#modules.values()];
  }
}

export function buildMaterialSourceCatalog(
  input: MaterialSourceCatalogInput,
): Result<MaterialSourceCatalog, MaterialError> {
  const records: MaterialSourceRecord[] = [];
  const seen = new Map<string, string[]>();
  for (const [provenance, sources] of [
    ['engine', input.engine],
    ['project', input.project],
  ] as const) {
    for (const source of sources) {
      const moduleId = moduleIdOf(source);
      if (moduleId === undefined) return err(moduleIdError('shader-module-id-missing', source));
      if (provenance === 'project' && namespaceOf(moduleId).startsWith('forgeax_')) {
        return err(moduleIdError('shader-module-namespace-reserved', source, moduleId));
      }
      const locations = seen.get(moduleId) ?? [];
      locations.push(source.path);
      seen.set(moduleId, locations);
      records.push({ ...source, moduleId, provenance });
    }
  }
  for (const [moduleId, sources] of seen) {
    if (sources.length > 1) return err(duplicateModule(moduleId, sources));
  }
  return ok(new MaterialSourceCatalog(records));
}
