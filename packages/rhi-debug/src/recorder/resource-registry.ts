import type { DebugRhiInstance } from '../recorder';
import type { HandleId } from '../types';

export interface ResourceCandidate {
  readonly handleId: HandleId;
  readonly kind: 'buffer' | 'texture';
  readonly estimatedBytes: number;
}

export class ResourceRegistry {
  constructor(private readonly recorder: DebugRhiInstance) {}

  candidates(): readonly ResourceCandidate[] {
    return Array.from(this.recorder.descriptorTable(), ([handleId, descriptor]) => ({
      handleId,
      kind: descriptor.kind,
      estimatedBytes: estimateBytes(descriptor),
    }));
  }

  estimateSnapshotBytes(): number {
    return this.candidates().reduce((total, candidate) => total + candidate.estimatedBytes, 0);
  }

  clearGeneration(): void {
    this.recorder.transitionToError();
    this.recorder.resetForDeviceLoss();
  }
}

function estimateBytes(descriptor: {
  readonly kind: 'buffer' | 'texture';
  readonly size?: number | GPUExtent3DStrict;
}): number {
  if (descriptor.kind === 'buffer') {
    return typeof descriptor.size === 'number' ? descriptor.size : 0;
  }
  if (descriptor.size === undefined || typeof descriptor.size === 'number') return 4;
  if (Array.isArray(descriptor.size)) {
    return Math.max(
      1,
      (descriptor.size[0] ?? 1) * (descriptor.size[1] ?? 1) * (descriptor.size[2] ?? 1) * 4,
    );
  }
  if (!('width' in descriptor.size)) return 4;
  return Math.max(
    1,
    descriptor.size.width *
      (descriptor.size.height ?? 1) *
      (descriptor.size.depthOrArrayLayers ?? 1) *
      4,
  );
}
