/**
 * Browser-visible render progress owned by the App frame loop.
 *
 * The Renderer already emits `frame-submitted` after its sole queue-submit
 * boundary. This adapter projects that event onto the document without
 * exposing a renderer handle or creating a second readiness registry. DevKit
 * capture waits on the same projection, then verifies compositor pixels.
 */

export const FORGEAX_FRAME_SUBMITTED_DATASET = 'forgeaxFrameSubmitted';
export const FORGEAX_FRAME_SUBMITTED_EVENT = 'forgeax:frame-submitted';

export interface BrowserFrameSubmitted {
  readonly frameId: number;
  readonly deviceGeneration: number;
}

export function resetBrowserFrameSubmitted(canvas: HTMLCanvasElement): void {
  const documentElement = canvas.ownerDocument?.documentElement;
  if (documentElement !== undefined) {
    delete documentElement.dataset[FORGEAX_FRAME_SUBMITTED_DATASET];
  }
}

export function publishBrowserFrameSubmitted(
  canvas: HTMLCanvasElement,
  event: BrowserFrameSubmitted,
): void {
  const documentElement = canvas.ownerDocument?.documentElement;
  if (documentElement !== undefined) {
    documentElement.dataset[FORGEAX_FRAME_SUBMITTED_DATASET] = String(event.frameId);
  }
  // Native/Web test canvases may be structural objects without DOM event
  // methods. The dataset projection above remains optional as well, so the
  // signal must stay a no-op outside a browser host instead of poisoning the
  // frame loop with a listener exception.
  if (typeof CustomEvent === 'function' && typeof canvas.dispatchEvent === 'function') {
    canvas.dispatchEvent(
      new CustomEvent(FORGEAX_FRAME_SUBMITTED_EVENT, {
        detail: Object.freeze({ ...event }),
      }),
    );
  }
}
