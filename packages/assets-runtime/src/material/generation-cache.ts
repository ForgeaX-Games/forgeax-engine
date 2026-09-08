import {
  createMaterialError,
  err,
  type MaterialErrorFor,
  type MaterialGenerationVector,
  ok,
  type Result,
} from '@forgeax/engine-types';

export type { MaterialGenerationVector } from '@forgeax/engine-types';

export interface MaterialCachedArtifact {
  readonly bytes: Uint8Array;
}

export type MaterialStaleGenerationError =
  MaterialErrorFor<'material-specialization-stale-generation'>;

function sameVector(left: MaterialGenerationVector, right: MaterialGenerationVector): boolean {
  const names = new Set([...Object.keys(left.dependencies), ...Object.keys(right.dependencies)]);
  return [...names].every((name) => left.dependencies[name] === right.dependencies[name]);
}

export class MaterialGenerationCache {
  readonly #resolved = new Map<string, Promise<unknown>>();
  readonly #resolvedByMaterial = new Map<string, Set<string>>();
  readonly #resolvedKeys = new Map<string, string>();
  readonly #artifacts = new Map<string, MaterialCachedArtifact>();
  readonly #generations = new Map<string, number>();
  readonly #errors = new Map<string, MaterialStaleGenerationError>();
  readonly #materialDependencies = new Map<string, readonly string[]>();
  readonly #dependents = new Map<string, Set<string>>();

  resolve<T>(
    materialGuid: string,
    specializationKey: string,
    load: () => Promise<T>,
    publicationGeneration = 0,
  ): Promise<T> {
    const cacheKey = `${materialGuid}:${specializationKey}:${publicationGeneration}`;
    const previous = this.#resolved.get(cacheKey);
    if (previous !== undefined) return previous as Promise<T>;
    const promise = load();
    this.#resolved.set(cacheKey, promise);
    const resolvedKeys = this.#resolvedByMaterial.get(materialGuid) ?? new Set<string>();
    resolvedKeys.add(cacheKey);
    this.#resolvedByMaterial.set(materialGuid, resolvedKeys);
    void promise.then(
      (value) => {
        if (isStaleGenerationResult(value)) this.removeResolved(materialGuid, cacheKey, promise);
      },
      () => this.removeResolved(materialGuid, cacheKey, promise),
    );
    return promise;
  }

  linkResolved(materialGuid: string, specializationKey: string): void {
    this.#resolvedKeys.set(materialGuid, specializationKey);
  }

  getResolvedKey(materialGuid: string): string | undefined {
    return this.#resolvedKeys.get(materialGuid);
  }

  storeArtifact(key: string, artifact: MaterialCachedArtifact): void {
    this.#artifacts.set(key, artifact);
  }

  getArtifact(key: string): MaterialCachedArtifact | undefined {
    return this.#artifacts.get(key);
  }

  bump(dependency: string): number {
    const generation = (this.#generations.get(dependency) ?? 0) + 1;
    this.#generations.set(dependency, generation);
    for (const materialGuid of this.#dependents.get(dependency) ?? []) {
      for (const cacheKey of this.#resolvedByMaterial.get(materialGuid) ?? []) {
        this.#resolved.delete(cacheKey);
      }
      this.#resolvedByMaterial.delete(materialGuid);
    }
    return generation;
  }

  generationError(materialGuid: string): MaterialStaleGenerationError | undefined {
    return this.#errors.get(materialGuid);
  }

  async loadWithGeneration<T>(
    materialGuid: string,
    dependencies: readonly string[],
    load: (
      generation: MaterialGenerationVector,
    ) => Promise<{ readonly generation: MaterialGenerationVector; readonly value: T }>,
  ): Promise<Result<T, MaterialStaleGenerationError>> {
    const dependencySet = Object.freeze([...dependencies]);
    this.trackDependencies(materialGuid, dependencySet);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const generation = this.vector(dependencySet);
      const loaded = await load(generation);
      const observed = snapshotVector(loaded.generation);
      const current = this.vector(dependencySet);
      if (sameVector(observed, current)) {
        this.#errors.delete(materialGuid);
        return ok(loaded.value);
      }
      if (attempt === 1) {
        const error = staleGenerationError(materialGuid, dependencySet, observed, current);
        this.#errors.set(materialGuid, error);
        return err(error);
      }
    }
    const current = this.vector(dependencySet);
    return err(staleGenerationError(materialGuid, dependencySet, current, current));
  }

  private trackDependencies(materialGuid: string, dependencies: readonly string[]): void {
    const previous = this.#materialDependencies.get(materialGuid);
    if (previous !== undefined) {
      for (const dependency of previous) this.#dependents.get(dependency)?.delete(materialGuid);
    }
    this.#materialDependencies.set(materialGuid, dependencies);
    for (const dependency of dependencies) {
      const dependents = this.#dependents.get(dependency) ?? new Set<string>();
      dependents.add(materialGuid);
      this.#dependents.set(dependency, dependents);
    }
  }

  private removeResolved(materialGuid: string, cacheKey: string, promise: Promise<unknown>): void {
    if (this.#resolved.get(cacheKey) !== promise) return;
    this.#resolved.delete(cacheKey);
    const resolvedKeys = this.#resolvedByMaterial.get(materialGuid);
    if (resolvedKeys === undefined) return;
    resolvedKeys.delete(cacheKey);
    if (resolvedKeys.size === 0) this.#resolvedByMaterial.delete(materialGuid);
  }

  private vector(dependencies: readonly string[]): MaterialGenerationVector {
    return snapshotVector({
      dependencies: Object.fromEntries(
        dependencies.map((dependency) => [dependency, this.#generations.get(dependency) ?? 0]),
      ),
    });
  }
}

function snapshotVector(vector: MaterialGenerationVector): MaterialGenerationVector {
  return Object.freeze({ dependencies: Object.freeze({ ...vector.dependencies }) });
}

function staleGenerationError(
  material: string,
  dependencies: readonly string[],
  observed: MaterialGenerationVector,
  current: MaterialGenerationVector,
): MaterialStaleGenerationError {
  const detail = Object.freeze({
    code: 'material-specialization-stale-generation' as const,
    material,
    dependencies,
    observed,
    current,
  });
  return Object.freeze(createMaterialError('material-specialization-stale-generation', detail));
}

function isStaleGenerationResult(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const result = value as { readonly ok?: unknown; readonly error?: unknown };
  if (result.ok !== false || result.error === null || typeof result.error !== 'object')
    return false;
  return (
    (result.error as { readonly code?: unknown }).code ===
    'material-specialization-stale-generation'
  );
}
