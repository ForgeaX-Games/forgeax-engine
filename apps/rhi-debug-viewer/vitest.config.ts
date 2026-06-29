import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'jsdom',
    // jsdom only exposes localStorage when an origin is set; the layout-persistence
    // tests (dockview-layout.test.tsx) call localStorage.clear() in beforeEach.
    environmentOptions: { jsdom: { url: 'http://localhost' } },
    // Pin globalThis.localStorage to jsdom's (Node 22+ ships a conflicting
    // experimental global); see setup.ts.
    setupFiles: ['./src/__tests__/setup.ts'],
    name: '@forgeax/rhi-debug-viewer',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});