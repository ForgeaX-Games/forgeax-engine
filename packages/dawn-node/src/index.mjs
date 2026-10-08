import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const isMac = process.platform === 'darwin';
const require = createRequire(import.meta.url);
const provider = require(
  isMac
    ? fileURLToPath(new URL(`../dist/native/darwin-${process.arch}.dawn.node`, import.meta.url))
    : 'upstream-webgpu',
);
export const { create, globals } = provider;
