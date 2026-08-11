import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import {
  loadBootstrapEntry,
  prepareBootstrapEntry,
  runPreparedBootstrap,
  validateExecutionBootstrapData,
} from '../execution';

const renderer = { assets: {} } as Renderer;

describe('execution bootstrap isolation', () => {
  it('prepares and runs a thick bootstrap against the realm-local owners', async () => {
    const url =
      'data:text/javascript,export default function(data){return {run(ctx){ctx.world.insertResource(%22bootstrapped%22,data.value);ctx.registerCleanup(()=>ctx.world.insertResource(%22cleaned%22,true));ctx.setPointerLockAllowed(false)}}}';
    const prepared = await prepareBootstrapEntry(url, { value: true });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const world = new World();
    const cleanup = vi.fn();
    const pointerLock = vi.fn();
    const ran = await runPreparedBootstrap(url, prepared.value, {
      world,
      renderer,
      assets: renderer.assets,
      data: { value: true },
      registerCleanup: cleanup,
      setPointerLockAllowed: pointerLock,
    });
    expect(ran.ok).toBe(true);
    expect(world.getResource('bootstrapped')).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(pointerLock).toHaveBeenCalledWith(false);
  });

  it('keeps schedule identity in the realm-local World', async () => {
    const url = `data:text/javascript,export default function(){return {run({world}){world.addSystem(world.scheduleToken('Update'),{name:'module-system',queries:[],fn(){}}).unwrap()}}}`;
    const prepared = await prepareBootstrapEntry(url, undefined);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const world = new World();
    const result = await runPreparedBootstrap(url, prepared.value, {
      world,
      renderer,
      assets: renderer.assets,
      data: undefined,
      registerCleanup: () => () => {},
      setPointerLockAllowed: () => {},
    });
    expect(result.ok).toBe(true);
    expect(world.inspect().scheduleSystemCount(world.scheduleToken('Update'))).toBe(1);
  });

  it('rejects a missing default export structurally', async () => {
    const result = await loadBootstrapEntry('data:text/javascript,export const value=1');
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'app-execution-bootstrap-failed') {
      expect(result.error.detail.phase).toBe('export');
    }
  });

  it('rejects non-cloneable bootstrap data before canvas transfer', () => {
    const result = validateExecutionBootstrapData(
      { callback: (() => {}) as never },
      'https://example.test/bootstrap.js',
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'app-execution-bootstrap-failed') {
      expect(result.error.detail.phase).toBe('data');
    }
  });
});
