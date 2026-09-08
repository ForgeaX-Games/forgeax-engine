export interface LearnRenderTestApp {
  renderer: {
    dispose(): void;
  };
  dispose(): Promise<unknown>;
}

interface LearnRenderTestLifecycle {
  owner?: object | undefined;
  app?: LearnRenderTestApp | undefined;
  bootstraps: Map<object, Promise<unknown>>;
  pendingDisposal?: Promise<void> | undefined;
  disposalErrors: unknown[];
}

const LIFECYCLE_KEY = '__forgeaxLearnRenderTestLifecycle';

function lifecycle(): LearnRenderTestLifecycle {
  const scope = globalThis as typeof globalThis & {
    [LIFECYCLE_KEY]?: LearnRenderTestLifecycle;
  };
  const existing = scope[LIFECYCLE_KEY];
  if (existing !== undefined) return existing;
  const created: LearnRenderTestLifecycle = {
    bootstraps: new Map(),
    disposalErrors: [],
  };
  scope[LIFECYCLE_KEY] = created;
  return created;
}

async function disposeApp(app: LearnRenderTestApp): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    const result = await app.dispose();
    if (
      typeof result === 'object' &&
      result !== null &&
      (result as { ok?: unknown }).ok === false
    ) {
      failed = true;
      failure =
        (result as { error?: unknown }).error ??
        new Error('learn-render App disposal returned err');
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    app.renderer.dispose();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
}

function enqueueDisposal(state: LearnRenderTestLifecycle, app: LearnRenderTestApp): void {
  const previous = state.pendingDisposal;
  const disposal = previous === undefined ? disposeApp(app) : previous.then(() => disposeApp(app));
  const next = disposal.catch((error: unknown) => {
    state.disposalErrors.push(error);
  });
  state.pendingDisposal = next;
}

async function drainDisposals(state: LearnRenderTestLifecycle): Promise<void> {
  while (state.pendingDisposal !== undefined) {
    const pending = state.pendingDisposal;
    await pending;
    if (state.pendingDisposal === pending) state.pendingDisposal = undefined;
  }
  const failures = state.disposalErrors.splice(0);
  if (failures.length > 0) throw failures[0];
}

async function drainBootstraps(state: LearnRenderTestLifecycle): Promise<void> {
  let failure: unknown;
  let failed = false;
  while (state.bootstraps.size > 0) {
    const entries = [...state.bootstraps.entries()];
    for (const [owner, bootstrap] of entries) {
      try {
        await bootstrap;
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      } finally {
        if (state.bootstraps.get(owner) === bootstrap) state.bootstraps.delete(owner);
      }
    }
  }
  if (failed) throw failure;
}

async function waitForBootstrap(state: LearnRenderTestLifecycle, owner: object): Promise<void> {
  const bootstrap = state.bootstraps.get(owner);
  if (bootstrap === undefined) return;
  try {
    await bootstrap;
  } finally {
    if (state.bootstraps.get(owner) === bootstrap) state.bootstraps.delete(owner);
  }
}

/** Track the asynchronous SUT bootstrap so teardown cannot race its App creation. */
export function trackLearnRenderTestBootstrap(bootstrap: Promise<unknown>, owner: object): void {
  const state = lifecycle();
  const tracked = Promise.resolve(bootstrap);
  state.bootstraps.set(owner, tracked);
  // Keep rejection observed until the browser gate drains it, while preserving
  // the rejection for the gate's fail-closed await.
  void tracked.catch(() => undefined);
}

/** Wait for the current SUT bootstrap without changing ownership or disposal state. */
export async function waitForLearnRenderTestBootstrap(owner: object): Promise<void> {
  await waitForBootstrap(lifecycle(), owner);
}

/** Mark the canvas/test scope that is allowed to own the next App. */
export async function beginLearnRenderTestLifecycle(owner: object): Promise<void> {
  const state = lifecycle();
  const staleApp = state.app;
  state.owner = owner;
  state.app = undefined;
  if (staleApp !== undefined) enqueueDisposal(state, staleApp);
  let failure: unknown;
  let failed = false;
  try {
    await drainBootstraps(state);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await drainDisposals(state);
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
}

/** Register the current demo App so a browser error-gate can close its GPU owner. */
export function exposeLearnRenderTestApp(app: LearnRenderTestApp, owner: object): void {
  const state = lifecycle();
  if (state.owner !== owner) {
    enqueueDisposal(state, app);
    return;
  }
  state.app = app;
}

/** Dispose and clear the current demo App; safe to call when bootstrap failed. */
export async function disposeLearnRenderTestApp(owner: object): Promise<void> {
  const state = lifecycle();
  let failure: unknown;
  let failed = false;
  try {
    await waitForBootstrap(state, owner);
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (state.owner === owner) {
    const app = state.app;
    state.owner = undefined;
    state.app = undefined;
    if (app !== undefined) {
      // App.dispose() owns the loop and plugin context; the browser test owns
      // the renderer returned by createApp and must release its GPU device too.
      enqueueDisposal(state, app);
    }
  }
  try {
    await drainBootstraps(state);
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  try {
    await drainDisposals(state);
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
}
