#!/usr/bin/env node
// setup-fbx-sdk.mjs — one-shot opt-in installer for the Autodesk FBX SDK 2020.3.7
// + native binding build, mirroring the CI steps in .github/workflows/ci.yml.
//
// Why opt-in (not postinstall): most contributors never touch FBX. Hard-failing
// install when FBX_SDK_ROOT is unset would tax every fresh worktree / CI runner /
// community PR (see docs/specs/2026-06-15-fbx-importer-via-sdk-design.md
// "Graceful-degrade postinstall"). This script is the discoverable "I want FBX"
// path: run it once, then `@forgeax/engine-fbx` and the hello-fbx-* demos work.
//
// Usage:
//   node scripts/setup-fbx-sdk.mjs          # download + extract + build
//   pnpm fbx:setup                          # same, via package.json script
//
// macOS arm64/x64 only today (the SDK URL is the clang-mac package). On other
// platforms it prints the manual steps and exits 0.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SDK_HOME = join(homedir(), '.local', 'fbxsdk');
const SDK_CURRENT = join(SDK_HOME, 'current');
const SDK_URL =
  'https://damassets.autodesk.net/content/dam/autodesk/www/files/fbx202037_fbxsdk_clang_mac.pkg.tgz';

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function alreadyInstalled() {
  return existsSync(join(SDK_CURRENT, 'include', 'fbxsdk.h'));
}

function buildBinding() {
  console.log(`\n[fbx-setup] Building native binding against FBX_SDK_ROOT=${SDK_CURRENT}`);
  run('npx node-gyp rebuild', {
    cwd: join(REPO_ROOT, 'packages', 'fbx'),
    env: { ...process.env, FBX_SDK_ROOT: SDK_CURRENT },
  });
  console.log(
    '\n[fbx-setup] Done. The binding lives at packages/fbx/build/Release/fbx_binding.node',
  );
  console.log(
    '[fbx-setup] Export FBX_SDK_ROOT so future `pnpm rebuild @forgeax/engine-fbx` works:',
  );
  console.log(`             export FBX_SDK_ROOT="${SDK_CURRENT}"`);
}

if (platform() !== 'darwin') {
  console.warn(
    '[fbx-setup] Automated install supports macOS only.\n' +
      '  1. Download the FBX SDK 2020.3.7 for your OS from https://aps.autodesk.com/developer/overview/fbx-sdk\n' +
      '  2. export FBX_SDK_ROOT=/path/to/sdk\n' +
      '  3. pnpm rebuild @forgeax/engine-fbx',
  );
  process.exit(0);
}

if (alreadyInstalled()) {
  console.log(`[fbx-setup] FBX SDK already present at ${SDK_CURRENT}; rebuilding binding only.`);
  buildBinding();
  process.exit(0);
}

const tgz = '/tmp/fbxsdk.tgz';
const work = '/tmp/fbxsdk';
console.log(`[fbx-setup] Downloading FBX SDK 2020.3.7 (~91 MB) ...`);
run(`curl -L --fail -o ${tgz} "${SDK_URL}"`);
run(`mkdir -p ${work} && tar -xzf ${tgz} -C ${work}`);
run(`pkgutil --expand ${work}/fbx202037_fbxsdk_clang_macos.pkg ${work}/expanded`);
run(`mkdir -p "${SDK_HOME}"`);
run(`cat ${work}/expanded/Root.pkg/Payload | gunzip -dc | cpio -i`, { cwd: SDK_HOME });
run(`ln -sfn "${SDK_HOME}/Applications/Autodesk/FBX SDK/2020.3.7" "${SDK_CURRENT}"`);
// Fix an upstream header typo that breaks clang compilation (same as CI).
run(
  `sed -i.bak 's/mLefttChild/mLeftChild/g' "${SDK_CURRENT}/include/fbxsdk/core/base/fbxredblacktree.h"`,
);

if (!alreadyInstalled()) {
  console.error('[fbx-setup] Extraction finished but fbxsdk.h not found; aborting.');
  process.exit(1);
}

buildBinding();
