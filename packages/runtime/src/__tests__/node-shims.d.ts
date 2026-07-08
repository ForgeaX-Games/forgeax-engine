// Ambient declarations for node:* modules used by dawn tests that read the
// hello-triangle compiled shader manifest at runtime. The runtime package's
// tsconfig does not enable @types/node (production target is browser); these
// minimal shims keep tsc green for the 3 shadow dawn test files only.
//
// Used by:
// - shadow-m2.dawn.test.ts
// - shadow-m3.dawn.test.ts
// - shadow-m3-calibrate-run.dawn.test.ts
// - tilemap-chunk-y-sort-bench.unit.test.ts (perf_hooks + process.env)
// - render-system-fold-scene-instances.unit.test.ts (readdirSync + dirname)
// - basis-catalog-dispatch.integration.test.ts (existsSync pkg-built gate)

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string;
  export function readdirSync(path: string): string[];
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string;
  export function dirname(p: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:perf_hooks' {
  export const performance: { now(): number };
}

declare const process: { env: Record<string, string | undefined> };
