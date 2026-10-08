import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import {
  createScriptablePackModuleExecutorPool,
  loadScriptablePack,
  type ScriptablePackModuleExecutor,
} from '../scriptable-pack-node.js';

interface OwnedExecutor {
  readonly worker: Worker;
  readonly compileRootReady: Promise<string>;
  readonly compileRoot: string | undefined;
}

async function withPool(
  maxTasksPerWorker: number,
  run: (fixture: {
    readonly pool: ReturnType<typeof createScriptablePackModuleExecutorPool>;
    readonly acquire: () => Promise<ScriptablePackModuleExecutor>;
    readonly source: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'pack-executor-cleanup-'));
  const source = join(root, 'owner.pack.ts');
  const pool = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker });
  const owned = new Set<OwnedExecutor>();
  try {
    await writeFile(
      source,
      `export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(1),
        build: () => ({ ok: true, value: {} }) };`,
    );
    await run({
      pool,
      source,
      acquire: async () => {
        const executor = await pool.acquire();
        owned.add(executor as unknown as OwnedExecutor);
        return executor;
      },
    });
  } finally {
    // A failing cleanup assertion must not leave this test's real Worker or files behind.
    await pool.dispose();
    for (const executor of owned) {
      await executor.worker.terminate();
      await rm(await executor.compileRootReady, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function load(source: string, executor: ScriptablePackModuleExecutor) {
  const loaded = await loadScriptablePack(source, { executor });
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

async function build(definition: Awaited<ReturnType<typeof load>>) {
  expect(
    await definition.build({
      packageId: definition.packageId,
      readByGuid: async () => {
        throw new Error('unexpected content read');
      },
    } as never),
  ).toEqual({ ok: true, value: {} });
}

async function expectRetired(
  executor: ScriptablePackModuleExecutor,
  compileRoot: string,
  pool: ReturnType<typeof createScriptablePackModuleExecutorPool>,
) {
  expect((executor as unknown as OwnedExecutor).worker.threadId).toBe(-1);
  await expect(stat(compileRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((pool as unknown as { readonly executors: Set<unknown> }).executors.size).toBe(0);
}

it('terminates the reusable Worker and removes its compiled directory after successful pool shutdown', async () => {
  await withPool(32, async ({ pool, acquire, source }) => {
    const executor = await acquire();
    await build(await load(source, executor));
    const owned = executor as unknown as OwnedExecutor;
    const compileRoot = await owned.compileRootReady;
    expect(owned.worker.threadId).toBeGreaterThan(0);
    expect((await stat(compileRoot)).isDirectory()).toBe(true);
    await pool.dispose();
    await expectRetired(executor, compileRoot, pool);
  });
});

it('escalates a same-turn complete disposal to failure when the pool shuts down', async () => {
  await withPool(32, async ({ pool, acquire, source }) => {
    const executor = await acquire();
    await load(source, executor);
    const compileRoot = await (executor as unknown as OwnedExecutor).compileRootReady;
    const complete = executor.dispose?.('complete');
    const shutdown = pool.dispose();
    await Promise.all([complete, shutdown]);
    await expectRetired(executor, compileRoot, pool);
  });
});

it('hands a queued lease the same Worker and really retires it at the second task limit', async () => {
  await withPool(2, async ({ pool, acquire, source }) => {
    const first = await acquire();
    const definition = await load(source, first);
    const compileRoot = await (first as unknown as OwnedExecutor).compileRootReady;
    const queued = acquire();
    await build(definition);
    const second = await queued;
    expect(second).toBe(first);
    expect((second as unknown as OwnedExecutor).worker.threadId).toBeGreaterThan(0);
    await build(await load(source, second));
    await expectRetired(second, compileRoot, pool);
    await pool.dispose();
  });
});
