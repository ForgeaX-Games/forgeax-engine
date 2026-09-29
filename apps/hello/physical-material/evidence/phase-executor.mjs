/**
 * Shared phase lifecycle for the physical-material carriers.
 * The caller owns scene/material construction; this module owns one
 * frame/receipt transaction and never manufactures observations.
 */
export async function runRenderPhase({
  phase,
  frameCount,
  world,
  renderer,
  frameRequest,
  yieldFrame,
  onDrawError,
  beforeDraw,
  afterDraw,
}) {
  let receipt;
  for (let frame = 0; frame < frameCount; frame += 1) {
    world.update().unwrap();
    await beforeDraw?.(frame);
    const drawn = renderer.draw(frameRequest);
    if (!drawn.ok) onDrawError?.(phase, frame, drawn.error);
    else {
      const completed = await drawn.value.completed;
      if (!completed.ok) throw completed.error;
      receipt = drawn.value;
      await afterDraw?.(frame, drawn.value);
    }
    await yieldFrame();
  }
  if (receipt === undefined) throw new Error(`${phase} phase produced no FrameReceipt`);
  return receipt;
}

export async function runPairedStages({ stages, captureStage }) {
  const results = {};
  for (const stage of stages) results[stage] = await captureStage(stage);
  return results;
}

export async function disposeRenderResources({ renderer, mutantRenderer, renderTarget, mutantRenderTarget, device }) {
  const errors = [];
  const disposed = await renderer.dispose();
  if (!disposed.ok) errors.push(`renderer-dispose-failed:${disposed.error?.code ?? 'unknown'}`);
  if (mutantRenderer !== undefined) {
    const mutantDisposed = await mutantRenderer.dispose();
    if (!mutantDisposed.ok) errors.push(`mutant-renderer-dispose-failed:${mutantDisposed.error?.code ?? 'unknown'}`);
  }
  renderTarget?.destroy();
  mutantRenderTarget?.destroy();
  device?.destroy?.();
  return errors;
}
