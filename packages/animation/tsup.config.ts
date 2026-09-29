import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/target-id.ts', 'src/animated-bounds.ts'],
  format: ['esm'],
  dts: false,
  clean: false,
  outDir: 'dist',
  sourcemap: true,
  outExtension: () => ({ js: '.mjs' }),
});
