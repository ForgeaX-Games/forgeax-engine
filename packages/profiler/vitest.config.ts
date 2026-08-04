import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-profiler',
    passWithNoTests: false,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
