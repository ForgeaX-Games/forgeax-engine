import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import {
  nativeModuleIdentity,
  nativeModuleKey,
  resolveNativeModuleKey,
} from '../build/native-module-identity.js';

it('hashes and restores declared npm dependencies whose names also identify Node builtins', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-native-builtin-name-'));
  try {
    const owner = resolve(root, 'node_modules/owner');
    const dependency = resolve(owner, 'node_modules/punycode');
    await mkdir(dependency, { recursive: true });
    await writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({
        name: 'project',
        version: '1.0.0',
        dependencies: { owner: '1.0.0' },
      }),
    );
    await writeFile(
      resolve(owner, 'package.json'),
      JSON.stringify({
        name: 'owner',
        version: '1.0.0',
        dependencies: { punycode: '1.0.0' },
      }),
    );
    await writeFile(resolve(owner, 'index.cjs'), "module.exports = require('punycode/');");
    await writeFile(
      resolve(dependency, 'package.json'),
      JSON.stringify({
        name: 'punycode',
        version: '1.0.0',
        main: 'index.cjs',
        exports: { '.': './index.cjs' },
      }),
    );
    const entry = resolve(dependency, 'index.cjs');
    await writeFile(entry, 'module.exports = 1;');
    expect(createRequire(resolve(owner, 'package.json')).resolve.paths('punycode')).toBeNull();
    const ownerUrl = pathToFileURL(resolve(owner, 'index.cjs')).href;
    const first = await nativeModuleIdentity(ownerUrl);
    const url = pathToFileURL(await realpath(entry)).href;
    const key = await nativeModuleKey(root, url);
    expect(await resolveNativeModuleKey(root, key)).toBe(url);
    await writeFile(entry, 'module.exports = 2;');
    expect(await nativeModuleIdentity(ownerUrl)).not.toBe(first);
    await rm(dependency, { recursive: true });
    await expect(nativeModuleIdentity(ownerUrl)).rejects.toThrow('owner -> punycode');
    await expect(resolveNativeModuleKey(root, key)).rejects.toThrow('punycode');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
