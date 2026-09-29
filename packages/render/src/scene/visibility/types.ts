/** Closed view roles used by the renderer-owned visibility facet. */
export type VisibilityViewRole = 'main' | 'shadow' | 'reflection' | 'probe';

export interface ViewKey {
  readonly attachmentId: string;
  readonly cameraEntity: number;
  readonly viewRole: VisibilityViewRole;
  readonly viewGeneration: number;
}

export interface PrimitiveKey {
  readonly attachmentId: string;
  readonly worldGeneration: number;
  readonly primitiveSlot: number;
  readonly slotGeneration: number;
}

export interface VisibilityCandidate {
  readonly level: number;
  readonly confidence: number;
}

export interface VisibilityFacetInspection {
  readonly owner: 'persistent-render-scene';
  readonly activeViews: number;
  readonly facetRows: number;
}

export interface VisibilityFacetInput {
  readonly view: ViewKey;
  readonly primitive: PrimitiveKey;
  readonly epoch: number;
  readonly candidate: VisibilityCandidate;
}

export function viewKeyId(key: ViewKey): string {
  return `${key.attachmentId}:${key.cameraEntity}:${key.viewRole}:${key.viewGeneration}`;
}

export function primitiveKeyId(key: PrimitiveKey): string {
  return `${key.attachmentId}:${key.worldGeneration}:${key.primitiveSlot}:${key.slotGeneration}`;
}

export function viewKey(input: ViewKey): ViewKey {
  return Object.freeze({ ...input });
}

export function primitiveKey(input: PrimitiveKey): PrimitiveKey {
  return Object.freeze({ ...input });
}
