import { defineProject } from 'vitest/config';

// Per-package vitest project (K-3 split policy: discovered from root
// vitest.config.ts via `packages/*` glob, addressable as
// `--project='@forgeax/engine-gltf'`).
//
// Mirrors `packages/pack/vitest.config.ts` shape: name is the npm package
// id, include scopes both `__tests__` source-collocated tests and
// dedicated `test/**` siblings. Typecheck is enabled so `.test-d.ts`
// (compile-time discriminated-union narrowing fixtures) participate in
// the unit run.
export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-gltf',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    include: [
      'test/**/*.test.ts',
      'test/**/*.test-d.ts',
      'src/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test-d.ts',
    ],
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
});
