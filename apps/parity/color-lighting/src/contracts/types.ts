import type { ObservationCapture } from '../capture/attachment-readback';
import type { CapabilityStatus, CaseVerdict, ExecutionStatus } from '../report/status';

export type ColorDomain = 'linearHdr' | 'linearLdr' | 'displayEncoded';
export type PrimaryMetric = 'rgba' | 'alpha' | 'occupancy';
export type PipelineIdentity = 'urp' | 'hdrp';
export type LightKind = 'directional' | 'point' | 'spot';

export interface SceneCasePipeline {
  readonly identity: PipelineIdentity;
  readonly engineId: 'forgeax::urp' | 'forgeax::hdrp';
}

export interface SceneCaseLight {
  readonly authorityId: string;
  readonly kind: LightKind;
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly range?: number;
  readonly direction?: readonly [number, number, number];
  readonly innerConeDeg?: number;
  readonly outerConeDeg?: number;
}

export interface SceneCaseImport {
  readonly source: 'none' | 'KHR_lights_punctual';
  readonly intensityScale: number;
  readonly rangeZero: 'no-cutoff';
  readonly cone: 'radians-to-degrees';
}

export interface SceneCaseBudget {
  readonly analyticMax: number;
  readonly roiMax: number;
  readonly byteMax: number;
}

export interface SceneDefinition {
  readonly width: number;
  readonly height: number;
  readonly background: readonly [number, number, number, number];
}

export interface SceneCaseComparison {
  readonly primaryMetric: PrimaryMetric;
}

export interface SceneCase {
  readonly caseId: string;
  readonly required: boolean;
  readonly colorDomain: ColorDomain;
  readonly pipeline?: SceneCasePipeline;
  readonly light?: SceneCaseLight;
  readonly import?: SceneCaseImport;
  readonly comparison?: SceneCaseComparison;
  readonly scene: SceneDefinition;
  readonly budget: SceneCaseBudget;
}

export interface ParityProvenance {
  readonly implementation: string;
  readonly version: string;
  readonly renderer?: string;
  readonly adapterId?: string;
}

export interface NamedCaptures {
  readonly linear: readonly number[];
  readonly final: readonly number[];
  readonly hash: string;
}

export interface CaseMetrics {
  readonly analyticMax: number;
  readonly roiMax: number;
  readonly differingBytes: number;
}

export interface FirstDivergence {
  readonly owner: string;
  readonly metric: 'analytic' | 'roi' | 'bytes';
}

export interface CaseReport {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly required: boolean;
  readonly pipeline?: SceneCasePipeline;
  readonly light?: SceneCaseLight;
  readonly import?: SceneCaseImport;
  readonly provenance: {
    readonly forgeax: ParityProvenance;
    readonly three: ParityProvenance;
  };
  readonly captures: {
    readonly forgeax: NamedCaptures;
    readonly three: NamedCaptures;
  };
  readonly readback?: {
    readonly forgeax?: string;
    readonly three?: string;
  };
  readonly attachmentEvidence?: AttachmentReport;
  readonly budget: SceneCaseBudget;
  readonly metrics: CaseMetrics;
  readonly verdict: 'notRun' | 'failed' | 'passed';
  readonly status: 'partial' | 'failed' | 'complete';
  readonly firstDivergence?: FirstDivergence | null;
}

export type AttachmentReadbackStatus = 'complete' | 'partial' | 'failed' | 'blocked';

export interface AttachmentReport {
  readonly linearHdr: ObservationCapture;
  readonly finalDisplay: ObservationCapture;
  readonly attachmentReadbackStatus: AttachmentReadbackStatus;
  readonly capabilityStatus: CapabilityStatus;
  readonly executionStatus: ExecutionStatus;
  readonly verdict: CaseVerdict;
  readonly missingPipelineIds: readonly string[];
}

export interface ValidationDetail {
  readonly path: readonly string[];
  readonly keyword?: string;
  readonly message: string;
}

export interface ValidationError {
  readonly code: 'schema-invalid' | 'non-finite-value' | 'file-read-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: ValidationDetail;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ValidationError };

export type PipelineEvidencePipelineId = 'forgeax::urp' | 'forgeax::hdrp';
export type PipelineEvidenceRuntimeId = 'browser' | 'dawn';

export interface PipelineEvidenceObservation {
  readonly kind: 'linearHdr' | 'finalDisplay';
  readonly status: 'ready';
  readonly bytes: readonly number[];
  readonly format: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly rawHash: string;
  readonly frameId: number;
  readonly pipelineId: PipelineEvidencePipelineId;
  readonly backendId: string;
}

export interface PipelineEvidenceNormalization {
  readonly authorityId: 'threeR184SquaredWindow';
  readonly intensityScale: 1;
  readonly rangeModel: 'squared-finite';
  readonly coneModel: 'radians-to-degrees';
}

export interface PipelineEvidenceArtifact {
  readonly schemaVersion: 1;
  readonly invocationId: string;
  readonly caseId: string;
  readonly sceneCase: Record<string, unknown>;
  readonly sourceHash: string;
  readonly semanticHash: string;
  readonly pipelineId: PipelineEvidencePipelineId;
  readonly runtimeId: PipelineEvidenceRuntimeId;
  readonly backendId: string;
  readonly frameId: number;
  readonly copySrc: true;
  readonly lifetime: 'active';
  readonly semantic: 'linear-hdr';
  readonly source: 'live-producer';
  readonly provenance: ParityProvenance & { readonly adapterId: string };
  readonly normalization: PipelineEvidenceNormalization;
  readonly linearHdr: PipelineEvidenceObservation;
  readonly finalDisplay: PipelineEvidenceObservation;
}

export type PipelineEvidence = PipelineEvidenceArtifact;

export interface CrossRuntimeProducerReport {
  readonly pipelineId: PipelineEvidencePipelineId;
  readonly runtimeId: PipelineEvidenceRuntimeId;
  readonly backendId: string;
  readonly frameId: number;
  readonly copySrc: true;
  readonly lifetime: 'active';
  readonly provenance: PipelineEvidenceArtifact['provenance'];
  readonly semantic: 'linear-hdr';
  readonly source: 'live-producer';
  readonly sourceHash: string;
  readonly semanticHash: string;
  readonly linearHdr: PipelineEvidenceObservation;
  readonly finalDisplay: PipelineEvidenceObservation;
}

export interface CrossRuntimeAttachmentReport {
  readonly producers: readonly CrossRuntimeProducerReport[];
  readonly attachmentReadbackStatus: 'complete' | 'failed';
  readonly capabilityStatus: 'supported';
  readonly executionStatus: 'complete' | 'partial';
  readonly verdict: 'passed' | 'failed';
  readonly capturedPipelineIds: readonly ('urp' | 'hdrp')[];
  readonly missingPipelineIds: readonly ('urp' | 'hdrp')[];
}

export interface CrossRuntimeCaseReport {
  readonly schemaVersion: 2;
  readonly caseId: string;
  readonly required: boolean;
  readonly invocationId: string;
  readonly sceneCaseIdentity: {
    readonly sourceHash: string;
    readonly semanticHash: string;
  };
  readonly attachmentEvidence: CrossRuntimeAttachmentReport;
  readonly verdict: 'passed' | 'failed';
  readonly status: 'complete' | 'failed';
}
