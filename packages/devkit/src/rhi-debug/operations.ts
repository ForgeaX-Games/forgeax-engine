import {
  buildFrameModel,
  decodeTape,
  type FrameModel,
  type InspectField,
  openReplay,
  type ReplayBackend,
  type RhiDebugError,
  type V7Tape,
  type WorkInspection,
} from '@forgeax/engine-rhi-debug';
import { ok, type Result } from '@forgeax/engine-types';
import type { CommandError, CommandResult } from '../types.js';

export const RHI_TAPE_ARTIFACT_KIND = 'rhi-tape' as const;

export interface ArtifactRef {
  readonly kind: typeof RHI_TAPE_ARTIFACT_KIND;
  readonly digest: string;
  readonly source: string;
  readonly path?: string;
}

export interface CapturedRhiTape extends ArtifactRef {
  readonly bytes: Uint8Array;
}

export interface RhiCaptureFrameValue {
  readonly kind: typeof RHI_TAPE_ARTIFACT_KIND;
  readonly digest: string;
  readonly bytes: Uint8Array;
  readonly source?: string;
  readonly path?: string;
}

export interface RhiCaptureInput {
  readonly signal?: AbortSignal;
}

export interface RhiSummaryInput {
  readonly artifact: ArtifactRef;
}

export interface RhiInspectInput {
  readonly artifact: ArtifactRef;
  readonly workIndex: number;
  readonly fields?: readonly InspectField[];
}

export type RhiDebugOperationName = 'rhi.capture' | 'rhi.summary' | 'rhi.inspect';

export type RhiDebugOperationInput = RhiCaptureInput | RhiSummaryInput | RhiInspectInput;

export interface RhiSummaryOutput {
  readonly artifact: ArtifactRef;
  readonly model: FrameModel;
}

export interface RhiInspectOutput {
  readonly artifact: ArtifactRef;
  readonly inspection: WorkInspection;
}

export type RhiDebugOperationOutput = ArtifactRef | RhiSummaryOutput | RhiInspectOutput;

export interface RhiDebugOperationContext {
  readonly captureFrame: (
    input?: RhiCaptureInput,
  ) => Promise<Result<CapturedRhiTape, RhiDebugError>>;
  readonly readArtifact: (artifact: ArtifactRef) => Promise<CommandResult<Uint8Array>>;
  readonly createReplayBackend?: (tape: V7Tape) => Promise<CommandResult<ReplayBackend>>;
}

export interface RhiDebugOperationHost {
  readonly captureFrame: (
    input?: RhiCaptureInput,
  ) => Promise<Result<RhiCaptureFrameValue, RhiDebugError>>;
  readonly readArtifact: (artifact: ArtifactRef) => Promise<CommandResult<Uint8Array>>;
  readonly createReplayBackend?: (tape: V7Tape) => Promise<CommandResult<ReplayBackend>>;
}

export function createRhiDebugOperationContext(
  host: RhiDebugOperationHost,
): RhiDebugOperationContext {
  return {
    async captureFrame(input) {
      const captured = await host.captureFrame(input);
      if (!captured.ok) return captured;
      return ok({
        kind: RHI_TAPE_ARTIFACT_KIND,
        digest: captured.value.digest,
        source: captured.value.source ?? 'rhi.capture',
        ...(captured.value.path === undefined ? {} : { path: captured.value.path }),
        bytes: captured.value.bytes,
      });
    },
    readArtifact: host.readArtifact,
    ...(host.createReplayBackend === undefined
      ? {}
      : { createReplayBackend: host.createReplayBackend }),
  };
}

export interface JsonSchema {
  readonly type: 'object' | 'string' | 'integer' | 'array';
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly additionalProperties?: boolean;
}

export interface RhiDebugOperationDescriptor {
  readonly name: RhiDebugOperationName;
  readonly summary: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly recoveryCodes: readonly string[];
}

export interface RhiDebugOperationManifest {
  readonly schemaVersion: '1.0.0';
  readonly artifactRefSchema: JsonSchema;
  readonly operations: readonly RhiDebugOperationDescriptor[];
}

const artifactRefSchema: JsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [RHI_TAPE_ARTIFACT_KIND] },
    digest: { type: 'string' },
    source: { type: 'string' },
    path: { type: 'string' },
  },
  required: ['kind', 'digest', 'source'],
  additionalProperties: false,
};

const summaryOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    artifact: artifactRefSchema,
    model: { type: 'object', additionalProperties: true },
  },
  required: ['artifact', 'model'],
  additionalProperties: false,
};

const inspectOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    artifact: artifactRefSchema,
    inspection: { type: 'object', additionalProperties: true },
  },
  required: ['artifact', 'inspection'],
  additionalProperties: false,
};

export const RHI_DEBUG_OPERATION_MANIFEST: RhiDebugOperationManifest = {
  schemaVersion: '1.0.0',
  artifactRefSchema,
  operations: [
    {
      name: 'rhi.capture',
      summary: 'Capture the next frame and return one rhi-tape ArtifactRef.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputSchema: artifactRefSchema,
      recoveryCodes: [
        'capture-unavailable',
        'capture-busy',
        'capture-snapshot-failed',
        'capture-timeout',
      ],
    },
    {
      name: 'rhi.summary',
      summary: 'Strictly decode one ArtifactRef and return its CPU FrameModel.',
      inputSchema: {
        type: 'object',
        properties: { artifact: artifactRefSchema },
        required: ['artifact'],
        additionalProperties: false,
      },
      outputSchema: summaryOutputSchema,
      recoveryCodes: ['tape-invalid', 'tape-version-unsupported'],
    },
    {
      name: 'rhi.inspect',
      summary: 'Replay one ArtifactRef on a fresh backend and inspect a workIndex.',
      inputSchema: {
        type: 'object',
        properties: {
          artifact: artifactRefSchema,
          workIndex: { type: 'integer', minimum: 0 },
          fields: {
            type: 'array',
            items: { type: 'string', enum: ['bindings', 'pipeline', 'pixels'] },
          },
        },
        required: ['artifact', 'workIndex'],
        additionalProperties: false,
      },
      outputSchema: inspectOutputSchema,
      recoveryCodes: [
        'tape-invalid',
        'tape-version-unsupported',
        'replay-capability-mismatch',
        'replay-event-failed',
        'replay-position-invalid',
        'readback-failed',
        'readback-unsupported',
      ],
    },
  ],
};

export function discoverRhiDebugOperations(): readonly RhiDebugOperationDescriptor[] {
  return RHI_DEBUG_OPERATION_MANIFEST.operations;
}

export function renderRhiDebugHelp(): string {
  return [
    'forgeax run <operation>',
    ...discoverRhiDebugOperations().map((operation) => `  ${operation.name}: ${operation.summary}`),
    'Usage:',
    '  forgeax run rhi.summary --artifact PATH --digest SHA256 --json',
    '  forgeax run rhi.inspect --artifact PATH --digest SHA256 --work-index N --fields pipeline,bindings,pixels --json',
    'ArtifactRef schema:',
    JSON.stringify(RHI_DEBUG_OPERATION_MANIFEST.artifactRefSchema),
  ].join('\n');
}

export function recoverRhiDebugError(error: RhiDebugError): string {
  switch (error.code) {
    case 'capture-unavailable':
    case 'capture-busy':
    case 'capture-snapshot-failed':
    case 'capture-timeout':
      return `${error.hint}: ${error.detail?.cause ?? 'capture failed'}`;
    case 'tape-invalid':
      return `${error.hint}: ${error.detail?.cause ?? 'tape validation failed'}`;
    case 'tape-version-unsupported':
      return `${error.hint}: found ${error.detail?.foundVersion}, expected ${error.detail?.expectedVersion}`;
    case 'replay-capability-mismatch':
      return `${error.hint}: ${error.detail?.cause ?? 'capability mismatch'}`;
    case 'replay-event-failed':
      return `${error.hint}: event ${error.detail?.eventIndex} ${error.detail?.kind} at ${error.detail?.stage}`;
    case 'replay-position-invalid':
      return `${error.hint}: requested ${error.detail?.requested}, available ${error.detail?.available}`;
    case 'readback-failed':
      return `${error.hint}: ${error.detail?.cause ?? 'readback failed'}`;
    case 'readback-unsupported':
      return `${error.hint}: ${error.detail?.reason ?? 'readback is unsupported'}`;
  }
}

function coreError(error: RhiDebugError): CommandError {
  return {
    code: error.code,
    expected: error.expected,
    hint: recoverRhiDebugError(error),
    detail: error.detail === undefined ? {} : Object.fromEntries(Object.entries(error.detail)),
  };
}

function operationError(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
): CommandResult<never> {
  return { ok: false, error: { code, expected, hint, detail } };
}

function validateArtifactRef(
  value: unknown,
):
  | { readonly ok: true; readonly value: ArtifactRef }
  | { readonly ok: false; readonly error: CommandError } {
  if (value === null || typeof value !== 'object') {
    return operationError(
      'artifact-ref-invalid',
      'an ArtifactRef object',
      'Pass the ArtifactRef returned by rhi.capture unchanged.',
    );
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== RHI_TAPE_ARTIFACT_KIND) {
    return operationError(
      'artifact-kind-invalid',
      `ArtifactRef.kind to equal ${RHI_TAPE_ARTIFACT_KIND}`,
      'Capture a new RHI tape and pass its ArtifactRef unchanged.',
      { kind: candidate.kind ?? null },
    );
  }
  if (typeof candidate.digest !== 'string' || candidate.digest.length === 0) {
    return operationError(
      'artifact-digest-invalid',
      'ArtifactRef.digest to be a non-empty digest',
      'Use the digest returned with the captured tape.',
    );
  }
  if (typeof candidate.source !== 'string' || candidate.source.length === 0) {
    return operationError(
      'artifact-source-invalid',
      'ArtifactRef.source to identify the producing operation',
      'Use the complete ArtifactRef returned by rhi.capture.',
    );
  }
  return {
    ok: true,
    value: {
      kind: RHI_TAPE_ARTIFACT_KIND,
      digest: candidate.digest,
      source: candidate.source,
      ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
    },
  };
}

async function readTape(
  artifact: ArtifactRef,
  context: RhiDebugOperationContext,
): Promise<CommandResult<Uint8Array>> {
  const validated = validateArtifactRef(artifact);
  if (!validated.ok) return validated;
  return context.readArtifact(validated.value);
}

export function runRhiDebugOperation(
  name: 'rhi.capture',
  input: RhiCaptureInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<ArtifactRef>>;
export function runRhiDebugOperation(
  name: 'rhi.summary',
  input: RhiSummaryInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiSummaryOutput>>;
export function runRhiDebugOperation(
  name: 'rhi.inspect',
  input: RhiInspectInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiInspectOutput>>;
export function runRhiDebugOperation(
  name: RhiDebugOperationName,
  input: RhiDebugOperationInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiDebugOperationOutput>>;
export async function runRhiDebugOperation(
  name: RhiDebugOperationName,
  input: RhiDebugOperationInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiDebugOperationOutput>> {
  switch (name) {
    case 'rhi.capture': {
      const capture = await context.captureFrame(input as RhiCaptureInput);
      if (!capture.ok) return { ok: false, error: coreError(capture.error) };
      const artifact = validateArtifactRef(capture.value);
      if (!artifact.ok) return artifact;
      return { ok: true, value: artifact.value };
    }
    case 'rhi.summary': {
      const summaryInput = input as RhiSummaryInput;
      const bytes = await readTape(summaryInput.artifact, context);
      if (!bytes.ok) return bytes;
      const decoded = decodeTape(bytes.value);
      if (!decoded.ok) return { ok: false, error: coreError(decoded.error) };
      const artifact = validateArtifactRef(summaryInput.artifact);
      if (!artifact.ok) return artifact;
      return {
        ok: true,
        value: { artifact: artifact.value, model: buildFrameModel(decoded.value) },
      };
    }
    case 'rhi.inspect': {
      const inspectInput = input as RhiInspectInput;
      if (!Number.isInteger(inspectInput.workIndex) || inspectInput.workIndex < 0) {
        return operationError(
          'work-index-invalid',
          'workIndex to be a non-negative integer',
          'Choose workIndex from the FrameModel returned by rhi.summary.',
          { workIndex: inspectInput.workIndex },
        );
      }
      const bytes = await readTape(inspectInput.artifact, context);
      if (!bytes.ok) return bytes;
      const decoded = decodeTape(bytes.value);
      if (!decoded.ok) return { ok: false, error: coreError(decoded.error) };
      if (context.createReplayBackend === undefined) {
        return operationError(
          'replay-backend-unavailable',
          'a fresh ReplayBackend factory',
          'Provide a fresh device and shader factory before running rhi.inspect.',
        );
      }
      const backend = await context.createReplayBackend(decoded.value);
      if (!backend.ok) return backend;
      const opened = await openReplay(decoded.value, backend.value);
      if (!opened.ok) return { ok: false, error: coreError(opened.error) };
      try {
        const inspection = await opened.value.inspectWork(
          inspectInput.workIndex,
          inspectInput.fields,
        );
        if (!inspection.ok) return { ok: false, error: coreError(inspection.error) };
        const artifact = validateArtifactRef(inspectInput.artifact);
        if (!artifact.ok) return artifact;
        return { ok: true, value: { artifact: artifact.value, inspection: inspection.value } };
      } finally {
        await opened.value.dispose();
      }
    }
  }
}
