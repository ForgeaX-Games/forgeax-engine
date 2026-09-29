#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeHdr } from '@forgeax/engine-image';
import { integrateDiffuseEnvironment } from './reference-ibl.mjs';

// Contributor fixture only; this is not a player or SDK asset dependency.
const source = 'forgeax-engine-assets/learn-opengl/textures/newport_loft.hdr';
const bytes = readFileSync(new URL(`../../../../${source}`, import.meta.url));
const decoded = decodeHdr(bytes);
if (!decoded.ok) throw new Error(JSON.stringify(decoded.error));
const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const values = integrateDiffuseEnvironment(decoded.value, normals);
const expected = {
  generator: 'reference-environment-generator.mjs',
  source,
  sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  width: decoded.value.width,
  height: decoded.value.height,
  convention: 'u=atan2(z,x)/(2*pi)+0.5; v=asin(y)/pi+0.5',
  metric: 'diffuse-irradiance-divided-by-pi',
  directions: normals.map((normal, index) => ({ normal, value: values[index].map((value) => Number(value.toFixed(12))) })),
};
if (process.argv.includes('--check')) {
  const actual = JSON.parse(readFileSync(new URL('./reference-environment.json', import.meta.url), 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Source environment reference differs from quadrature');
  console.log('source environment reference verified: 6 directions');
} else {
  console.log(JSON.stringify(expected, null, 2));
}
