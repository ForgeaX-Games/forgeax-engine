import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { watchDevRoots } from '../dev/watcher.js';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for the watcher event');
}

describe('dev watcher and HMR intake', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('classifies a missing root as an observed diagnostic', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'forgeax-watcher-missing-parent-')), 'missing');
    roots.push(root.slice(0, root.lastIndexOf('/')));
    const errors: Array<{ phase: string; root?: string }> = [];
    const stop = watchDevRoots({
      roots: [root],
      onBatch: async () => {},
      onError: (_error, context) => {
        errors.push(context);
      },
    });
    await waitFor(() => errors.some((error) => error.phase === 'missing-root'));
    stop();
    expect(errors).toContainEqual({ phase: 'missing-root', root });
  });

  it('observes onBatch rejection instead of leaking an async flush', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-watcher-rejection-'));
    roots.push(root);
    const source = join(root, 'scene.gltf');
    await writeFile(source, '{"version":1}');
    const errors: Array<{ phase: string; root?: string }> = [];
    const stop = watchDevRoots({
      roots: [root],
      debounceMs: 10,
      onBatch: async () => {
        throw new Error('batch rejected');
      },
      onError: (_error, context) => {
        errors.push(context);
      },
    });
    await writeFile(source, '{"version":2,"changed":true}');
    await waitFor(() => errors.some((error) => error.phase === 'flush'));
    stop();
    expect(errors.some((error) => error.phase === 'flush')).toBe(true);
  });
});
