export type ObservationKind = 'linearHdr' | 'finalDisplay';
export type ObservationStatus = 'ready' | 'failed' | 'blocked' | 'needs-context';

export interface ObservationCapture {
  readonly kind: ObservationKind;
  readonly status: ObservationStatus;
  readonly bytes?: Uint8Array;
  readonly format?: string;
  readonly size?: { readonly width: number; readonly height: number };
  readonly rawHash?: string;
  readonly frameId?: number;
  readonly pipelineId?: string;
  readonly backendId?: string;
}

export interface AttachmentEvidence {
  readonly linearHdr: ObservationCapture;
  readonly finalDisplay: ObservationCapture;
}

export interface ObservationEvidenceError {
  readonly code: 'observation-evidence-invalid';
  readonly field: string;
  readonly reason: string;
}

export type AttachmentEvidenceResult =
  | { readonly ok: true; readonly value: AttachmentEvidence }
  | { readonly ok: false; readonly error: ObservationEvidenceError };

const ALLOWED_FIELDS = new Set([
  'kind',
  'status',
  'bytes',
  'format',
  'size',
  'rawHash',
  'frameId',
  'pipelineId',
  'backendId',
]);

function invalid(field: string, reason: string): AttachmentEvidenceResult {
  return { ok: false, error: { code: 'observation-evidence-invalid', field, reason } };
}

function validateCapture(
  capture: ObservationCapture,
  expectedKind: ObservationKind,
): AttachmentEvidenceResult {
  if (capture.kind !== expectedKind) return invalid(expectedKind, 'capture source kind is not independent');
  if (Object.keys(capture).some((key) => !ALLOWED_FIELDS.has(key))) {
    return invalid(expectedKind, 'graph keys, RHI textures, and private handles are not evidence');
  }
  if (capture.status !== 'ready') return invalid(expectedKind, `capture status is ${capture.status}`);
  if (!(capture.bytes instanceof Uint8Array) || capture.bytes.byteLength === 0) {
    return invalid(expectedKind, 'ready capture bytes are missing');
  }
  if (typeof capture.format !== 'string' || capture.format.length === 0) {
    return invalid(expectedKind, 'native capture format is missing');
  }
  if (
    capture.size === undefined ||
    !Number.isInteger(capture.size.width) ||
    !Number.isInteger(capture.size.height) ||
    capture.size.width <= 0 ||
    capture.size.height <= 0
  ) {
    return invalid(expectedKind, 'capture size is missing or invalid');
  }
  if (typeof capture.rawHash !== 'string' || capture.rawHash.length === 0) {
    return invalid(expectedKind, 'raw hash is missing');
  }
  const frameId = capture.frameId;
  if (typeof frameId !== 'number' || !Number.isInteger(frameId) || frameId < 0) {
    return invalid(expectedKind, 'frame provenance is missing');
  }
  if (typeof capture.pipelineId !== 'string' || capture.pipelineId.length === 0) {
    return invalid(expectedKind, 'pipeline provenance is missing');
  }
  if (typeof capture.backendId !== 'string' || capture.backendId.length === 0) {
    return invalid(expectedKind, 'backend provenance is missing');
  }
  return { ok: true, value: { linearHdr: capture, finalDisplay: capture } };
}

export function validateAttachmentEvidence(
  input: AttachmentEvidence,
  expectedPipelineId?: string,
): AttachmentEvidenceResult {
  const linearResult = validateCapture(input.linearHdr, 'linearHdr');
  if (!linearResult.ok) return linearResult;
  const finalResult = validateCapture(input.finalDisplay, 'finalDisplay');
  if (!finalResult.ok) return finalResult;
  const linear = input.linearHdr;
  const final = input.finalDisplay;
  if (linear.rawHash === final.rawHash) return invalid('rawHash', 'linear and final captures share one hash');
  if (expectedPipelineId !== undefined) {
    if (linear.pipelineId !== expectedPipelineId) return invalid('linearHdr.pipelineId', 'pipeline identity mismatch');
    if (final.pipelineId !== expectedPipelineId) return invalid('finalDisplay.pipelineId', 'pipeline identity mismatch');
  }
  return { ok: true, value: input };
}

export function projectObservation(
  kind: ObservationKind,
  input: {
    readonly status: ObservationStatus;
    readonly bytes?: Uint8Array;
    readonly format?: string;
    readonly size?: { readonly width: number; readonly height: number };
    readonly rawHash?: string;
    readonly frameId?: number;
    readonly pipelineId?: string;
    readonly backendId?: string;
  },
): ObservationCapture {
  return { kind, ...input };
}
