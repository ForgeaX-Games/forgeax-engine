import type { TimeResource } from '@forgeax/engine-ecs';
import type { MaterialRuntimeArtifact, MaterialShaderEntry } from '@forgeax/engine-shader';
import type { Asset, Handle } from '@forgeax/engine-types';
import type { DispatchEntry, ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import type { TransparentSortConfig } from '../systems/transparent-sort-config';
import type { PublishedCanvasFrame } from './canvas';
import type { PublishedRenderTarget, PublishedRenderTargetSource } from './targets';

/** Chosen by App before creating the receiver; never inferred from the first packet. */
export interface RenderPublicationIdentity {
  readonly source: string;
  readonly epoch: number;
}

export type RenderPublicationMetadata = Omit<
  ExtractedFrame,
  | 'renderables'
  | 'dispatch'
  | 'visibilitySnapshots'
  | 'featureVisibilitySnapshots'
  | 'hiddenEntityReports'
  | 'shadowCasterEntityKeys'
  | 'shadowCasterDrawKeys'
  | 'shadowCasterMembership'
>;

export interface RenderPublicationTemplate {
  readonly snapshot: Omit<RenderableSnapshot, 'worldId' | 'entityKey' | 'transform'>;
  readonly dispatch: readonly Omit<DispatchEntry, 'entityIndex' | 'renderableIndex'>[];
}

/** Numeric storage is publisher-owned; no ECS or asset buffer is transferred. */
export interface RenderPublication extends RenderPublicationIdentity {
  readonly revision: number;
  readonly base: number;
  readonly baseline: boolean;
  readonly time: TimeResource;
  readonly sampleTimeSeconds: number;
  readonly temporalReset: boolean;
  readonly transparentSort: TransparentSortConfig;
  readonly metadata: RenderPublicationMetadata;
  readonly templates: readonly RenderPublicationTemplate[];
  readonly canvasFrames?: readonly PublishedCanvasFrame[];
  readonly videoFrames: readonly {
    readonly entity: number;
    readonly clip: number;
    readonly frame: VideoFrame;
  }[];
  readonly targets: readonly PublishedRenderTarget[];
  readonly targetSources: readonly PublishedRenderTargetSource[];
  readonly features: readonly { readonly identity: string; readonly data: unknown }[];
  readonly programs: readonly {
    readonly key: string;
    readonly shader: MaterialShaderEntry;
    readonly artifact?: MaterialRuntimeArtifact;
  }[];
  /** entity, template index pairs. A publication source owns one World. */
  readonly upserts: Uint32Array;
  readonly removed: Uint32Array;
  readonly transformEntities: Uint32Array;
  readonly transforms: Float32Array;
  readonly assets: readonly {
    readonly handle: Handle<string, 'shared'>;
    readonly guid?: string;
    readonly value: Asset;
  }[];
  readonly retiredAssets: readonly Handle<string, 'shared'>[];
  readonly invalidatedAssets: readonly Handle<string, 'shared'>[];
}

export interface PublishedRenderFrameInput {
  readonly publication: RenderPublication;
  /** Realm-local adapter invoked only after the feature's graph is submitted. */
  readonly onFeatureSourceSubmitted?: (identity: string, feedback: unknown) => void;
}

export function renderPublicationTransfers(packet: RenderPublication): ArrayBuffer[] {
  return [
    packet.upserts.buffer,
    packet.removed.buffer,
    packet.transformEntities.buffer,
    packet.transforms.buffer,
  ] as ArrayBuffer[];
}

export type RenderPublicationFailure =
  | 'identity'
  | 'base'
  | 'revision'
  | 'shape'
  | 'unsupported'
  | 'in-flight'
  | 'disposed';

export class RenderPublicationError extends Error {
  readonly code = 'render-publication-invalid' as const;
  readonly expected = 'one valid publication for the bound source session and accepted base';
  readonly hint =
    'inspect detail.reason; repair the source or start a new session with a complete current baseline';
  constructor(
    readonly detail: { readonly reason: RenderPublicationFailure; readonly subject: string },
  ) {
    super(`render-publication-invalid: ${detail.reason}: ${detail.subject}`);
    this.name = 'RenderPublicationError';
  }
}
