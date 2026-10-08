import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeHead = '2f5fb632d9d9db9bcb3705bd868de69a6a2ae4e2';
const dawnHead = 'c5d549e250b9225744929ae860b369cb4304a767';
const patchSHA = 'bb1dc69fe563a1d77a1024c345caf021615e023ddac4bbf9a71061f23b24400c';
const patchedFiles = {
  'src/dawn/native/metal/DeviceMTL.h': '28810f496ab334abc7f11fd1d9dcb0cd822b4a35d3ce65e23693cde84b0567c6',
  'src/dawn/native/metal/DeviceMTL.mm': 'b81701dfd05820a27040abd3996897a3bb09efadd43d11edd8814894f691f5ff',
  'src/dawn/native/metal/CommandBufferMTL.mm': '374629b226a11dcc737f506aba20fffa7f5edec7ac0c497ad3769c8afc200678',
};
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`dawn-native-producer-failed:${command}:${result.status}`);
}
function git(path, args) {
  const result = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error ?? new Error('dawn-native-source-git-failed');
  return result.stdout.trim();
}
function verifyOfficialSource(source, dawn) {
  if (git(source, ['rev-parse', 'HEAD']) !== nodeHead || git(dawn, ['rev-parse', 'HEAD']) !== dawnHead) throw new Error('dawn-native-source-head-mismatch');
  // Official gclient may update the depot_tools gitlink; it may not change Node
  // producer/configuration source. Dawn is validated independently below.
  const nodeChanges = git(source, ['diff', 'HEAD', '--name-only']).split('\n').filter(Boolean);
  if (nodeChanges.some((path) => path !== 'third_party/dawn' && path !== 'third_party/depot_tools')) throw new Error('dawn-native-node-source-modification');
  const expectedPaths = Object.keys(patchedFiles).sort();
  const actualPaths = git(dawn, ['diff', 'HEAD', '--name-only']).split('\n').filter(Boolean).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error('dawn-native-unexpected-source-modification');
  for (const [path, digest] of Object.entries(patchedFiles)) if (sha(join(dawn, path)) !== digest) throw new Error(`dawn-native-patched-source-integrity:${path}`);
}
export async function prepareNative() {
  if (process.platform !== 'darwin') return;
  if (!['arm64', 'x64'].includes(process.arch)) throw new Error(`dawn-native-unsupported-architecture:${process.arch}`);
  const patch = resolve(root, 'patches/metal-empty-compute.patch');
  if (sha(patch) !== patchSHA) throw new Error('dawn-native-source-patch-integrity');
  const key = createHash('sha256').update(JSON.stringify({ nodeHead, dawnHead, patchSHA, arch: process.arch, producerSHA: sha(fileURLToPath(import.meta.url)) })).digest('hex');
  const native = resolve(root, `dist/native/darwin-${process.arch}.dawn.node`);
  const provenance = resolve(root, `dist/native/darwin-${process.arch}.provenance.json`);
  if (existsSync(native) && existsSync(provenance)) {
    const record = JSON.parse(readFileSync(provenance, 'utf8'));
    if (record.inputKey === key && record.nativeSHA256 === sha(native)) return;
  }
  const cache = resolve(root, '.native-build', key);
  mkdirSync(cache, { recursive: true });
  const source = process.env.FORGEAX_DAWN_NATIVE_SOURCE_DIR ? resolve(process.env.FORGEAX_DAWN_NATIVE_SOURCE_DIR) : join(cache, 'node-webgpu');
  if (!existsSync(join(source, '.git'))) {
    if (process.env.FORGEAX_DAWN_NATIVE_SOURCE_DIR) throw new Error('dawn-native-explicit-source-unavailable');
    run('git', ['clone', '--no-checkout', 'https://github.com/dawn-gpu/node-webgpu.git', source], cache, process.env);
    run('git', ['checkout', '--detach', nodeHead], source, process.env);
    run('git', ['submodule', 'update', '--init'], source, process.env);
  }
  const dawn = join(source, 'third_party/dawn');
  if (git(source, ['rev-parse', 'HEAD']) !== nodeHead || git(dawn, ['rev-parse', 'HEAD']) !== dawnHead) throw new Error('dawn-native-source-head-mismatch');
  const dirty = git(dawn, ['diff', 'HEAD', '--name-only']);
  if (!dirty) run('git', ['apply', '--whitespace=error', patch], dawn, process.env);
  verifyOfficialSource(source, dawn);
  const tools = join(source, 'third_party/depot_tools');
  const env = { ...process.env, PATH: `${tools}:${process.env.PATH}:${join(dawn, 'third_party/ninja')}`, DEPOT_TOOLS_WIN_TOOLCHAIN: '0' };
  {
    const standalone = readFileSync(join(dawn, 'scripts/standalone-with-node.gclient'), 'utf8');
    const marker = '"custom_vars" : {';
    if (!standalone.includes(marker)) throw new Error('dawn-native-standalone-contract-mismatch');
    writeFileSync(join(dawn, '.gclient'), standalone.replace(marker, '"custom_deps" : {"third_party/swiftshader": None},\n    '+marker));
    run(join(tools, 'gclient'), ['metrics', '--opt-out'], dawn, env);
    run(join(tools, 'gclient'), ['sync', '--no-history'], dawn, env);
  }
  verifyOfficialSource(source, dawn);
  const output = process.env.FORGEAX_DAWN_NATIVE_BUILD_DIR ? resolve(process.env.FORGEAX_DAWN_NATIVE_BUILD_DIR) : join(cache, 'build'); mkdirSync(output, { recursive: true });
  const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
  run('cmake', [dawn, '-GNinja', '-DDAWN_BUILD_NODE_BINDINGS=1', '-DDAWN_USE_X11=OFF', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_CXX_VISIBILITY_PRESET=hidden', '-DCMAKE_VISIBILITY_INLINES_HIDDEN=1', `-DCMAKE_OSX_ARCHITECTURES=${arch}`, '-DCMAKE_OSX_SYSROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'], output, env);
  run(join(tools, 'ninja'), ['-j2', 'dawn.node'], output, env);
  verifyOfficialSource(source, dawn);
  const archResult = spawnSync('lipo', ['-archs', join(output, 'dawn.node')], { encoding: 'utf8' });
  if (archResult.status !== 0 || archResult.stdout.trim() !== arch) throw new Error('dawn-native-built-architecture-mismatch');
  mkdirSync(dirname(native), { recursive: true });
  const temporary = `${native}.new-${process.pid}`;
  copyFileSync(join(output, 'dawn.node'), temporary);renameSync(temporary, native);
  writeFileSync(provenance, `${JSON.stringify({ inputKey: key, nodeHead, dawnHead, patchSHA, architecture: process.arch, nativeSHA256: sha(native) }, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await prepareNative();
