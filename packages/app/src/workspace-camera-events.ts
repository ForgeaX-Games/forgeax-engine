import type { CanvasInputBoundary } from '@forgeax/engine-input';
import type { EngineWorkspaceCameraResult, EngineWorkspacePreview } from './workspace';

/** Same camera transactions, with input sampled in the game document rather than its parent. */
export function bindWorkspaceCameraEvents(
  canvas: HTMLCanvasElement,
  input: CanvasInputBoundary,
  target: EngineWorkspacePreview,
) {
  const win = canvas.ownerDocument.defaultView;
  const previousTabIndex = canvas.getAttribute('tabindex');
  if (previousTabIndex === null) canvas.tabIndex = 0;
  let interaction: { interactionId: string; expectedVersion: number } | undefined;
  let dragging = false;
  const held = new Set<string>();
  let disposed = false;
  let queue = Promise.resolve();
  const identity = { targetId: target.target.targetId, clientId: 'engine-browser-tools' };
  const finish = async (abort = false) => {
    held.clear();
    const current = interaction;
    interaction = undefined;
    if (!current) return;
    if (abort) await target.abortCameraInteraction?.({ ...identity, ...current });
    else await target.commitCamera?.({ ...identity, ...current, operationId: crypto.randomUUID() });
  };
  const enqueue = (run: () => unknown | Promise<unknown>) => {
    queue = queue
      .then(async () => {
        if (!disposed) await run();
      })
      .catch(async () => {
        dragging = false;
        await finish(true).catch(() => {});
      });
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 2 || input.owner() !== 'editor') return;
    event.preventDefault();
    dragging = true;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    enqueue(async () => {
      const state = (await target.getCamera(identity)) as EngineWorkspaceCameraResult;
      const next = { interactionId: crypto.randomUUID(), expectedVersion: state.version ?? 0 };
      await target.beginCameraInteraction?.({
        ...identity,
        ...next,
        baseVersion: next.expectedVersion,
      });
      interaction = next;
    });
  };
  const sample = (value: unknown) =>
    enqueue(async () => {
      if (interaction)
        await target.updateCameraDraft?.({ ...identity, ...interaction, input: value });
    });
  const move = (event: PointerEvent) => {
    if (dragging)
      sample({ type: 'look', yaw: -event.movementX * 0.003, pitch: -event.movementY * 0.003 });
  };
  const up = () => {
    dragging = false;
    enqueue(() => finish());
  };
  const blur = () => {
    dragging = false;
    enqueue(() => finish(true));
  };
  const key = (event: KeyboardEvent) => {
    if (!dragging || !['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(event.code)) return;
    event.preventDefault();
    if (event.type === 'keydown') held.add(event.code);
    else held.delete(event.code);
    const axes = [
      Number(held.has('KeyD')) - Number(held.has('KeyA')),
      Number(held.has('KeyE')) - Number(held.has('KeyQ')),
      Number(held.has('KeyS')) - Number(held.has('KeyW')),
    ];
    const length = Math.hypot(...axes) || 1;
    sample({ type: 'move', velocity: axes.map((value) => (value * 4) / length) });
  };
  const menu = (event: Event) => {
    if (input.owner() === 'editor') event.preventDefault();
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('contextmenu', menu);
  win?.addEventListener('pointerup', up);
  win?.addEventListener('blur', blur);
  win?.addEventListener('keydown', key);
  win?.addEventListener('keyup', key);
  return async () => {
    disposed = true;
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('contextmenu', menu);
    win?.removeEventListener('pointerup', up);
    win?.removeEventListener('blur', blur);
    win?.removeEventListener('keydown', key);
    win?.removeEventListener('keyup', key);
    if (previousTabIndex === null) canvas.removeAttribute('tabindex');
    else canvas.setAttribute('tabindex', previousTabIndex);
    await queue;
    await finish(true);
  };
}
