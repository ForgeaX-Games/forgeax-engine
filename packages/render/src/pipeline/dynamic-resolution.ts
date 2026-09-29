import type { DynamicResolutionData } from '../components/dynamic-resolution';
import type { GpuPassTimingFrame } from '../record/gpu-pass-timing/contract';
import { deriveRenderExtent, type RenderExtent } from './render-extent';

export interface DynamicResolutionInspection {
  readonly status: 'fixed' | 'warming' | 'adaptive' | 'unavailable';
  readonly targetGpuMs: number;
  readonly gpuMs: number | undefined;
  /** Dimensions of the last successful submit, never a pending graph. */
  readonly extent: RenderExtent | undefined;
}

/** Recover the full GPU interval, including gaps; a sum of pass costs is not a frame. */
export function gpuPassFrameMilliseconds(
  frame: GpuPassTimingFrame,
  viewId?: number,
): number | undefined {
  if (frame.droppedPassCount > 0 || frame.passes.length === 0) return;
  let first: bigint | undefined;
  let last: bigint | undefined;
  for (const pass of frame.passes) {
    if (viewId !== undefined && pass.viewId !== viewId) continue;
    if (pass.status !== 'measured') return;
    const begin = BigInt(pass.beginningTick);
    const end = BigInt(pass.endTick);
    if (end < begin) return;
    if (first === undefined || begin < first) first = begin;
    if (last === undefined || end > last) last = end;
  }
  return first === undefined || last === undefined
    ? undefined
    : (Number(last - first) * frame.timestampPeriodNanoseconds) / 1_000_000;
}

/** One bounded asynchronous feedback lane per Renderer; no World mutations or CPU clocks. */
export class DynamicResolutionController {
  #key = '';
  #owner: object | undefined;
  #revision = 0;
  #pending = false;
  #scale = 1;
  #parameters: DynamicResolutionData | undefined;
  #gpuMs: number | undefined;
  #samples = 0;
  #status: DynamicResolutionInspection['status'] = 'warming';
  #extent: RenderExtent | undefined;

  configure(
    parameters: DynamicResolutionData | undefined,
    owner: object,
    camera: number,
    width: number,
    height: number,
    generation: number,
    timingAvailable: boolean,
  ): RenderExtent | undefined {
    const key = `${camera}:${width}:${height}:${generation}:${timingAvailable}`;
    const contextChanged = key !== this.#key || owner !== this.#owner;
    const previous = this.#parameters;
    if (
      contextChanged ||
      parameters?.targetGpuMs !== previous?.targetGpuMs ||
      parameters?.minScale !== previous?.minScale ||
      parameters?.maxScale !== previous?.maxScale
    ) {
      const accepted = this.#extent;
      const scale = this.#scale;
      this.reset();
      this.#extent = accepted?.generation === generation ? accepted : undefined;
      this.#key = key;
      this.#owner = owner;
      this.#parameters = parameters;
      this.#scale =
        parameters === undefined
          ? 1
          : contextChanged || previous === undefined || !timingAvailable
            ? parameters.maxScale
            : Math.max(parameters.minScale, Math.min(parameters.maxScale, scale));
      this.#status =
        parameters?.minScale === parameters?.maxScale
          ? 'fixed'
          : timingAvailable
            ? 'warming'
            : 'unavailable';
    }
    return parameters === undefined
      ? undefined
      : deriveRenderExtent({
          outputWidth: width,
          outputHeight: height,
          requestedScale: this.#scale,
          generation,
          ...(parameters.minScale === parameters.maxScale
            ? {}
            : { minScale: parameters.minScale, maxScale: parameters.maxScale }),
        });
  }

  get needsSample(): boolean {
    return (
      this.#parameters !== undefined &&
      this.#status !== 'fixed' &&
      this.#status !== 'unavailable' &&
      !this.#pending
    );
  }

  get submittedExtent(): RenderExtent | undefined {
    return this.#extent;
  }

  commit(extent: RenderExtent | undefined): void {
    this.#extent = extent;
  }

  /** Call only after a successful submit. At most one readback can affect feedback. */
  observe(sample: Promise<number | undefined>): void {
    if (!this.needsSample) return;
    const revision = this.#revision;
    this.#pending = true;
    void sample
      .catch(() => undefined)
      .then((milliseconds) => {
        this.#pending = false;
        if (revision !== this.#revision) return;
        const parameters = this.#parameters;
        if (parameters === undefined) return;
        if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds <= 0) {
          // A failed/partial sample is not headroom. Retry on a later submitted frame.
          this.#samples = 0;
          this.#gpuMs = undefined;
          this.#status = 'warming';
          return;
        }
        this.#status = 'adaptive';
        this.#gpuMs =
          this.#gpuMs === undefined ? milliseconds : this.#gpuMs * 0.75 + milliseconds * 0.25;
        if (++this.#samples < 8) return;
        this.#samples = 0;
        const ratio = this.#gpuMs / parameters.targetGpuMs;
        if (ratio >= 0.85 && ratio <= 1.05) return;
        const desired = this.#scale * Math.sqrt(0.95 / ratio);
        const step = ratio > 1.05 ? -1 / 16 : 1 / 32;
        const limited =
          step < 0 ? Math.max(desired, this.#scale + step) : Math.min(desired, this.#scale + step);
        const scale = Math.max(
          parameters.minScale,
          Math.min(parameters.maxScale, Math.round(limited * 32) / 32),
        );
        if (scale !== this.#scale) {
          this.#scale = scale;
          this.#gpuMs = undefined;
        }
      });
  }

  reset(): void {
    this.#revision++;
    this.#key = '';
    this.#owner = undefined;
    this.#parameters = undefined;
    this.#samples = 0;
    this.#gpuMs = undefined;
    this.#extent = undefined;
  }

  inspect(): DynamicResolutionInspection | undefined {
    return this.#parameters === undefined
      ? undefined
      : Object.freeze({
          status: this.#status,
          targetGpuMs: this.#parameters.targetGpuMs,
          gpuMs: this.#gpuMs,
          extent: this.#extent,
        });
  }
}
