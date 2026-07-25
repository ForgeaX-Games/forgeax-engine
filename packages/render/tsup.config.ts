import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/authoring.ts', 'src/internal.ts', 'src/construct-renderer.ts'],
  splitting: true,
  // Keep ECS/math identity shared with host worlds. Bundling a second ECS
  // copy makes component tokens incomparable and manifests as a silent
  // render-system-no-camera failure in real app consumers.
  external: [
    '@forgeax/engine-ecs',
    '@forgeax/engine-math',
    '@forgeax/engine-pack',
  ],
});
