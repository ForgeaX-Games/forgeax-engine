import { createWorldContext, World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import {
  executionBootstrapHostPlugin,
  loadBootstrapEntry,
  prepareBootstrapEntry,
  validateExecutionBootstrapData,
} from '../execution';

function moduleUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

describe('execution bootstrap isolation', () => {
  it('activates realm-local bootstrap plugins and disposes their effects', async () => {
    const url = moduleUrl(`export default function(data){return {plugins:[{
      name:'test-bootstrap',inject:['world','executionBootstrapHost'],apply(ctx){
        ctx.world.insertResource('bootstrapped',data.value);
        ctx.effect(()=>()=>ctx.world.insertResource('cleaned',true),'test/cleanup');
        ctx.executionBootstrapHost.setPointerLockAllowed(false);
      }
    }]}}`);
    const prepared = await prepareBootstrapEntry(url, { value: true });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const world = new World();
    const pointerLock = vi.fn();
    const close = vi.fn();
    const context = await createWorldContext(world, [
      executionBootstrapHostPlugin({
        port: { close } as unknown as MessagePort,
        setPointerLockAllowed: pointerLock,
      }),
      ...(prepared.value.plugins ?? []),
    ]);
    expect(world.getResource('bootstrapped')).toBe(true);
    expect(pointerLock).toHaveBeenCalledWith(false);
    await context.fiber.dispose();
    expect(world.getResource('cleaned')).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps schedule identity in the realm-local World', async () => {
    const url = moduleUrl(`export default function(){return {plugins:[{
      name:'module-system',inject:['world'],apply(ctx){
        const system={name:'module-system',queries:[],fn(){}};
        ctx.world.addSystem(ctx.world.scheduleToken('Update'),system).unwrap();
        ctx.effect(()=>()=>ctx.world.removeSystem(ctx.world.scheduleToken('Update'),system.name),'test/system');
      }
    }]}}`);
    const prepared = await prepareBootstrapEntry(url, undefined);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const world = new World();
    const context = await createWorldContext(world, prepared.value.plugins ?? []);
    expect(world.inspect().scheduleSystemCount(world.scheduleToken('Update'))).toBe(1);
    await context.fiber.dispose();
    expect(world.inspect().scheduleSystemCount(world.scheduleToken('Update'))).toBe(0);
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
