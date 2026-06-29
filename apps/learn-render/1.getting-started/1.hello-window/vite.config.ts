import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// learn-render section-1.1 hello-window vite config (M4 placeholder).
// Mirrors apps/hello/cube vite shape minus the forgeaxShader plugin (1.1
// covers Engine.create + clearColor only, no custom shader). M5 milestone
// fills src/index.ts with the actual three-line createRenderer demo.
//
// Dev port 5180 is reserved for this app; strictPort prevents collision
// with hello-triangle (default 5173) and the parity-* fleet (4173-4175).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');

export default defineConfig({
  server: {
    port: 5180,
    strictPort: true,
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
  // M12 fixup: this workspace registers as a per-package vitest project
  // through the root vitest.config.ts D-6 dual-segment glob
  // (`apps/learn-render/1.getting-started/*/vite.config.ts`). That project
  // runs in the default node/jsdom environment, where neither
  // `navigator.gpu` nor `fetch` exists, so any `*.browser.test.ts` /
  // `*.dawn.test.ts` co-located here would fail with `webgpu-unavailable`
  // / `fetch failed`. The dedicated `browser` / `dawn` projects in the
  // root vitest.config.ts still pick those files up via their global
  // include globs (`**/*.browser.test.ts` / `**/*.dawn.test.ts`), so
  // excluding them only here removes the duplicate-execution-in-wrong-env
  // path while keeping the cross-environment coverage intact.
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
