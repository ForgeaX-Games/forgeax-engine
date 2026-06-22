import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/rhi-debug-viewer',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  },
});