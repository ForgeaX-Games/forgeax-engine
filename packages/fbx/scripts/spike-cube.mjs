import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const binding = require('../build/Release/fbx_binding.node');
const t0 = performance.now();
const json = binding.parseFbx('packages/fbx/test/fixtures/cube.fbx');
const wallMs = performance.now() - t0;
const obj = JSON.parse(json);
console.log(JSON.stringify({ vertices: obj.vertices?.length, indices: obj.indices?.length, wallMs }));