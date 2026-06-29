import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-debug-draw',
    include: ['test/**/*.test.ts'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
    coverage: {
      exclude: [
        'dist/**',
        '**/*.config.ts',
        'test/**',
        'bench/**',
        '**/*.bench.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
      },
    },
  },
});