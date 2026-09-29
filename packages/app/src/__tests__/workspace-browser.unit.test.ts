import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, Update, World } from '@forgeax/engine-ecs';
import { Camera, SceneInstance } from '@forgeax/engine-render';
import { ChildOf, Children, GlobalTransform, Name, Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import {
  publishBrowserFrameCompleted,
  publishBrowserFrameSubmitted,
} from '../browser-frame-signal';
import { createAppObservation } from '../observation';
import type { App } from '../types';
import { engineWorkspaceBrowserPlugin } from '../workspace-browser';

const guid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('workspace browser plugin lifecycle', () => {
  it('dispatches actual World tools and revokes its handler and borrowed preview through the Fiber', async () => {
    const world = new World();
    for (const component of [Camera, SceneInstance, ChildOf, Children, GlobalTransform, Transform])
      world.components.register(component).unwrap();
    const entity = world.spawn({ component: Name, data: { value: 'Persistent' } }).unwrap();
    const assets = new AssetRegistry({} as never);
    assets.catalog(guid, { kind: 'scene', entities: { root: { components: {} } } }).unwrap();
    const setInputAllowed = vi.fn();
    const app = {
      world,
      assets,
      input: { setInputAllowed },
      observation: createAppObservation(world, {} as never, { report: () => ({}) }),
      start: vi.fn(() => ({ unwrap() {} })),
      resume: vi.fn(() => ({ unwrap() {} })),
      pause: vi.fn(() => ({ unwrap() {} })),
      onError: vi.fn(() => () => {}),
    } as unknown as App;
    const dataset: Record<string, string> = {};
    const frameEvents = new EventTarget();
    const capturePixels = vi.fn(() => 'data:image/png;base64,new-size');
    const canvas = {
      getAttribute: () => null,
      removeAttribute() {},
      addEventListener: frameEvents.addEventListener.bind(frameEvents),
      removeEventListener: frameEvents.removeEventListener.bind(frameEvents),
      dispatchEvent: frameEvents.dispatchEvent.bind(frameEvents),
      toDataURL: capturePixels,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
      ownerDocument: {
        documentElement: {
          dataset,
          removeAttribute: () => {
            delete dataset.forgeaxWorkspaceReady;
          },
        },
        defaultView: { devicePixelRatio: 2, addEventListener() {}, removeEventListener() {} },
      },
      style: {},
      width: 0,
      height: 0,
    } as unknown as HTMLCanvasElement;
    Object.assign(canvas.ownerDocument, {
      body: { append() {} },
      createElement: () => ({
        ownerDocument: canvas.ownerDocument,
        style: {},
        append() {},
        remove() {},
      }),
    });
    const context = await createWorldContext(world);
    const listeners = new Set<(value: unknown) => void>();
    let releaseFrame = () => {};
    let draining = false;
    const destroyed: string[] = [];
    const replies = new Map<string, (value: Record<string, unknown>) => void>();
    const failures: Record<string, unknown>[] = [];
    const pickErrors: Record<string, unknown>[] = [];
    const picked: Record<string, unknown>[] = [];
    const transport = {
      async request(_service: string, payload: unknown) {
        const value = payload as Record<string, unknown>;
        if (value.kind === 'failed') failures.push(value);
        if (value.kind === 'pick-error') pickErrors.push(value);
        if (value.kind === 'picked') picked.push(value);
        replies.get(String(value.id))?.(value);
        return {};
      },
      subscribe(_topic: string, onValue: (value: unknown) => void) {
        listeners.add(onValue);
        return () => {
          listeners.delete(onValue);
        };
      },
    };
    let counter = 0;
    const command = (operation: string, input: unknown) => {
      const id = String(++counter);
      const result = new Promise<Record<string, unknown>>((resolve) => replies.set(id, resolve));
      for (const listener of [...listeners])
        listener({ kind: 'command', id, sessionId: 'session', operation, input });
      return result;
    };
    try {
      for (let cycle = 0; cycle < 10; cycle++) {
        const fiber = await context.plugin(engineWorkspaceBrowserPlugin, {
          app,
          canvas,
          transport,
          async createPreviewApp({ context: scope }) {
            const childWorld = new World();
            for (const component of [
              Camera,
              SceneInstance,
              ChildOf,
              Children,
              GlobalTransform,
              Transform,
            ])
              childWorld.components.register(component).unwrap();
            const owner = await scope.plugin({
              name: 'test-preview-renderer-and-world',
              provide: ['world'],
              apply(ctx) {
                ctx.provide('world', childWorld);
                ctx.effect(() => () => {
                  destroyed.push(childWorld.identity);
                });
              },
            });
            const frame = new Promise<void>((resolve) => {
              releaseFrame = resolve;
            });
            return {
              ...app,
              world: childWorld,
              observation: createAppObservation(childWorld, {} as never, { report: () => ({}) }),
              async dispose() {
                draining = true;
                await frame;
                await owner.dispose();
                return { ok: true, value: undefined };
              },
            } as App;
          },
          project: { id: 'project', root: '/project' },
          target: {
            targetId: 'target',
            sessionId: 'session',
            worldId: world.identity,
            width: 320,
            height: 240,
            headed: true,
          },
        });
        await fiber.await();
        expect(dataset.forgeaxWorkspaceReady).toBe('true');
        const tools = context.engineWorkspaceTargetTools;
        expect(tools?.pick).toBeTypeOf('function');
        if (!tools?.pick) throw new Error('Expected the actual target tools');
        const pickSpy = vi.spyOn(tools, 'pick');
        if (cycle === 0) {
          const missing = await command('openPreview', {
            asset: { guid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'scene' },
            width: 320,
            height: 240,
          });
          expect(missing).toMatchObject({
            ok: false,
            error: {
              code: expect.not.stringContaining('browser-failure'),
              hint: expect.not.stringContaining('[object Object]'),
            },
          });
        }
        const opened = await command('openPreview', {
          asset: { guid, kind: 'scene' },
          width: 320,
          height: 240,
        });
        expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
        const previewOwner = (opened.value as { previewOwner: string }).previewOwner;
        if (cycle === 0) {
          const click = Object.assign(new Event('click'), { button: 0, clientX: 10, clientY: 10 });
          expect(() => frameEvents.dispatchEvent(click)).not.toThrow();
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(pickSpy).not.toHaveBeenCalled();
          expect(
            await command('target.pick', { x: 10, y: 10, targetId: 'target', previewOwner }),
          ).toMatchObject({
            ok: false,
            error: {
              code: 'engine-workspace-frame-unavailable',
              detail: { reason: 'missing-frame' },
            },
          });
          expect(failures).toEqual([]);
          pickSpy.mockRejectedValueOnce(new Error('async-pick-failure'));
          expect(
            await command('target.pick', { x: 10, y: 10, targetId: 'target', previewOwner }),
          ).toMatchObject({
            ok: false,
            error: { code: 'engine-workspace-browser-failure', hint: 'async-pick-failure' },
          });
          expect(failures).toEqual([]);
          expect(pickErrors).toEqual([]);
          expect(picked).toEqual([]);
        }
        expect(
          await command('target.control', { targetId: 'target', previewOwner, mode: 'player' }),
        ).toMatchObject({ ok: false, error: { code: 'engine-workspace-capability-unavailable' } });
        if (cycle === 0) publishBrowserFrameSubmitted(canvas, { frameId: 1, deviceGeneration: 0 });
        const resized = await command('resize', {
          targetId: 'target',
          previewOwner,
          width: 400,
          height: 300,
        });
        expect(resized).toMatchObject({
          ok: true,
          value: { target: { width: 400, height: 300, worldId: world.identity } },
        });
        expect([canvas.width, canvas.height]).toEqual([400, 300]);
        if (cycle === 0) {
          const capture = command('capture', { targetId: 'target', previewOwner });
          publishBrowserFrameCompleted(canvas, {
            frameId: 1,
            deviceGeneration: 0,
            presentation: 'ready',
          });
          publishBrowserFrameSubmitted(canvas, { frameId: 2, deviceGeneration: 0 });
          await new Promise((resolve) => setTimeout(resolve, 40));
          expect(capturePixels).not.toHaveBeenCalled();
          publishBrowserFrameCompleted(canvas, {
            frameId: 2,
            deviceGeneration: 0,
            presentation: 'ready',
          });
          expect(await capture).toMatchObject({
            ok: true,
            value: { frameId: 2, width: 400, height: 300 },
          });
          expect(capturePixels).toHaveBeenCalledOnce();
        }
        expect([canvas.style.width, canvas.style.height]).toEqual(['200px', '150px']);
        expect(
          await command('resize', { targetId: 'target', previewOwner, width: 0, height: 300 }),
        ).toMatchObject({ ok: false });
        expect(canvas.width).toBe(400);
        const selected = await command('entity.inspect', {
          targetId: 'target',
          previewOwner,
          entityId: `target:${world.identity}:${entity}`,
        });
        expect(selected).toMatchObject({
          ok: true,
          value: { name: 'Persistent', worldId: world.identity },
        });
        const stale = await command('entity.inspect', {
          targetId: 'target',
          previewOwner: 'stale',
          entityId: `target:${world.identity}:${entity}`,
        });
        expect(stale).toMatchObject({
          ok: false,
          error: { code: 'engine-workspace-target-stale' },
        });
        if (cycle === 0) {
          const child = await command('openPreview', {
            targetId: 'target',
            previewTargetId: 'child',
            asset: { guid, kind: 'scene' },
          });
          expect(child).toMatchObject({ ok: true, value: { target: { targetId: 'child' } } });
          const closing = command('closePreview', { targetId: 'child' });
          try {
            await vi.waitFor(() => expect(draining).toBe(true));
            expect(destroyed).toEqual([]);
          } finally {
            releaseFrame();
          }
          expect(await closing).toMatchObject({ ok: true });
          expect(destroyed).toHaveLength(1);
          expect(context.world).toBe(world);
          expect(await command('closePreview', { targetId: 'target', previewOwner })).toMatchObject(
            { ok: true },
          );
          expect(
            await command('target.pick', { x: 10, y: 10, targetId: 'target', previewOwner }),
          ).toMatchObject({ ok: false });
          expect(picked).toEqual([]);
          expect(pickErrors).toEqual([]);
        }
        if (cycle === 9) {
          world
            .addSystem(Update, {
              name: 'broken-game',
              queries: [],
              fn() {
                throw new Error('broken game');
              },
            })
            .unwrap();
          const update = world.update();
          expect(update.ok).toBe(false);
          const notify = vi.mocked(app.onError).mock.calls.at(-1)?.[0];
          if (!notify) throw new Error('The error listener must be installed');
          const error = {
            code: 'app-system-update-failed',
            expected: 'A healthy World',
            hint: 'Stop the failed run.',
          } as never;
          notify(error);
          notify(error);
          expect(failures).toEqual([
            expect.objectContaining({ kind: 'failed', targetId: 'target', error }),
          ]);
          world.removeSystem(Update, 'broken-game').unwrap();
        }
        expect(setInputAllowed).toHaveBeenCalledWith(false);
        await fiber.dispose();
        expect(setInputAllowed).toHaveBeenLastCalledWith(true);
        expect(listeners.size).toBe(0);
        expect(context.engineWorkspaceTargetTools).toBeUndefined();
        expect(dataset.forgeaxWorkspaceReady).toBeUndefined();
        expect(world.get(entity, Name).unwrap().value).toBe('Persistent');
        if (cycle < 9) expect([...world.query({}).unwrap()].length).toBe(1);
      }
      setInputAllowed.mockClear();
      const game = await context.plugin(engineWorkspaceBrowserPlugin, {
        app,
        canvas,
        transport,
        input: { owner: () => 'game', grantGame() {}, revokeGame() {} } as never,
        project: { id: 'project', root: '/project' },
        target: {
          targetId: 'game',
          sessionId: 'session',
          worldId: world.identity,
          width: 320,
          height: 240,
          headed: true,
        },
      });
      await game.await();
      expect(
        await command('resize', {
          targetId: 'game',
          previewOwner: 'session',
          width: 640,
          height: 360,
        }),
      ).toMatchObject({ ok: true, value: { target: { width: 640, height: 360 } } });
      expect([canvas.width, canvas.height]).toEqual([640, 360]);
      await game.dispose();
      expect(setInputAllowed).not.toHaveBeenCalled();
    } finally {
      await context.fiber.dispose();
    }
  });
});
