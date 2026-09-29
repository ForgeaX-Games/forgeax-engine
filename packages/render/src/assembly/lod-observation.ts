import type { FrameReceipt } from '../render-contract';
import type { RenderSystem } from '../render-system';

export function observeLodOcclusionForReceipt(
  renderSystem: Pick<RenderSystem, 'observeLodOcclusion'>,
  receipt: Pick<FrameReceipt, 'frameId' | 'deviceGeneration'>,
): Promise<void> {
  return renderSystem.observeLodOcclusion({
    frameId: receipt.frameId,
    deviceGeneration: receipt.deviceGeneration,
  });
}
