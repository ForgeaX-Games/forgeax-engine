import type { RenderResult } from './renderer';

export interface ExtractedFrame {
  readonly worlds: readonly unknown[];
}
export interface PreparedFrame {
  readonly extracted: ExtractedFrame;
  readonly resources: Map<unknown, unknown>;
}
export function buildFrameChain(worlds: readonly unknown[]): ExtractedFrame {
  return { worlds };
}
export function prepareFrame(
  extracted: ExtractedFrame,
  options: { resources: Map<unknown, unknown> },
): PreparedFrame {
  return { extracted, resources: options.resources };
}
export function recordFrame(_frame: PreparedFrame): RenderResult<void, Error> {
  return { ok: true, value: undefined };
}
