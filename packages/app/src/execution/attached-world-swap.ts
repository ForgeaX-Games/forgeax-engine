import type { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';

/** Serialize realm rebuilds so candidate Worlds never overlap ownership. */
export class SerializedRebuildQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(action: () => Promise<void>): Promise<void> {
    const current = this.tail.then(action, action);
    this.tail = current.catch(() => undefined);
    return current;
  }
}

/** Transactionally replace one Renderer-attached World. */
export async function commitAttachedWorld(
  renderer: Pick<Renderer, 'attachWorld' | 'detachWorld'>,
  previousWorld: World | undefined,
  nextWorld: World,
  initializeCandidate: () => Promise<boolean>,
): Promise<boolean> {
  const attached = renderer.attachWorld(nextWorld);
  if (!attached.ok) throw attached.error;
  try {
    if (!(await initializeCandidate())) {
      renderer.detachWorld(nextWorld);
      return false;
    }
  } catch (cause) {
    renderer.detachWorld(nextWorld);
    throw cause;
  }
  if (previousWorld !== undefined) renderer.detachWorld(previousWorld);
  return true;
}
