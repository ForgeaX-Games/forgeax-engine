import { defineConfig } from 'vite';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

export default defineConfig({ plugins: [forgeaxShader()] });
