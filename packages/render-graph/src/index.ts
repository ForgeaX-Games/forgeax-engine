// @forgeax/engine-render-graph -- declarative render-graph abstraction.
//
// Public surface (charter proposition 1: progressive disclosure):
// - RenderGraph / PassDescriptor / ResourceDescriptor -- core primitives
// - RenderGraphError / RenderGraphErrorCode -- closed-union error model
// - Result<T, E> / ok / err -- binary result type
// - PassInfo / ResourceInfo -- query interfaces

export {
  err,
  type InvalidFormatDetail,
  ok,
  RenderGraphError,
  type RenderGraphErrorCode,
  type RenderGraphErrorDetail,
  type ResourceAllocFailedDetail,
  type Result,
  type ResultErr,
  type ResultOk,
} from './errors.js';
export type {
  BufferRole,
  ColorTargetDescriptor,
  ColorTargetHandle,
  ColorTargetSize,
  CompileOptions,
  InternalizedGraph,
  InternalizedPass,
  PassDescriptor,
  PassInfo,
  ResolveContext,
  ResolvedBuffer,
  ResolvedBufferType,
  ResourceDescriptor,
  ResourceInfo,
  ResourceKind,
  ResourceLifetime,
} from './graph.js';
export { RenderGraph } from './graph.js';
