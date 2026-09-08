#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(appRoot, '../..');
const appRustRoot = resolve(appRoot, 'src-tauri');
const nativeRoot = resolve(repoRoot, 'packages/rhi-wgpu-native');

function filesUnder(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const target = resolve(root, name);
    if (statSync(target).isDirectory()) files.push(...filesUnder(target));
    else files.push(target);
  }
  return files;
}

const appFiles = filesUnder(appRustRoot).filter((file) => file.endsWith('.rs'));
const leaked = appFiles.filter((file) => /\b(?:use\s+wgpu|wgpu::)/u.test(readFileSync(file, 'utf8')));
if (leaked.length > 0) {
  throw new Error(`app owns raw wgpu symbols: ${leaked.join(', ')}`);
}

const appCargo = readFileSync(resolve(appRustRoot, 'Cargo.toml'), 'utf8');
if (/^wgpu\s*=/mu.test(appCargo)) throw new Error('app declares a direct wgpu dependency');

const required = [
  ['Cargo.toml', '=30.0.0'],
  ['Cargo.toml', 'target_os = "macos"'],
  ['Cargo.toml', 'features = ["metal"]'],
  ['Cargo.toml', 'target_os = "windows", target_os = "linux"'],
  ['Cargo.toml', 'features = ["vulkan"]'],
  ['src/device.rs', 'wgpu::Backends::METAL'],
  ['src/device.rs', 'wgpu::Backends::VULKAN'],
  ['src/device.rs', 'EXPERIMENTAL_RAY_QUERY'],
  ['src/device.rs', 'wgpu::ExperimentalFeatures::enabled()'],
  ['src/ray_query.rs', 'create_blas'],
  ['src/ray_query.rs', 'create_tlas'],
  ['src/shaders/ray_query_triangle.wgsl', 'enable wgpu_ray_query'],
  ['src/shaders/ray_query_triangle.wgsl', 'rayQueryProceed'],
];
for (const [relativePath, needle] of required) {
  const file = resolve(nativeRoot, relativePath);
  if (!existsSync(file) || !readFileSync(file, 'utf8').includes(needle)) {
    throw new Error(`native owner invariant missing: ${relativePath} -> ${needle}`);
  }
}

process.stdout.write('native Ray Query ownership: ok\n');
