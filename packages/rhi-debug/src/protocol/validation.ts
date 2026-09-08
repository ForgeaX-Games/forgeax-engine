import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError } from '../errors';
import { eventKinds } from './event-semantics';
import { type ResourceKind, type RhiCallEvent, TAPE_FORMAT_VERSION, type Tape } from './types';

type TapeValidation = ReturnType<typeof createRhiDebugError<'tape-invalid'>>;

export function validateTape(tape: Tape): Result<Tape, TapeValidation> {
  if (tape.header.formatVersion !== TAPE_FORMAT_VERSION)
    return err(
      createRhiDebugError('tape-invalid', { stage: 'validate', cause: 'format version is not 7' }),
    );
  if (tape.header.eventCount !== tape.events.length || tape.header.blobCount !== tape.blobs.length)
    return err(
      createRhiDebugError('tape-invalid', {
        stage: 'validate',
        cause: 'header counts do not match payload counts',
      }),
    );
  const declared = new Set<string>();
  for (const resource of tape.bootstrap) {
    if (declared.has(resource.handleId))
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: `duplicate bootstrap handle ${resource.handleId}`,
        }),
      );
    if (!isResourceKind(resource.kind))
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: `unknown resource kind ${resource.kind}`,
        }),
      );
    declared.add(resource.handleId);
  }
  const hashes = new Set<string>();
  for (const blob of tape.blobs) {
    if (hashes.has(blob.hash))
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: `duplicate blob hash ${blob.hash}`,
        }),
      );
    hashes.add(blob.hash);
  }
  for (let eventIndex = 0; eventIndex < tape.events.length; eventIndex++) {
    const event = tape.events[eventIndex];
    if (!event || !eventKinds.includes(event.kind))
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: `unknown event kind at ${eventIndex}`,
        }),
      );
    const semantics = eventResources(event);
    for (const created of semantics.created) {
      if (declared.has(created))
        return err(
          createRhiDebugError('tape-invalid', {
            stage: 'validate',
            cause: `duplicate handle ${created}`,
          }),
        );
      declared.add(created);
    }
    for (const read of semantics.reads) {
      if (!declared.has(read))
        return err(
          createRhiDebugError('tape-invalid', {
            stage: 'validate',
            cause: `create-before-use violated for ${read} at ${eventIndex}`,
          }),
        );
    }
    for (const destroyed of semantics.destroyed) {
      if (!declared.has(destroyed))
        return err(
          createRhiDebugError('tape-invalid', {
            stage: 'validate',
            cause: `destroy-before-use violated for ${destroyed} at ${eventIndex}`,
          }),
        );
      declared.delete(destroyed);
    }
  }
  return ok(tape);
}

function isResourceKind(value: string): value is ResourceKind {
  return [
    'buffer',
    'texture',
    'texture-view',
    'sampler',
    'shader-module',
    'pipeline',
    'binding',
    'encoder',
  ].includes(value);
}

interface EventResources {
  readonly created: readonly string[];
  readonly reads: readonly string[];
  readonly destroyed: readonly string[];
}

function eventResources(event: RhiCallEvent): EventResources {
  switch (event.kind) {
    case 'createBuffer':
    case 'createTexture':
    case 'createSampler':
    case 'createBindGroupLayout':
    case 'createBindGroup':
    case 'createPipelineLayout':
    case 'createRenderPipeline':
    case 'createComputePipeline':
    case 'createShaderModule':
      return {
        created: [event.handleId],
        reads: handleRefs(event, [
          'layoutHandleId',
          'vertexShaderModuleHandleId',
          'fragmentShaderModuleHandleId',
          'computeShaderModuleHandleId',
        ]),
        destroyed: [],
      };
    case 'createTextureView':
      return { created: [event.resultHandleId], reads: [event.sourceHandleId], destroyed: [] };
    case 'createCommandEncoder':
      return { created: [event.cmdHandleId], reads: [], destroyed: [] };
    case 'destroyBuffer':
    case 'destroyTexture':
      return { created: [], reads: [event.handleId], destroyed: [event.handleId] };
    case 'writeBuffer':
    case 'writeTexture':
      return { created: [], reads: handleRefs(event, ['handleId', 'destination']), destroyed: [] };
    case 'copyBufferToBuffer':
    case 'copyBufferToTexture':
    case 'copyTextureToBuffer':
    case 'copyTextureToTexture':
    case 'clearBuffer':
      return {
        created: [],
        reads: handleRefs(event, [
          'source',
          'destination',
          'sourceHandleId',
          'destinationHandleId',
          'bufferHandleId',
          'textureHandleId',
        ]),
        destroyed: [],
      };
    default:
      return { created: [], reads: [], destroyed: [] };
  }
}

function handleRefs(event: object, keys: readonly string[]): string[] {
  const refs: string[] = [];
  for (const key of keys) {
    const value = (event as Record<string, unknown>)[key];
    if (typeof value === 'string') refs.push(value);
    if (Array.isArray(value))
      refs.push(...value.filter((item): item is string => typeof item === 'string'));
  }
  return refs;
}
