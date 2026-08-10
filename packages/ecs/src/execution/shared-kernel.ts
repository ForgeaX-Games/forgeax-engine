import type { Component, SchemaFieldType } from '../component';
import type { QueryDescriptor, QuerySpan } from '../query/query';
import type { SystemHandle } from '../schedule';
import {
  isKernelDispatchFailure,
  SHARED_KERNEL_EXECUTOR_RESOURCE_KEY,
  type SharedKernelExecutor,
} from './executor';
import { SharedKernelEligibilityError, SharedKernelFailureError } from './shared-kernel-errors';

export const SHARED_KERNEL_ELIGIBILITY_REASONS = [
  'callback-not-module-function',
  'dom-access',
  'missing-access-declaration',
  'descriptor-conflict',
  'object-field',
  'span-unavailable',
] as const;
export type SharedKernelEligibilityReason = (typeof SHARED_KERNEL_ELIGIBILITY_REASONS)[number];

export interface SharedKernelDefinition<Qs extends readonly QueryDescriptor[]> {
  readonly name: string;
  readonly queries: Qs;
  readonly run: (spans: readonly QuerySpan[]) => void;
  readonly minimumRows?: number;
  readonly before?: readonly (string | import('../schedule-token').ScheduleToken)[];
  readonly after?: readonly (string | import('../schedule-token').ScheduleToken)[];
}

export interface SharedKernelDispatch<
  Qs extends readonly QueryDescriptor[] = readonly QueryDescriptor[],
> {
  readonly kind: 'shared-kernel';
  readonly moduleUrl: string;
  readonly name: string;
  readonly minimumRows: number;
  readonly queries: Qs;
  readonly run: (spans: readonly QuerySpan[]) => void;
}

export interface SharedKernelHandle<
  Qs extends readonly QueryDescriptor[] = readonly QueryDescriptor[],
> extends SystemHandle<Qs>,
    SharedKernelDispatch<Qs> {}

const NUMERIC_FIELDS = new Set<SchemaFieldType>([
  'f32',
  'f64',
  'i32',
  'u32',
  'i16',
  'u16',
  'i8',
  'u8',
  'bool',
  'enum',
  'ref',
  'entity',
]);

function components(descriptor: QueryDescriptor): readonly Component[] {
  return [
    ...(descriptor.read ?? []),
    ...(descriptor.write ?? []),
    ...(descriptor.optional ?? []),
    ...(descriptor.with ?? []),
    ...(descriptor.without ?? []),
    ...(descriptor.changed ?? []),
    ...(descriptor.added ?? []),
  ];
}

function descriptorReason(descriptor: QueryDescriptor): SharedKernelEligibilityReason | undefined {
  if ((descriptor.read?.length ?? 0) + (descriptor.write?.length ?? 0) === 0) {
    return 'missing-access-declaration';
  }
  if (
    (descriptor.optional?.length ?? 0) > 0 ||
    (descriptor.changed?.length ?? 0) > 0 ||
    (descriptor.added?.length ?? 0) > 0
  ) {
    return 'span-unavailable';
  }
  const seen = new Set<number>();
  for (const component of components(descriptor)) {
    if (seen.has(component.id)) return 'descriptor-conflict';
    seen.add(component.id);
    if (component.storage === 'sparse') return 'span-unavailable';
    if (Object.values(component.schema).some((field) => !NUMERIC_FIELDS.has(field))) {
      return 'object-field';
    }
  }
  return undefined;
}

export function sharedKernelEligibility(
  moduleUrl: string,
  definition: SharedKernelDefinition<readonly QueryDescriptor[]>,
): SharedKernelEligibilityReason | undefined {
  try {
    new URL(moduleUrl);
  } catch {
    return 'callback-not-module-function';
  }
  const source = Function.prototype.toString.call(definition.run);
  if (definition.run.name.length === 0 || source.includes('=>')) {
    return 'callback-not-module-function';
  }
  if (/\b(?:document|window|globalThis|HTMLElement|GPUDevice|AudioContext)\b/u.test(source)) {
    return 'dom-access';
  }
  for (const query of definition.queries) {
    const reason = descriptorReason(query);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

export function defineSharedKernel<const Qs extends readonly QueryDescriptor[]>(
  moduleUrl: string,
  definition: SharedKernelDefinition<Qs>,
): SharedKernelHandle<Qs> {
  const reason = sharedKernelEligibility(moduleUrl, definition);
  if (reason !== undefined) throw new SharedKernelEligibilityError(definition.name, reason);

  const handle: SharedKernelHandle<Qs> = Object.freeze({
    kind: 'shared-kernel' as const,
    moduleUrl,
    name: definition.name,
    queries: definition.queries,
    minimumRows: definition.minimumRows ?? 16_384,
    run: definition.run,
    ...(definition.before !== undefined ? { before: definition.before } : {}),
    ...(definition.after !== undefined ? { after: definition.after } : {}),
    fn: (
      world: import('../world').World,
      queries: import('../schedule').SystemParamQueryResults<Qs>,
    ) => {
      const dispatchSpans: import('./executor').KernelDispatchSpan[] = [];
      for (const [queryIndex, query] of queries.entries()) {
        const result = query.spans();
        if (!result.ok) throw new SharedKernelEligibilityError(definition.name, 'span-unavailable');
        for (const span of result.value) dispatchSpans.push({ queryIndex, span });
      }
      const spans = dispatchSpans.map((entry) => entry.span);
      const totalRows = spans.reduce((sum, span) => sum + span.length, 0);
      try {
        if (
          totalRows < (definition.minimumRows ?? 16_384) ||
          !world.hasResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY)
        ) {
          definition.run(spans);
          return;
        }
        const executor = world.getResource<SharedKernelExecutor>(
          SHARED_KERNEL_EXECUTOR_RESOURCE_KEY,
        );
        const result = executor.execute(handle, dispatchSpans);
        if (isKernelDispatchFailure(result)) {
          if (!result.partialWrite) {
            definition.run(spans);
            return;
          }
          world._poisonExecution({
            code: 'shared-kernel-failed',
            kernelName: definition.name,
            cause: result.cause,
            partialWrite: result.partialWrite,
            retryable: false,
          });
          throw new SharedKernelFailureError(
            definition.name,
            world.execution.identity,
            result.cause,
            result.partialWrite,
          );
        }
      } catch (cause) {
        if (world.execution.health !== 'poisoned') {
          world._poisonExecution({
            code: 'shared-kernel-failed',
            kernelName: definition.name,
            cause,
            partialWrite: true,
            retryable: false,
          });
        }
        if (cause instanceof SharedKernelFailureError) throw cause;
        throw new SharedKernelFailureError(definition.name, world.execution.identity, cause, true);
      }
    },
  });
  return handle;
}
