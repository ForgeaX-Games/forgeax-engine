import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@forgeax/engine-devkit',
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // The canonical template inspection starts a Vite-backed module graph.
    // Keep its test budget explicit so a loaded CI runner does not turn a
    // correct integration test into a default-5s timeout failure.
    testTimeout: 15000,
  },
});
