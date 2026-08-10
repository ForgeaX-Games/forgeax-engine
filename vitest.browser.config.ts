import { defineConfig } from 'vitest/config';
import { createBrowserProject } from './vitest-browser-project';

export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: true,
    teardownTimeout: 500,
    deps: {
      optimizer: {
        client: { enabled: false },
      },
    },
    projects: [createBrowserProject()],
  },
});
