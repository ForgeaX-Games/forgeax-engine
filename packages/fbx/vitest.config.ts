import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-fbx',
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