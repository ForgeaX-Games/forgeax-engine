import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-runtime',
    // Exclude `*.browser.test.ts` / `*.dawn.test.ts` — those are owned by the
    // root `browser` / `dawn` vitest projects (K-3 split stance, root vitest.config.ts
    // §projects). Without this, per-package project's default include glob picks
    // up the dedicated test files in node env (no document / no dawn-injection
    // setupFiles), causing cascade fail under `pnpm test:unit`.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.browser-no-webgpu.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
