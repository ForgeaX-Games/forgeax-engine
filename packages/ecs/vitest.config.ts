import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-ecs',
    passWithNoTests: true,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});
