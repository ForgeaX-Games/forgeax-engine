import type { VertexLayoutProjection } from '@forgeax/engine-geometry';
import type {
  MaterialRenderState,
  PrimitiveTopology,
  VertexAttributeMap,
} from '@forgeax/engine-types';

export interface PipelineSpec {
  readonly shader: {
    readonly id: string;
    readonly passKind: string;
    readonly variantSet: string | undefined;
  };
  readonly attachments: {
    readonly colorFormats: readonly GPUTextureFormat[];
    readonly depthFormat: GPUTextureFormat | undefined;
    readonly sampleCount: 1 | 4;
  };
  readonly geometry: {
    readonly topology: PrimitiveTopology;
    readonly stripIndexFormat?: 'uint16' | 'uint32' | undefined;
    readonly vertexLayout: VertexAttributeMap;
    /** Geometry-owned immutable descriptor projection, when already derived. */
    readonly vertexLayoutProjection?: VertexLayoutProjection | undefined;
    readonly shaderUvSetCount?: number | undefined;
  };
  readonly renderState: MaterialRenderState | undefined;
}
