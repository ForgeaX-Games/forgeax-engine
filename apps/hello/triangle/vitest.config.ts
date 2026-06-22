import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/hello-triangle',
    include: ['test/**/*.test.ts'],
  },
});