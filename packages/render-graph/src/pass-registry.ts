// @forgeax/engine-render-graph/src/pass-registry.ts — pass declaration
// registry (plan-strategy 3.1).
//
// Shape (D-5):
// - name -> reads/writes declaration + optional execute closure
// - supports listPasses enumeration
import type { PassDescriptor } from './graph.js';

export interface PassEntry<Ctx = unknown> {
  readonly name: string;
  readonly descriptor: PassDescriptor<Ctx>;
}

export class PassRegistry<Ctx = unknown> {
  private readonly passes: PassEntry<Ctx>[] = [];

  add(name: string, descriptor: PassDescriptor<Ctx>): PassEntry<Ctx> {
    const entry: PassEntry<Ctx> = { name, descriptor };
    this.passes.push(entry);
    return entry;
  }

  list(): readonly PassEntry<Ctx>[] {
    return this.passes;
  }

  count(): number {
    return this.passes.length;
  }
}
