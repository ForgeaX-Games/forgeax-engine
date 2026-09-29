import type {
  RenderBundle,
  RenderBundleEncoderDescriptor,
  RhiDevice,
  RhiRenderCommands,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';

type Method = keyof RhiRenderCommands;
type Command = { readonly method: Method; readonly args: readonly unknown[] };

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

function replay(commands: readonly Command[], target: RhiRenderCommands): void {
  for (const command of commands) Reflect.apply(target[command.method], target, command.args);
}

/** One compiled scene pass owns one last successful sequence. No asset or World
 * revisions: physical handles and draw arguments are the command authority.
 * Uniform/indirect buffer contents remain live; graph retirement drops the cache.
 */
export class RenderBundleCache {
  private device: RhiDevice | undefined;
  private commands: readonly Command[] = [];
  private bundle: RenderBundle | undefined;

  constructor(private readonly descriptor: RenderBundleEncoderDescriptor) {}

  encode(
    device: RhiDevice,
    pass: RhiRenderPassEncoder,
    record: (pass: RhiRenderPassEncoder) => void,
  ): void {
    if (this.device !== device) {
      this.device = device;
      this.commands = [];
      this.bundle = undefined;
    }
    let cursor = 0;
    let changed: Command[] | undefined;
    let direct = false;
    let hasDraw = false;
    const current = () => changed ?? this.commands.slice(0, cursor);
    const append = (method: Method, args: readonly unknown[]) => {
      if (direct) {
        Reflect.apply(pass[method], pass, args);
        return;
      }
      if (method.startsWith('draw')) hasDraw = true;
      const old = this.commands[cursor];
      if (changed === undefined && (old?.method !== method || !equalArgs(old.args, args))) {
        changed = this.commands.slice(0, cursor);
      }
      changed?.push({ method, args });
      cursor++;
    };
    // A state change after a draw cannot be encoded inside a render bundle.
    // Replay the pending prefix directly, then preserve the original ordering.
    const flushDirect = () => {
      if (direct) return;
      replay(current(), pass);
      direct = true;
      this.commands = [];
      this.bundle = undefined;
    };
    const state = (
      method: 'setViewport' | 'setScissorRect' | 'setBlendConstant' | 'setStencilReference',
      args: unknown[],
    ) => {
      if (hasDraw) flushDirect();
      Reflect.apply(pass[method], pass, args);
    };
    const proxy: RhiRenderPassEncoder = {
      setPipeline: (...args) => append('setPipeline', args),
      setVertexBuffer: (...args) => append('setVertexBuffer', args),
      setIndexBuffer: (...args) => append('setIndexBuffer', args),
      setBindGroup(
        index,
        group,
        offsets?: readonly number[] | Uint32Array,
        start?: number,
        length?: number,
      ) {
        const values = offsets === undefined ? [] : Array.from(offsets);
        const selected =
          offsets instanceof Uint32Array
            ? values.slice(start ?? 0, (start ?? 0) + (length ?? values.length))
            : values;
        append('setBindGroup', [index, group, selected]);
      },
      draw: (...args) => append('draw', args),
      drawIndexed: (...args) => append('drawIndexed', args),
      drawIndirect: (...args) => append('drawIndirect', args),
      drawIndexedIndirect: (...args) => append('drawIndexedIndirect', args),
      pushDebugGroup: (...args) => {
        flushDirect();
        pass.pushDebugGroup(...args);
      },
      popDebugGroup: () => {
        flushDirect();
        pass.popDebugGroup();
      },
      insertDebugMarker: (...args) => {
        flushDirect();
        pass.insertDebugMarker(...args);
      },
      setViewport: (...args) => state('setViewport', args),
      setScissorRect: (...args) => state('setScissorRect', args),
      setBlendConstant: (...args) => state('setBlendConstant', args),
      setStencilReference: (...args) => state('setStencilReference', args),
      beginOcclusionQuery: (...args) => {
        flushDirect();
        return pass.beginOcclusionQuery(...args);
      },
      endOcclusionQuery: () => {
        flushDirect();
        return pass.endOcclusionQuery();
      },
      executeBundles: (bundles) => {
        flushDirect();
        return pass.executeBundles(bundles);
      },
      end: () => {
        flushDirect();
        pass.end();
      },
    };
    try {
      record(proxy);
      if (direct) return;
      if (changed !== undefined || cursor !== this.commands.length || !hasDraw) {
        this.commands = current();
        this.bundle = undefined;
        replay(this.commands, pass);
        return;
      }
      // Admit only after two matching frames, avoiding churn on dynamic lists.
      if (this.bundle === undefined) {
        const encoder = device.createRenderBundleEncoder(this.descriptor);
        if (!encoder.ok) throw encoder.error;
        replay(this.commands, encoder.value);
        const finished = encoder.value.finish();
        if (!finished.ok) throw finished.error;
        this.bundle = finished.value;
      }
      const executed = pass.executeBundles([this.bundle]);
      if (!executed.ok) throw executed.error;
    } catch (error) {
      this.commands = [];
      this.bundle = undefined;
      throw error;
    }
  }
}
