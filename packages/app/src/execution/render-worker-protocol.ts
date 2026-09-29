import type {
  GpuPassTimingObservation,
  GpuPassTimingOptions,
  RenderPublication,
  RenderPublicationIdentity,
  RenderSceneBounds,
} from '@forgeax/engine-render';
import type { CaptureFrameOptions, RhiDebugError } from '@forgeax/engine-rhi-debug';
import type { RhiTapeArtifactRef } from '../internal/rhi-capture';
import type { ExecutionFrameCompletion, ExecutionFrameSubmitted } from './protocol';

export type RenderWorkerInput =
  | {
      readonly kind: 'init';
      readonly bootstrapUrl: string;
      readonly bootstrapData?: import('./types').ExecutionBootstrapValue;
      readonly canvas: OffscreenCanvas;
      readonly identity: RenderPublicationIdentity;
      readonly shaderManifestUrl?: string;
      readonly build?: string;
      readonly rhiCapture?: boolean;
      readonly gpuPassTiming?: GpuPassTimingOptions;
    }
  | {
      readonly kind: 'draw';
      readonly worldIdentity: string;
      readonly frameId: number;
      readonly width: number;
      readonly height: number;
      readonly publication: RenderPublication;
    }
  | {
      readonly kind: 'capture';
      readonly requestId: number;
      readonly options: Omit<CaptureFrameOptions, 'signal'>;
    }
  | { readonly kind: 'capture-cancel'; readonly requestId: number }
  | { readonly kind: 'bounds'; readonly requestId: number; readonly entity: number }
  | { readonly kind: 'dispose' };
export type RenderWorkerOutput =
  | {
      readonly kind: 'bounds-result';
      readonly requestId: number;
      readonly bounds: RenderSceneBounds | undefined;
    }
  | {
      readonly kind: 'capture-result';
      readonly requestId: number;
      readonly result:
        | { readonly ok: true; readonly value: RhiTapeArtifactRef }
        | { readonly ok: false; readonly error: RhiDebugError };
    }
  | {
      readonly kind: 'ready';
      readonly capabilities: import('@forgeax/engine-rhi').RhiCaps;
    }
  | {
      readonly kind: 'submitted';
      readonly frame: ExecutionFrameSubmitted;
      readonly revision: number;
      readonly features: readonly { readonly identity: string; readonly feedback: unknown }[];
    }
  | {
      readonly kind: 'completed';
      readonly frame: ExecutionFrameCompletion;
      readonly revision: number;
      readonly buffers: ArrayBuffer[];
      readonly gpuPassTiming?: GpuPassTimingObservation;
    }
  | {
      readonly kind: 'disposed';
      readonly error?: import('./protocol').ExecutionFaultMessage['detail'];
    }
  | {
      readonly kind: 'failed';
      readonly error: Pick<
        import('./protocol').ExecutionFaultMessage,
        'code' | 'expected' | 'hint' | 'detail'
      >;
      readonly stage: RenderWorkerInput['kind'];
      readonly publication?: RenderPublicationIdentity & {
        readonly revision: number;
        readonly frameId: number;
      };
      readonly recoverable: boolean;
    };
