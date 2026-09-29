import { gpuDrivenDrawKey, gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import type { RenderableSnapshot } from '../render-system-extract';
import { worldEntityKey } from './frame-snapshot';

/** Internal receipt for one concrete CPU/GPU presentation draw unit. */
export interface RenderableDrawReceipt {
  readonly lane: 'cpu' | 'gpu';
  readonly ready: boolean;
}

/** Emit receipts only for draw items claimed by the GPU raster owner. */
export function emitGpuDrivenDrawReceipts<
  T extends {
    readonly source: Pick<
      RenderableSnapshot,
      'worldId' | 'entityKey' | 'material' | 'materials' | 'gpuDrivenDraws'
    >;
  },
>(
  entry: T,
  drawKeys: ReadonlySet<string>,
  onRenderableDraw: (entry: T, submeshIndex: number, receipt: RenderableDrawReceipt) => void,
): void {
  for (const [compactIndex, draw] of (entry.source.gpuDrivenDraws ?? []).entries()) {
    const material = entry.source.materials[draw.materialSlot] ?? entry.source.material;
    const sourceDrawItemIndex = gpuDrivenSourceDrawItemIndex(draw, compactIndex);
    const key = gpuDrivenDrawKey(
      worldEntityKey(entry.source.worldId, entry.source.entityKey),
      material.materialHandle ?? -1,
      sourceDrawItemIndex,
    );
    if (!drawKeys.has(key)) continue;
    onRenderableDraw(entry, draw.drawItemIndex ?? compactIndex, {
      lane: 'gpu',
      ready: true,
    });
  }
}
