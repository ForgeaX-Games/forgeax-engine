/** A lease captures one GPU allocation, never a reusable World handle slot. */
export interface ResidencyLease {
  track(completed: Promise<unknown>): void;
  release(evict: boolean): Promise<void> | undefined;
}

/** Shared candidates and queue submissions have one allocation lifetime owner. */
export class ResidencyLifetime {
  private leases = 0;
  private retired = false;
  private eviction: (() => void) | undefined;
  private readonly submissions = new Set<Promise<unknown>>();
  private readonly waiters = new Set<() => void>();

  constructor(private destroy: (() => void) | undefined) {}

  get owners(): number {
    return this.leases;
  }

  get inUse(): boolean {
    return this.leases > 0 || this.submissions.size > 0;
  }

  retain(evict: () => void): ResidencyLease {
    this.leases += 1;
    this.eviction = undefined;
    let released = false;
    let completion: Promise<void> | undefined;
    return {
      track: (submitted) => this.track(submitted),
      release: (shouldEvict) => {
        if (released) return completion;
        released = true;
        this.leases -= 1;
        if (this.leases === 0 && shouldEvict) this.eviction = evict;
        completion =
          this.submissions.size === 0
            ? undefined
            : new Promise<void>((resolve) => this.waiters.add(resolve));
        this.flush();
        return completion;
      },
    };
  }

  track(completed: Promise<unknown>): void {
    if (this.submissions.has(completed)) return;
    this.submissions.add(completed);
    const finish = (): void => {
      this.submissions.delete(completed);
      this.flush();
    };
    void completed.then(finish, finish);
  }

  retire(): void {
    this.retired = true;
    this.flush();
  }

  private flush(): void {
    if (this.submissions.size !== 0) return;
    if (this.leases === 0 && this.eviction !== undefined) {
      const evict = this.eviction;
      this.eviction = undefined;
      evict();
    }
    if (this.retired && this.leases === 0 && this.destroy !== undefined) {
      const destroy = this.destroy;
      this.destroy = undefined;
      destroy();
    }
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}
