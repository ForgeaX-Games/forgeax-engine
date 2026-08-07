import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/template-game-default-vfx',
    // Keep this project narrowly scoped to the authored Pack contract added by
    // this round; the template's DOM tests are browser-owned elsewhere.
    include: ['tests/vfx-effect-assets.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
