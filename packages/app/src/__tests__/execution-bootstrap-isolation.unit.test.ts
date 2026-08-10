import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { loadBootstrapEntry, runBootstrapEntry } from '../execution';

describe('bootstrap entry isolation', () => {
  it('loads one default function and receives the realm-local World only', async () => {
    const url =
      'data:text/javascript,export default function(world){world.insertResource(%22bootstrapped%22,true)}';
    const world = new World();
    expect((await runBootstrapEntry(url, world)).ok).toBe(true);
    expect(world.getResource('bootstrapped')).toBe(true);
  });

  it('resolves schedule identity from the realm-local World', async () => {
    const url = `data:text/javascript,export default function(world){world.addSystem(world.scheduleToken('Update'),{name:'module-system',queries:[],fn(){}}).unwrap()}`;
    const world = new World();
    expect((await runBootstrapEntry(url, world)).ok).toBe(true);
    expect(world.inspect().scheduleSystemCount(world.scheduleToken('Update'))).toBe(1);
  });

  it('rejects a missing default export structurally', async () => {
    const result = await loadBootstrapEntry('data:text/javascript,export const value=1');
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'app-execution-bootstrap-failed') {
      expect(result.error.detail.phase).toBe('export');
    }
  });
});
