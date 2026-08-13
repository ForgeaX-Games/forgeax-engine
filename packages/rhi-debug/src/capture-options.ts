// @forgeax/engine-rhi-debug/src/capture-options -- shared node-free capture options.

/** Bounded controls shared by the browser and Dawn/Node capture adapters. */
export interface CaptureFramesOptions {
  /** Maximum time allowed for the frame-header GPU resource snapshot. */
  readonly snapshotTimeoutMs?: number;
}
