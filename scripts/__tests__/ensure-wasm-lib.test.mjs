import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureWasm } from '../lib/ensure-wasm-lib.mjs';

const tempRoots = [];

async function tempPkgDir() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-ensure-wasm-'));
  tempRoots.push(root);
  const pkg = join(root, 'pkg');
  await mkdir(pkg);
  return pkg;
}

const CFG = {
  pkgLabel: 'fbx',
  skipEnv: 'FORGEAX_SKIP_FBX_WASM_FETCH',
  fetchScript: '/fixture/fetch-wasm.mjs',
  buildHint: 'pnpm -F @forgeax/engine-fbx fetch-wasm',
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ensureWasm (shared lib)', () => {
  it('skips fetching when every presence marker exists', async () => {
    const pkg = await tempPkgDir();
    await Promise.all([writeFile(join(pkg, 'a.wasm'), ''), writeFile(join(pkg, 'b.wasm'), '')]);
    const spawn = vi.fn();
    const log = vi.fn();

    expect(
      ensureWasm({
        ...CFG,
        presenceMarkers: [join(pkg, 'a.wasm'), join(pkg, 'b.wasm')],
        spawn,
        log,
      }),
    ).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already present'));
  });

  it('honors the explicit fetch opt-out before starting a child process', async () => {
    const pkg = await tempPkgDir();
    const spawn = vi.fn();
    const log = vi.fn();

    expect(
      ensureWasm({
        ...CFG,
        presenceMarkers: [join(pkg, 'missing.wasm')],
        env: { FORGEAX_SKIP_FBX_WASM_FETCH: '1' },
        spawn,
        log,
      }),
    ).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('FORGEAX_SKIP_FBX_WASM_FETCH'));
  });

  it('invokes the fetcher when a marker is missing', async () => {
    const pkg = await tempPkgDir();
    await writeFile(join(pkg, 'a.wasm'), '');
    const spawn = vi.fn(() => ({ status: 0 }));

    expect(
      ensureWasm({
        ...CFG,
        presenceMarkers: [join(pkg, 'a.wasm'), join(pkg, 'missing.wasm')],
        env: {},
        spawn,
        log: vi.fn(),
      }),
    ).toBe(0);
    expect(spawn).toHaveBeenCalledWith(process.execPath, ['/fixture/fetch-wasm.mjs'], {
      stdio: 'inherit',
    });
  });

  it('keeps installation successful when fetching fails', async () => {
    const pkg = await tempPkgDir();
    const log = vi.fn();

    expect(
      ensureWasm({
        ...CFG,
        presenceMarkers: [join(pkg, 'missing.wasm')],
        env: {},
        spawn: vi.fn(() => ({ status: 1 })),
        log,
      }),
    ).toBe(0);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining('pnpm -F @forgeax/engine-fbx fetch-wasm'),
    );
  });
});
