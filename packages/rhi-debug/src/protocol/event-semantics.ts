import type { EventKind, ResourceKind, RhiCallEvent } from './types';

export type EventCategory = 'resource' | 'pass' | 'state' | 'work' | 'copy' | 'submit' | 'marker';

export interface EventSemantics {
  readonly category: EventCategory;
  readonly created: (event: RhiCallEvent) => readonly string[];
  readonly read: (event: RhiCallEvent) => readonly string[];
  readonly written: (event: RhiCallEvent) => readonly string[];
  readonly destroyed: (event: RhiCallEvent) => readonly string[];
}

export const eventKinds = [
  'frameMark',
  'createBuffer',
  'createTexture',
  'destroyBuffer',
  'destroyTexture',
  'createTextureView',
  'createSampler',
  'createBindGroupLayout',
  'createBindGroup',
  'createPipelineLayout',
  'createRenderPipeline',
  'createComputePipeline',
  'createShaderModule',
  'createCommandEncoder',
  'writeBuffer',
  'writeTexture',
  'copyExternalImageToTexture',
  'submit',
  'beginRenderPass',
  'beginComputePass',
  'copyBufferToBuffer',
  'copyBufferToTexture',
  'copyTextureToBuffer',
  'copyTextureToTexture',
  'clearBuffer',
  'pushDebugGroup',
  'popDebugGroup',
  'insertDebugMarker',
  'finish',
  'setPipeline',
  'setVertexBuffer',
  'setIndexBuffer',
  'setBindGroup',
  'draw',
  'drawIndexed',
  'setViewport',
  'setScissorRect',
  'setStencilReference',
  'endRenderPass',
  'setBlendConstant',
  'drawIndirect',
  'drawIndexedIndirect',
  'passPushDebugGroup',
  'passPopDebugGroup',
  'passInsertDebugMarker',
  'setComputePipeline',
  'dispatchWorkgroups',
  'dispatchWorkgroupsIndirect',
  'endComputePass',
  'initialData',
] as const satisfies readonly EventKind[];

export const workEventKinds = [
  'draw',
  'drawIndexed',
  'drawIndirect',
  'drawIndexedIndirect',
  'dispatchWorkgroups',
  'dispatchWorkgroupsIndirect',
] as const satisfies readonly EventKind[];

export function isWorkEvent(kind: EventKind): boolean {
  return (workEventKinds as readonly string[]).includes(kind);
}

export const EVENT_SEMANTICS: Readonly<Record<EventKind, EventSemantics>> = Object.fromEntries(
  eventKinds.map((kind) => [kind, semanticsFor(kind)]),
) as Record<EventKind, EventSemantics>;

export function resourceKindForEvent(kind: EventKind): ResourceKind | undefined {
  switch (kind) {
    case 'createBuffer':
      return 'buffer';
    case 'createTexture':
      return 'texture';
    case 'createTextureView':
      return 'texture-view';
    case 'createSampler':
      return 'sampler';
    case 'createShaderModule':
      return 'shader-module';
    case 'createRenderPipeline':
    case 'createComputePipeline':
      return 'pipeline';
    case 'createBindGroup':
    case 'createBindGroupLayout':
    case 'createPipelineLayout':
      return 'binding';
    case 'createCommandEncoder':
      return 'encoder';
    default:
      return undefined;
  }
}

function semanticsFor(kind: EventKind): EventSemantics {
  const category = categoryFor(kind);
  return {
    category,
    created: (event) => createdHandles(event),
    read: (event) => referencedHandles(event),
    written: (event) => writtenHandles(event),
    destroyed: (event) =>
      event.kind === 'destroyBuffer' || event.kind === 'destroyTexture'
        ? stringField(event, 'handleId')
        : [],
  };
}

function categoryFor(kind: EventKind): EventCategory {
  if (isWorkEvent(kind)) return 'work';
  if (kind.startsWith('create') || kind.startsWith('destroy') || kind === 'initialData')
    return 'resource';
  if (kind.includes('Pass')) return 'pass';
  if (kind.startsWith('copy') || kind === 'clearBuffer' || kind.startsWith('write')) return 'copy';
  if (kind === 'submit' || kind === 'finish') return 'submit';
  if (kind.includes('Debug')) return 'marker';
  return 'state';
}

function createdHandles(event: RhiCallEvent): readonly string[] {
  if (event.kind === 'createTextureView') return [event.resultHandleId];
  if (event.kind === 'createCommandEncoder') return [event.cmdHandleId];
  if (resourceKindForEvent(event.kind) !== undefined) return stringField(event, 'handleId');
  return [];
}

function referencedHandles(event: RhiCallEvent): readonly string[] {
  const keys = [
    'sourceHandleId',
    'layoutHandleId',
    'vertexShaderModuleHandleId',
    'fragmentShaderModuleHandleId',
    'computeShaderModuleHandleId',
    'handleId',
    'bufferHandleId',
    'textureHandleId',
    'source',
    'destination',
    'resourceHandleIds',
    'bindGroupHandleId',
    'pipelineHandleId',
    'indexBufferHandleId',
    'vertexBufferHandleId',
  ];
  return keys.flatMap((key) => stringField(event, key));
}

function writtenHandles(event: RhiCallEvent): readonly string[] {
  if (event.kind === 'writeBuffer' || event.kind === 'writeTexture')
    return stringField(event, 'handleId');
  if (
    event.kind === 'copyBufferToBuffer' ||
    event.kind === 'copyBufferToTexture' ||
    event.kind === 'copyTextureToBuffer' ||
    event.kind === 'copyTextureToTexture'
  )
    return stringField(event, 'destination');
  return [];
}

function stringField(event: object, key: string): readonly string[] {
  const value = (event as Record<string, unknown>)[key];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}
