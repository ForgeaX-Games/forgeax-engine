export class MaterialDependencyGraph {
  readonly #dependencies = new Map<string, Set<string>>();
  readonly #dependents = new Map<string, Set<string>>();
  readonly #invalidated = new Set<string>();

  link(materialGuid: string, dependencies: readonly string[]): void {
    const previous = this.#dependencies.get(materialGuid) ?? new Set<string>();
    for (const dependency of previous) this.#dependents.get(dependency)?.delete(materialGuid);
    const next = new Set(dependencies);
    this.#dependencies.set(materialGuid, next);
    for (const dependency of next) {
      const materials = this.#dependents.get(dependency) ?? new Set<string>();
      materials.add(materialGuid);
      this.#dependents.set(dependency, materials);
    }
  }

  dependentsOf(dependency: string): readonly string[] {
    return [...(this.#dependents.get(dependency) ?? [])].sort();
  }

  invalidate(dependencies: readonly string[]): readonly string[] {
    const queue = [...dependencies];
    const visited = new Set<string>();
    const result = new Set<string>();
    while (queue.length > 0) {
      const dependency = queue.shift();
      if (dependency === undefined || visited.has(dependency)) continue;
      visited.add(dependency);
      for (const material of this.#dependents.get(dependency) ?? []) {
        if (!result.has(material)) queue.push(material);
        result.add(material);
        this.#invalidated.add(material);
      }
    }
    return [...result].sort();
  }

  isInvalidated(materialGuid: string): boolean {
    return this.#invalidated.has(materialGuid);
  }

  clear(materialGuid: string): void {
    this.#invalidated.delete(materialGuid);
  }
}
