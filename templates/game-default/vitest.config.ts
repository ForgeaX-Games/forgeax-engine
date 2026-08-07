import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/template-game-default-vfx',
    // Keep this project narrowly scoped to authored Pack contracts; the
    // template's DOM tests are browser-owned elsewhere.
    include: ['tests/vfx-effect-assets.test.ts', 'tests/ui-manifest.test.ts', 'tests/asset-lab-actions.test.ts', 'tests/target-profile-loop.test.ts', 'tests/video-texture-panel.test.ts', 'tests/gameplay-aim.test.ts', 'tests/gameplay-input.integration.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
