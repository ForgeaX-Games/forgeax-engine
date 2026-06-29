import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'jsdom',
    name: '@forgeax/rhi-debug-viewer',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});