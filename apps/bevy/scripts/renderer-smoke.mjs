const leasesByRenderer = new WeakMap();

/** Resolve the Result returned by the public runtime renderer factory. */
export async function createSmokeRenderer(createRenderer, ...args) {
  const created = await createRenderer(...args);
  if (!created.ok) throw created.error;
  return created.value;
}

/** Read backend capability data without reaching into Renderer internals. */
export function rendererBackend(renderer) {
  return renderer.inspect().capabilities.backendKind;
}

/** Subscribe to the single structured renderer event stream used by smokes. */
export function subscribeSmokeErrors(renderer, listener) {
  return renderer.subscribe((event) => {
    if (event.kind === 'error') listener(event.error);
  });
}

/**
 * Drive the lease-bound public frame contract for a single-world smoke.
 * The cache keeps the helper from allocating a new lease on every frame while
 * allowing legacy fixtures to pass their World only at this test boundary.
 */
export function drawSmokeFrame(renderer, world) {
  let leasesByWorld = leasesByRenderer.get(renderer);
  if (leasesByWorld === undefined) {
    leasesByWorld = new WeakMap();
    leasesByRenderer.set(renderer, leasesByWorld);
  }
  let lease = leasesByWorld.get(world);
  if (lease === undefined) {
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    lease = attached.value;
    leasesByWorld.set(world, lease);
  }
  return renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
  });
}
