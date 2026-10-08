import type {
  RenderBundle,
  RenderBundleEncoderDescriptor,
  RhiDevice,
  RhiRenderCommands,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';

type Method = keyof RhiRenderCommands;
type Command = { readonly method: Method; readonly args: readonly unknown[] };
type DynamicState = 'setViewport' | 'setScissorRect' | 'setBlendConstant' | 'setStencilReference';

/** Mutable hit/miss tally; one lookup per recorded segment that draws. */
export interface RenderBundleCounters {
  hits: number;
  misses: number;
}

interface Segment {
  readonly commands: Command[];
  bundle: RenderBundle | undefined;
}

/** Consecutive churned frames (any drawing segment re-recorded) before probing backs off. */
const IDLE_FRAMES_BEFORE_BACKOFF = 4;
const MAX_BYPASS_FRAMES = 64;

function equalArgs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return (
    a.length === b.length &&
    a.every((value, index) => {
      const other = b[index];
      return Array.isArray(value) && Array.isArray(other)
        ? value.length === other.length && value.every((n, i) => n === other[i])
        : value === other;
    })
  );
}

function replay(commands: readonly Command[], target: RhiRenderCommands, from = 0): void {
  for (let index = from; index < commands.length; index++) {
    const command = commands[index];
    if (command !== undefined) Reflect.apply(target[command.method], target, command.args);
  }
}

/**
 * One compiled scene pass owns an ordered list of command segments. A segment
 * starts at each `setPipeline` after a draw (one batch) or after a command a
 * bundle cannot hold, and is prefixed with the pipeline, bind group and
 * vertex/index state it inherits, so it is self-contained under WebGPU's
 * state reset after `executeBundles`. No asset or World revisions: physical
 * handles and draw arguments are the command authority.
 *
 * A segment is admitted after two matching frames and invalidated on its own
 * mismatch, so one changed batch re-records only that batch. Consecutive
 * bundles share one `executeBundles`. A pass that re-records any drawing
 * segment on several consecutive frames backs off to the direct path for a
 * bounded, growing number of frames. Partial reuse of a churning pass does
 * not pay: every executed bundle restarts from WebGPU's reset pass state and
 * replays its prelude, so a pass split into many small bundles costs more
 * queue time than direct encoding, on top of the proxy's per-command
 * compare. A pass that settles (a frame without a re-recorded segment)
 * resets the backoff.
 */
export class RenderBundleCache {
  private device: RhiDevice | undefined;
  private segments: Segment[] = [];
  private idleFrames = 0;
  private bypassFrames = 0;
  private backoff = 0;

  constructor(private readonly descriptor: RenderBundleEncoderDescriptor) {}

  encode(
    device: RhiDevice,
    pass: RhiRenderPassEncoder,
    record: (pass: RhiRenderPassEncoder) => void,
    counters?: RenderBundleCounters,
  ): void {
    if (this.device !== device) {
      this.device = device;
      this.reset();
    }
    if (this.bypassFrames > 0) {
      this.bypassFrames -= 1;
      record(pass);
      return;
    }
    const retainedSegments = this.segments;
    const nextSegments: Segment[] = [];
    const pending: RenderBundle[] = [];
    let reusedSegments = 0;
    let drawSegments = 0;
    let missedSegments = 0;

    // Tracked pass state, used as each segment's inherited prelude.
    let pipeline: Command | undefined;
    const groups: (Command | undefined)[] = [];
    const vertexBuffers: (Command | undefined)[] = [];
    let indexBuffer: Command | undefined;
    // True while the pass holds exactly the tracked state (no bundle since
    // the last direct emission), so a direct segment may skip its prelude.
    let passStateCurrent = true;
    let inOcclusion = false;

    let open = false;
    let retained: Segment | undefined;
    let fresh: Command[] | undefined;
    let cursor = 0;
    let preludeLength = 0;
    let hasDraw = false;

    const push = (method: Method, args: readonly unknown[]): Command => {
      if (fresh === undefined) {
        const old = retained?.commands[cursor];
        if (old !== undefined && old.method === method && equalArgs(old.args, args)) {
          cursor++;
          return old;
        }
        fresh = retained === undefined ? [] : retained.commands.slice(0, cursor);
      }
      const command = { method, args };
      fresh.push(command);
      cursor++;
      return command;
    };
    const pushTracked = (command: Command | undefined) => {
      if (command !== undefined) push(command.method, command.args);
    };
    const openSegment = (withPipeline: boolean) => {
      open = true;
      retained = retainedSegments[nextSegments.length];
      fresh = undefined;
      cursor = 0;
      hasDraw = false;
      if (withPipeline) pushTracked(pipeline);
      for (const group of groups) pushTracked(group);
      for (const vertex of vertexBuffers) pushTracked(vertex);
      pushTracked(indexBuffer);
      preludeLength = cursor;
    };
    const flushBundles = () => {
      if (pending.length === 0) return;
      const executed = pass.executeBundles(pending.splice(0));
      if (!executed.ok) throw executed.error;
      passStateCurrent = false;
    };
    const emitDirect = (commands: readonly Command[], prelude: number) => {
      flushBundles();
      replay(commands, pass, passStateCurrent ? prelude : 0);
      passStateCurrent = true;
    };
    const closeSegment = () => {
      if (!open) return;
      open = false;
      const matched =
        fresh === undefined && retained !== undefined && cursor === retained.commands.length;
      const segment: Segment =
        matched && retained !== undefined
          ? retained
          : {
              commands: fresh ?? retained?.commands.slice(0, cursor) ?? [],
              bundle: undefined,
            };
      nextSegments.push(segment);
      if (!hasDraw || inOcclusion) {
        emitDirect(segment.commands, preludeLength);
        return;
      }
      drawSegments += 1;
      if (matched) {
        reusedSegments += 1;
        if (segment.bundle !== undefined) {
          if (counters !== undefined) counters.hits += 1;
        } else {
          if (counters !== undefined) counters.misses += 1;
          const encoder = device.createRenderBundleEncoder(this.descriptor);
          if (!encoder.ok) throw encoder.error;
          replay(segment.commands, encoder.value);
          const finished = encoder.value.finish();
          if (!finished.ok) throw finished.error;
          segment.bundle = finished.value;
        }
        pending.push(segment.bundle);
        return;
      }
      missedSegments += 1;
      if (counters !== undefined) counters.misses += 1;
      emitDirect(segment.commands, preludeLength);
    };
    const barrier = () => {
      closeSegment();
      flushBundles();
    };
    const bundled = (method: Method, args: readonly unknown[]): void => {
      if (method === 'setPipeline' && open && hasDraw) closeSegment();
      if (!open) openSegment(method !== 'setPipeline');
      const command = push(method, args);
      switch (method) {
        case 'setPipeline':
          pipeline = command;
          break;
        case 'setBindGroup':
          groups[args[0] as number] = command;
          break;
        case 'setVertexBuffer':
          vertexBuffers[args[0] as number] = command;
          break;
        case 'setIndexBuffer':
          indexBuffer = command;
          break;
        default:
          hasDraw = true;
      }
    };
    const state = (method: DynamicState, args: unknown[]) => {
      barrier();
      Reflect.apply(pass[method], pass, args);
    };
    const proxy: RhiRenderPassEncoder = {
      setPipeline: (...args) => bundled('setPipeline', args),
      setVertexBuffer: (...args) => bundled('setVertexBuffer', args),
      setIndexBuffer: (...args) => bundled('setIndexBuffer', args),
      setBindGroup: (
        index,
        group,
        offsets?: readonly number[] | Uint32Array,
        start?: number,
        length?: number,
      ) => {
        const first = offsets instanceof Uint32Array ? (start ?? 0) : 0;
        const count =
          offsets instanceof Uint32Array ? (length ?? offsets.length) : (offsets?.length ?? 0);
        if (
          !Number.isSafeInteger(first) ||
          !Number.isSafeInteger(count) ||
          first < 0 ||
          count < 0 ||
          first + count > (offsets?.length ?? 0)
        ) {
          // Preserve the backend's original overload and validation. Never clamp
          // invalid slices into a different, potentially valid binding.
          barrier();
          Reflect.apply(pass.setBindGroup, pass, [index, group, offsets, start, length]);
          return;
        }
        const old = open ? retained?.commands[cursor] : undefined;
        const previous = old?.method === 'setBindGroup' ? old.args[2] : undefined;
        let selected: number[];
        if (
          Array.isArray(previous) &&
          previous.length === count &&
          previous.every((n, i) => n === offsets?.[first + i])
        ) {
          selected = previous;
        } else {
          selected = [];
          for (let i = 0; i < count; i++) selected.push(offsets?.[first + i] as number);
        }
        bundled('setBindGroup', [index, group, selected]);
      },
      draw: (...args) => bundled('draw', args),
      drawIndexed: (...args) => bundled('drawIndexed', args),
      drawIndirect: (...args) => bundled('drawIndirect', args),
      drawIndexedIndirect: (...args) => bundled('drawIndexedIndirect', args),
      pushDebugGroup: (...args) => {
        barrier();
        pass.pushDebugGroup(...args);
      },
      popDebugGroup: () => {
        barrier();
        pass.popDebugGroup();
      },
      insertDebugMarker: (...args) => {
        barrier();
        pass.insertDebugMarker(...args);
      },
      setViewport: (...args) => state('setViewport', args),
      setScissorRect: (...args) => state('setScissorRect', args),
      setBlendConstant: (...args) => state('setBlendConstant', args),
      setStencilReference: (...args) => state('setStencilReference', args),
      // Query regions stay on the direct path: their draws are never bundled.
      beginOcclusionQuery: (...args) => {
        barrier();
        inOcclusion = true;
        return pass.beginOcclusionQuery(...args);
      },
      endOcclusionQuery: () => {
        barrier();
        inOcclusion = false;
        return pass.endOcclusionQuery();
      },
      executeBundles: (bundles) => {
        barrier();
        // WebGPU clears pipeline, bind group and vertex/index state here.
        pipeline = undefined;
        groups.length = 0;
        vertexBuffers.length = 0;
        indexBuffer = undefined;
        passStateCurrent = true;
        return pass.executeBundles(bundles);
      },
      end: () => {
        barrier();
        pass.end();
      },
    };
    try {
      record(proxy);
      barrier();
    } catch (error) {
      this.reset();
      throw error;
    }
    this.segments = nextSegments;
    if (drawSegments > 0 && missedSegments > 0) {
      this.idleFrames += 1;
      if (this.idleFrames >= IDLE_FRAMES_BEFORE_BACKOFF) {
        this.bypassFrames = Math.min(MAX_BYPASS_FRAMES, IDLE_FRAMES_BEFORE_BACKOFF << this.backoff);
        this.backoff += 1;
        this.idleFrames = 0;
        this.segments = [];
      }
    } else if (reusedSegments > 0) {
      this.idleFrames = 0;
      this.backoff = 0;
    }
  }

  private reset(): void {
    this.segments = [];
    this.idleFrames = 0;
    this.bypassFrames = 0;
    this.backoff = 0;
  }
}
