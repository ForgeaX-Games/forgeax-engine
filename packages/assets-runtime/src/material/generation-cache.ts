import { err, ok, type Result } from '@forgeax/engine-types';

export interface MaterialCachedArtifact {
  readonly bytes: Uint8Array;
}

export interface MaterialGenerationVector {
  readonly dependencies: Readonly<Record<string, number>>;
}

export interface MaterialStaleGenerationError {
  readonly code: 'material-specialization-stale-generation';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly material: string;
    readonly dependencies: readonly string[];
    readonly observed: MaterialGenerationVector;
    readonly current: MaterialGenerationVector;
  };
}

function sameVector(left: MaterialGenerationVector, right: MaterialGenerationVector): boolean {
  const names = new Set([...Object.keys(left.dependencies), ...Object.keys(right.dependencies)]);
  return [...names].every((name) => left.dependencies[name] === right.dependencies[name]);
}

export class MaterialGenerationCache {
  readonly #resolved = new Map<string, Promise<unknown>>();
  readonly #resolvedKeys = new Map<string, string>();
  readonly #artifacts = new Map<string, MaterialCachedArtifact>();
  readonly #generations = new Map<string, number>();
  readonly #errors = new Map<string, MaterialStaleGenerationError>();

  resolve<T>(materialGuid: string, specializationKey: string, load: () => Promise<T>): Promise<T> {
    const cacheKey = `${materialGuid}:${specializationKey}`;
    const previous = this.#resolved.get(cacheKey);
    if (previous !== undefined) return previous as Promise<T>;
    const promise = load();
    this.#resolved.set(cacheKey, promise);
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const generation = this.vector(dependencies);
      const loaded = await load(generation);
      const current = this.vector(dependencies);
      if (sameVector(loaded.generation, current)) {
        this.#errors.delete(materialGuid);
        return ok(loaded.value);
      }
      if (attempt === 1) {
        const error: MaterialStaleGenerationError = {
          code: 'material-specialization-stale-generation',
          expected: 'the loaded specialization generation to match its dependencies',
          hint: 'retry after dependency publication settles and keep the stale result unpublished',
          detail: { material: materialGuid, dependencies, observed: loaded.generation, current },
        };
        this.#errors.set(materialGuid, error);
        return err(error);
      }
    }
    const current = this.vector(dependencies);
    return err({
      code: 'material-specialization-stale-generation',
      expected: 'the loaded specialization generation to match its dependencies',
      hint: 'retry after dependency publication settles and keep the stale result unpublished',
      detail: { material: materialGuid, dependencies, observed: current, current },
    });
  }

  private vector(dependencies: readonly string[]): MaterialGenerationVector {
    return {
      dependencies: Object.fromEntries(
        dependencies.map((dependency) => [dependency, this.#generations.get(dependency) ?? 0]),
      ),
    };
  }
}
