import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  PipelineLayout,
  RhiCommandEncoder,
  RhiComputePipelineOps,
  RhiDevice,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { type BindGroupLayoutDescriptor, err, ok, type Result } from '@forgeax/engine-types';
import { type RenderError, RenderFeaturePreparationFailedError } from '../errors/render';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { PreparedGraphicsResourceLease } from '../prepare/prepared-graphics-resolver';

declare const RenderFeatureGpuProgramBrand: unique symbol;
export interface RenderFeatureGpuProgramRef {
  readonly [RenderFeatureGpuProgramBrand]: void;
  readonly generation: number;
}

declare const RenderFeatureGpuBufferBrand: unique symbol;
export interface RenderFeatureGpuBufferRef {
  readonly [RenderFeatureGpuBufferBrand]: void;
  readonly name: string;
  readonly generation: number;
}

declare const RenderFeatureGpuBindingsBrand: unique symbol;
export interface RenderFeatureGpuBindingsRef {
  readonly [RenderFeatureGpuBindingsBrand]: void;
  readonly generation: number;
}

export type RenderFeatureGpuBufferUsage = 'storage' | 'uniform' | 'indirect' | 'vertex' | 'index';

export interface RenderFeatureGpuProgramDescriptor {
  readonly wgsl: string;
  readonly entryPoints: readonly string[];
  readonly bindings?: readonly BindGroupLayoutDescriptor[];
}

export interface RenderFeatureGpuBufferDescriptor {
  readonly size: number;
  readonly usage: readonly RenderFeatureGpuBufferUsage[];
  readonly data?: ArrayBufferView;
}

export interface RenderFeatureGpuBindingsDescriptor {
  readonly program: RenderFeatureGpuProgramRef;
  readonly entries: readonly {
    readonly binding: number;
    readonly buffer: RenderFeatureGpuBufferRef;
  }[];
}

export interface RenderFeatureGpuPrepare {
  retainBindings(references: readonly RenderFeatureGpuBindingsRef[]): Result<void, RenderError>;
  prepareProgram(
    name: string,
    descriptor: RenderFeatureGpuProgramDescriptor,
  ): Result<RenderFeatureGpuProgramRef, RenderError>;
  prepareBuffer(
    name: string,
    descriptor: RenderFeatureGpuBufferDescriptor,
  ): Result<RenderFeatureGpuBufferRef, RenderError>;
  prepareBindings(
    name: string,
    descriptor: RenderFeatureGpuBindingsDescriptor,
  ): Result<RenderFeatureGpuBindingsRef, RenderError>;
}

export interface RenderFeatureGpuDispatch {
  readonly entryPoint: string;
  readonly workgroups: readonly [number, number?, number?];
  readonly bindings?: RenderFeatureGpuBindingsRef;
}

export interface RenderFeatureGpuComputePassDescriptor {
  readonly program: RenderFeatureGpuProgramRef;
  readonly bindings: RenderFeatureGpuBindingsRef;
  readonly dispatches: readonly RenderFeatureGpuDispatch[];
}

export interface RenderFeatureResolvedGpuComputePass {
  record(encoder: RhiCommandEncoder): Result<void, RenderError>;
}

export interface RenderFeatureGpuWorkResolver extends RenderFeatureGpuPrepare {
  beginFrame(): void;
  resolveComputePass(
    featureIdentity: string,
    descriptor: RenderFeatureGpuComputePassDescriptor,
  ): Result<RenderFeatureResolvedGpuComputePass, RenderError>;
  resolveBuffer(reference: RenderFeatureGpuBufferRef): Buffer | undefined;
  retireUntouched(): readonly PreparedGraphicsResourceLease[];
  dispose(): Result<void, RenderError>;
}

interface ProgramItem {
  readonly name: string;
  readonly signature: string;
  readonly reference: RenderFeatureGpuProgramRef;
  readonly module: ShaderModule;
  readonly pipelines: ReadonlyMap<string, ComputePipeline>;
  readonly bindGroupLayout?: BindGroupLayout;
}

interface BufferItem {
  readonly name: string;
  readonly signature: string;
  readonly reference: RenderFeatureGpuBufferRef;
  readonly buffer: Buffer;
}

interface BindingsItem {
  readonly name: string;
  readonly signature: string;
  readonly reference: RenderFeatureGpuBindingsRef;
  readonly program: ProgramItem;
  readonly buffers: readonly BufferItem[];
  readonly bindGroup: BindGroup;
}

const BUFFER_USAGE = {
  storage: 0x0080,
  uniform: 0x0040,
  indirect: 0x0100,
  vertex: 0x0020,
  index: 0x0010,
} as const;
const COPY_DST = 0x0008;

function alignedSize(size: number): number {
  return Math.max(4, Math.ceil(size / 4) * 4);
}

function bytes(value: ArrayBufferView): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function failure(
  featureIdentity: string,
  operation: string,
  kind: string,
  name: string,
  reason: string,
): RenderFeaturePreparationFailedError {
  const recovery = reason.startsWith('rhi-not-available:') ? 'next-frame' : 'renderer-recover';
  return new RenderFeaturePreparationFailedError(
    featureIdentity,
    -1,
    operation,
    kind as never,
    name,
    reason,
    recovery,
  );
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${key}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function rhiReason(error: {
  readonly code: string;
  readonly hint: string;
  readonly detail?: unknown;
}): string {
  const detail = error.detail === undefined ? '' : `:${stable(error.detail)}`;
  return `${error.code}:${error.hint}${detail}`;
}

export function createRenderFeatureGpuWorkResolver(input: {
  readonly device: RhiDevice;
  readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
  readonly generation: number;
  readonly featureIdentity: string;
}): RenderFeatureGpuWorkResolver {
  const programs = new Map<string, ProgramItem>();
  const programRefs = new Map<object, ProgramItem>();
  const buffers = new Map<string, BufferItem>();
  const bufferRefs = new Map<object, BufferItem>();
  const bindings = new Map<string, BindingsItem>();
  const bindingRefs = new Map<object, BindingsItem>();
  const touchedPrograms = new Set<ProgramItem>();
  const touchedBuffers = new Set<BufferItem>();
  const touchedBindings = new Set<BindingsItem>();

  const touchProgram = (item: ProgramItem): void => {
    touchedPrograms.add(item);
  };
  const touchBuffer = (item: BufferItem): void => {
    touchedBuffers.add(item);
  };
  const touchBindings = (item: BindingsItem): void => {
    touchedBindings.add(item);
    touchProgram(item.program);
    for (const buffer of item.buffers) touchBuffer(buffer);
  };

  const prepareProgram: RenderFeatureGpuPrepare['prepareProgram'] = (name, descriptor) => {
    const signature = stable(descriptor);
    const prior = programs.get(name);
    if (prior !== undefined) {
      touchProgram(prior);
      return prior.signature === signature
        ? ok(prior.reference)
        : err(
            failure(
              input.featureIdentity,
              'prepare-gpu-program',
              'pipeline',
              name,
              'signature-mismatch',
            ),
          );
    }
    if (name.length === 0 || descriptor.wgsl.length === 0 || descriptor.entryPoints.length === 0) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-program',
          'pipeline',
          name,
          'descriptor-invalid',
        ),
      );
    }
    const module = input.shaderModuleFactory.createShaderModule({
      label: name,
      code: descriptor.wgsl,
    });
    if (!module.ok) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-program',
          'pipeline',
          name,
          rhiReason(module.error),
        ),
      );
    }
    let bindGroupLayout: BindGroupLayout | undefined;
    let pipelineLayout: 'auto' | PipelineLayout = 'auto';
    if (descriptor.bindings !== undefined) {
      if (descriptor.bindings.length !== 1) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-program',
            'pipeline',
            name,
            'one-bind-group-required',
          ),
        );
      }
      const reflected = descriptor.bindings[0];
      if (reflected === undefined) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-program',
            'pipeline',
            name,
            'one-bind-group-required',
          ),
        );
      }
      const createdLayout = input.device.createBindGroupLayout({
        ...(reflected.label === undefined ? {} : { label: reflected.label }),
        entries: reflected.entries.map((entry) => ({
          binding: entry.binding,
          visibility: entry.visibility,
          ...(entry.buffer === undefined ? {} : { buffer: entry.buffer }),
          ...(entry.sampler === undefined ? {} : { sampler: entry.sampler }),
          ...(entry.texture === undefined ? {} : { texture: entry.texture }),
          ...(entry.storageTexture === undefined ? {} : { storageTexture: entry.storageTexture }),
        })),
      });
      if (!createdLayout.ok) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-program',
            'pipeline',
            name,
            createdLayout.error.code,
          ),
        );
      }
      bindGroupLayout = createdLayout.value;
      const createdPipelineLayout = input.device.createPipelineLayout({
        label: `${name}.layout`,
        bindGroupLayouts: [bindGroupLayout],
      });
      if (!createdPipelineLayout.ok) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-program',
            'pipeline',
            name,
            createdPipelineLayout.error.code,
          ),
        );
      }
      pipelineLayout = createdPipelineLayout.value;
    }
    const pipelineMap = new Map<string, ComputePipeline>();
    for (const entryPoint of descriptor.entryPoints) {
      const pipeline = input.device.createComputePipeline({
        label: `${name}.${entryPoint}`,
        layout: pipelineLayout,
        compute: { module: module.value, entryPoint },
      });
      if (!pipeline.ok) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-program',
            'pipeline',
            name,
            pipeline.error.code,
          ),
        );
      }
      pipelineMap.set(entryPoint, pipeline.value);
    }
    const reference = Object.freeze({ generation: input.generation }) as RenderFeatureGpuProgramRef;
    const item = {
      name,
      signature,
      reference,
      module: module.value,
      pipelines: pipelineMap,
      ...(bindGroupLayout === undefined ? {} : { bindGroupLayout }),
    };
    programs.set(name, item);
    programRefs.set(reference, item);
    touchProgram(item);
    return ok(reference);
  };

  const prepareBuffer: RenderFeatureGpuPrepare['prepareBuffer'] = (name, descriptor) => {
    if (
      !Number.isInteger(descriptor.size) ||
      descriptor.size <= 0 ||
      descriptor.usage.length === 0
    ) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-buffer',
          'vertex-data',
          name,
          'descriptor-invalid',
        ),
      );
    }
    const signature = stable({ size: descriptor.size, usage: [...descriptor.usage].sort() });
    let item = buffers.get(name);
    if (item !== undefined && item.signature !== signature) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-buffer',
          'vertex-data',
          name,
          'signature-mismatch',
        ),
      );
    }
    if (item === undefined) {
      const usage = descriptor.usage.reduce((bits, key) => bits | BUFFER_USAGE[key], COPY_DST);
      const created = input.device.createBuffer({
        label: name,
        size: alignedSize(descriptor.size),
        usage,
      });
      if (!created.ok) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-buffer',
            'vertex-data',
            name,
            created.error.code,
          ),
        );
      }
      const reference = Object.freeze({
        name,
        generation: input.generation,
      }) as RenderFeatureGpuBufferRef;
      item = { name, signature, reference, buffer: created.value };
      buffers.set(name, item);
      bufferRefs.set(reference, item);
    }
    touchBuffer(item);
    if (descriptor.data !== undefined) {
      if (descriptor.data.byteLength > descriptor.size) {
        return err(
          failure(
            input.featureIdentity,
            'write-gpu-buffer',
            'vertex-data',
            name,
            'data-exceeds-size',
          ),
        );
      }
      const written = input.device.queue.writeBuffer(item.buffer, 0, bytes(descriptor.data));
      if (!written.ok) {
        return err(
          failure(
            input.featureIdentity,
            'write-gpu-buffer',
            'vertex-data',
            name,
            written.error.code,
          ),
        );
      }
    }
    return ok(item.reference);
  };

  const prepareBindings: RenderFeatureGpuPrepare['prepareBindings'] = (name, descriptor) => {
    const program = programRefs.get(descriptor.program as object);
    if (program === undefined || descriptor.program.generation !== input.generation) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-bindings',
          'bindings',
          name,
          'program-unavailable',
        ),
      );
    }
    const entryItems = descriptor.entries.map((entry) => ({
      binding: entry.binding,
      item: bufferRefs.get(entry.buffer as object),
    }));
    if (entryItems.some((entry) => entry.item === undefined)) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-bindings',
          'bindings',
          name,
          'buffer-unavailable',
        ),
      );
    }
    const availableEntries = entryItems.flatMap((entry) =>
      entry.item === undefined ? [] : [{ binding: entry.binding, item: entry.item }],
    );
    const signature = stable({
      program: program.name,
      entries: availableEntries.map((entry) => [entry.binding, entry.item.name]),
    });
    const prior = bindings.get(name);
    if (prior !== undefined) {
      touchBindings(prior);
      return prior.signature === signature
        ? ok(prior.reference)
        : err(
            failure(
              input.featureIdentity,
              'prepare-gpu-bindings',
              'bindings',
              name,
              'signature-mismatch',
            ),
          );
    }
    const firstPipeline = program.pipelines.values().next().value as
      | (ComputePipeline & RhiComputePipelineOps)
      | undefined;
    const layout = program.bindGroupLayout ?? firstPipeline?.getBindGroupLayout(0);
    if (layout === undefined) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-bindings',
          'bindings',
          name,
          'layout-unavailable',
        ),
      );
    }
    const created = input.device.createBindGroup({
      label: name,
      layout,
      entries: availableEntries.map((entry) => ({
        binding: entry.binding,
        resource: {
          kind: 'buffer' as const,
          value: { buffer: entry.item.buffer },
        },
      })),
    });
    if (!created.ok) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-bindings',
          'bindings',
          name,
          created.error.code,
        ),
      );
    }
    const reference = Object.freeze({
      generation: input.generation,
    }) as RenderFeatureGpuBindingsRef;
    const item = {
      name,
      signature,
      reference,
      program,
      buffers: availableEntries.map((entry) => entry.item),
      bindGroup: created.value,
    };
    bindings.set(name, item);
    bindingRefs.set(reference, item);
    touchBindings(item);
    return ok(reference);
  };

  return {
    beginFrame: () => {
      touchedPrograms.clear();
      touchedBuffers.clear();
      touchedBindings.clear();
    },
    retainBindings: (references) => {
      for (const reference of references) {
        const item = bindingRefs.get(reference as object);
        if (item === undefined || reference.generation !== input.generation) {
          return err(
            failure(
              input.featureIdentity,
              'retain-gpu-bindings',
              'bindings',
              'persistent-bindings',
              'bindings-unavailable',
            ),
          );
        }
        touchBindings(item);
      }
      return ok(undefined);
    },
    prepareProgram,
    prepareBuffer,
    prepareBindings,
    resolveComputePass: (featureIdentity, descriptor) => {
      const program = programRefs.get(descriptor.program as object);
      const binding = bindingRefs.get(descriptor.bindings as object);
      const dispatchBindings = descriptor.dispatches.map((dispatch) =>
        dispatch.bindings === undefined ? binding : bindingRefs.get(dispatch.bindings as object),
      );
      if (
        program === undefined ||
        binding === undefined ||
        dispatchBindings.some((item) => item === undefined) ||
        descriptor.program.generation !== input.generation ||
        descriptor.bindings.generation !== input.generation
      ) {
        const reason =
          program === undefined
            ? 'program-unavailable'
            : binding === undefined
              ? 'bindings-unavailable'
              : dispatchBindings.some((item) => item === undefined)
                ? 'dispatch-bindings-unavailable'
                : 'generation-mismatch';
        return err(
          failure(
            featureIdentity,
            'resolve-gpu-compute',
            'bindings',
            program?.name ?? 'program',
            reason,
          ),
        );
      }
      touchProgram(program);
      touchBindings(binding);
      for (const dispatchBinding of dispatchBindings) {
        if (dispatchBinding !== undefined) touchBindings(dispatchBinding);
      }
      for (const dispatch of descriptor.dispatches) {
        if (
          program.pipelines.get(dispatch.entryPoint) === undefined ||
          dispatch.workgroups[0] <= 0
        ) {
          return err(
            failure(
              featureIdentity,
              'resolve-gpu-compute',
              'pipeline',
              dispatch.entryPoint,
              program.pipelines.has(dispatch.entryPoint)
                ? 'workgroup-count-invalid'
                : 'entry-point-unavailable',
            ),
          );
        }
      }
      return ok({
        record: (encoder) => {
          const pass = encoder.beginComputePass({ label: `${featureIdentity}.compute` });
          try {
            for (const [index, dispatch] of descriptor.dispatches.entries()) {
              const pipeline = program.pipelines.get(dispatch.entryPoint);
              const dispatchBinding = dispatchBindings[index];
              if (pipeline === undefined || dispatchBinding === undefined) {
                return err(
                  failure(
                    featureIdentity,
                    'record-gpu-compute',
                    pipeline === undefined ? 'pipeline' : 'bindings',
                    dispatch.entryPoint,
                    'resolved-resource-unavailable',
                  ),
                );
              }
              pass.setPipeline(pipeline);
              pass.setBindGroup(0, dispatchBinding.bindGroup);
              pass.dispatchWorkgroups(
                dispatch.workgroups[0],
                dispatch.workgroups[1] ?? 1,
                dispatch.workgroups[2] ?? 1,
              );
            }
          } finally {
            pass.end();
          }
          return ok(undefined);
        },
      });
    },
    resolveBuffer: (reference) => {
      const item = bufferRefs.get(reference as object);
      if (item !== undefined) touchBuffer(item);
      return item?.buffer;
    },
    retireUntouched: () => {
      for (const [name, item] of bindings) {
        if (touchedBindings.has(item)) continue;
        bindings.delete(name);
        bindingRefs.delete(item.reference as object);
      }
      for (const [name, item] of programs) {
        if (touchedPrograms.has(item)) continue;
        programs.delete(name);
        programRefs.delete(item.reference as object);
      }
      const retired: BufferItem[] = [];
      for (const [name, item] of buffers) {
        if (touchedBuffers.has(item)) continue;
        buffers.delete(name);
        bufferRefs.delete(item.reference as object);
        retired.push(item);
      }
      if (retired.length === 0) return [];
      let released = false;
      return [
        {
          release: () => {
            if (released) return ok(undefined);
            released = true;
            let first: RenderError | undefined;
            for (const item of retired) {
              const destroyed = input.device.destroyBuffer(item.buffer);
              if (!destroyed.ok && first === undefined) {
                first = failure(
                  input.featureIdentity,
                  'retire-gpu-buffer',
                  'vertex-data',
                  item.name,
                  destroyed.error.code,
                );
              }
            }
            return first === undefined ? ok(undefined) : err(first);
          },
        },
      ];
    },
    dispose: () => {
      let first: RenderError | undefined;
      for (const item of buffers.values()) {
        const destroyed = input.device.destroyBuffer(item.buffer);
        if (!destroyed.ok && first === undefined) {
          first = failure(
            input.featureIdentity,
            'dispose-gpu-buffer',
            'vertex-data',
            item.name,
            destroyed.error.code,
          );
        }
      }
      programs.clear();
      buffers.clear();
      bindings.clear();
      return first === undefined ? ok(undefined) : err(first);
    },
  };
}
