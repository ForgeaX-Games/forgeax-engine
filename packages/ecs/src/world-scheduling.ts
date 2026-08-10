// @forgeax/engine-ecs -- World schedule and resource orchestration.

import type { Handle } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { CommandBufferImpl } from './commands';
import {
  ProtectedResourceError,
  ScheduleScopeMismatchError,
  type SystemSetNotRegisteredError,
  TimeConfigInvalidError,
  TimeDeltaInvalidError,
} from './errors';
import {
  SHARED_KERNEL_EXECUTOR_RESOURCE_KEY,
  type SharedKernelExecutor,
} from './execution/executor';
import type { SharedKernelDispatch } from './execution/shared-kernel';
import { WorldPoisonedError } from './execution/shared-kernel-errors';
import type { QueryDescriptor } from './query/query';
import {
  getResource as resGet,
  hasResource as resHas,
  insertResource as resInsert,
  removeResource as resRemove,
} from './resource';
import {
  buildSchedule,
  type ErrorHandler,
  runSchedule,
  type Schedule,
  type SystemDescriptor,
  type SystemSet,
  addSystem as scheduleAddSystem,
  addSystems as scheduleAddSystems,
  configureSets as scheduleConfigureSets,
  removeSystem as scheduleRemoveSystem,
  replaceSystem as scheduleReplaceSystem,
} from './schedule';
import {
  FixedUpdate,
  FrameEnd,
  isScheduleToken,
  type ScheduleToken,
  Update,
} from './schedule-token';
import {
  FIXED_TIME_RESOURCE_KEY,
  FixedTime,
  type FixedTimeResource,
  TIME_RESOURCE_KEY,
  Time,
  type TimeResource,
} from './time';
import type {
  World,
  WorldInspection,
  WorldScheduleData,
  WorldScheduleQueryData,
  WorldScheduleSystemData,
} from './world';

const FIXED_ANCHOR_NAME = FixedUpdate.name;
type ResourceKey = string | { readonly name: string };

function resourceName(key: ResourceKey): string {
  return typeof key === 'string' ? key : key.name;
}

function warmSharedKernel(world: World, descriptor: unknown): void {
  if (
    (descriptor as { readonly kind?: string }).kind !== 'shared-kernel' ||
    !world.hasResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY)
  )
    return;
  world
    .getResource<SharedKernelExecutor>(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY)
    .warmup?.(descriptor as SharedKernelDispatch);
}

function scheduleFor(
  world: World,
  token: ScheduleToken,
): Result<Schedule, ScheduleScopeMismatchError> {
  const schedule = isScheduleToken(token) ? world._getSchedule(token) : undefined;
  if (schedule) return ok(schedule);
  return err(new ScheduleScopeMismatchError(token?.name ?? 'Unknown', Update.name));
}

function setOwner(world: World, set: SystemSet): ScheduleToken | undefined {
  for (const [token, schedule] of world._getSchedules()) {
    if (schedule.sets.has(set.name)) return token;
  }
  return undefined;
}

function scopeError(
  source: ScheduleToken,
  target: ScheduleToken,
  reference?: string,
): Result<never, ScheduleScopeMismatchError> {
  return err(new ScheduleScopeMismatchError(source.name, target.name, reference));
}

export function worldAddSystem<
  const Qs extends ReadonlyArray<QueryDescriptor>,
  const Ps extends ReadonlyArray<unknown>,
>(
  world: World,
  token: ScheduleToken,
  descriptor: SystemDescriptor<Qs, Ps>,
): Result<void, ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  scheduleAddSystem(target.value, descriptor);
  warmSharedKernel(world, descriptor);
  return ok(undefined);
}

export function worldRemoveSystem(
  world: World,
  token: ScheduleToken,
  name: string,
): ReturnType<typeof scheduleRemoveSystem> | Result<never, ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  return scheduleRemoveSystem(target.value, name);
}

export function worldReplaceSystem<
  const Qs extends ReadonlyArray<QueryDescriptor>,
  const Ps extends ReadonlyArray<unknown>,
>(
  world: World,
  token: ScheduleToken,
  name: string,
  descriptor: SystemDescriptor<Qs, Ps>,
): ReturnType<typeof scheduleReplaceSystem> | Result<never, ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  const replaced = scheduleReplaceSystem(target.value, name, descriptor);
  if (replaced.ok) warmSharedKernel(world, descriptor);
  return replaced;
}

export function worldAddSystems<
  const Qs extends ReadonlyArray<QueryDescriptor>,
  const Ps extends ReadonlyArray<unknown>,
>(
  world: World,
  token: ScheduleToken,
  set: SystemSet,
  systems: ReadonlyArray<SystemDescriptor<Qs, Ps>>,
): Result<void, SystemSetNotRegisteredError | ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  const owner = setOwner(world, set);
  if (owner && owner !== token) return scopeError(token, owner, set.name);
  const added = scheduleAddSystems(target.value, set, systems);
  if (added.ok) {
    for (const system of systems) warmSharedKernel(world, system);
  }
  return added;
}

export function worldConfigureSets(
  world: World,
  token: ScheduleToken,
  opts: {
    readonly set: SystemSet;
    readonly before?: readonly SystemSet[];
    readonly after?: readonly SystemSet[];
  },
): Result<void, SystemSetNotRegisteredError | ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  for (const set of [opts.set, ...(opts.before ?? []), ...(opts.after ?? [])]) {
    const owner = setOwner(world, set);
    if (owner && owner !== token) return scopeError(token, owner, set.name);
  }
  return scheduleConfigureSets(target.value, opts.set, opts.before, opts.after);
}

export function worldSetErrorHandler(world: World, handler: ErrorHandler): void {
  world._setErrHandler(handler);
}

function validateScheduleReferences(
  world: World,
  token: ScheduleToken,
  schedule: Schedule,
): ScheduleScopeMismatchError | undefined {
  for (const record of schedule.systems.values()) {
    for (const reference of [
      ...(record.descriptor.before ?? []),
      ...(record.descriptor.after ?? []),
    ]) {
      if (isScheduleToken(reference)) {
        const isFixedAnchor = token === Update && reference === FixedUpdate;
        if (reference !== token && !isFixedAnchor) {
          return new ScheduleScopeMismatchError(token.name, reference.name, reference.name);
        }
        continue;
      }
      if (typeof reference === 'string') {
        for (const [otherToken, other] of world._getSchedules()) {
          if (otherToken !== token && other.systems.has(reference)) {
            return new ScheduleScopeMismatchError(token.name, otherToken.name, reference);
          }
        }
      }
    }
  }
  return undefined;
}

function runFixed(world: World, fixed: FixedTimeResource, accumulator: { value: number }): void {
  const fixedSchedule = world._getSchedule(FixedUpdate);
  if (!fixedSchedule) return;
  if (fixedSchedule.systems.size === 0) {
    discardFixedOverflow(fixed, accumulator);
    return;
  }
  let steps = 0;
  while (accumulator.value >= fixed.delta && steps < fixed.maxStepsPerUpdate) {
    accumulator.value = Math.round((accumulator.value - fixed.delta) * 1e12) / 1e12;
    fixed.overstep = accumulator.value;
    fixed.tick += 1;
    runSchedule(fixedSchedule, world, world._getErrorHandler());
    steps += 1;
  }
  if (steps === fixed.maxStepsPerUpdate && accumulator.value >= fixed.delta) {
    const remainder = accumulator.value % fixed.delta;
    const dropped = accumulator.value - remainder;
    accumulator.value = remainder;
    fixed.droppedSeconds += dropped;
    fixed.droppedUpdates += 1;
  }
}

function discardFixedOverflow(fixed: FixedTimeResource, accumulator: { value: number }): void {
  if (accumulator.value < fixed.delta) return;
  const remainder = accumulator.value % fixed.delta;
  const dropped = accumulator.value - remainder;
  accumulator.value = remainder;
  fixed.droppedSeconds += dropped;
  fixed.droppedUpdates += 1;
}

export function worldUpdate(
  world: World,
  deltaSeconds = 0,
): Result<
  void,
  TimeDeltaInvalidError | TimeConfigInvalidError | ScheduleScopeMismatchError | WorldPoisonedError
> {
  if (world.execution.health === 'poisoned') {
    return err(new WorldPoisonedError(world.identity, world.execution.fault));
  }
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0)
    return err(new TimeDeltaInvalidError(deltaSeconds));

  const time = worldGetResource<TimeResource>(world, Time);
  const fixed = worldGetResource<FixedTimeResource>(world, FixedTime);
  if (time.maxDeltaSeconds < (fixed.maxStepsPerUpdate + 1) * fixed.delta) {
    return err(
      new TimeConfigInvalidError({
        fixedDeltaSeconds: fixed.delta,
        maxStepsPerUpdate: fixed.maxStepsPerUpdate,
        maxDeltaSeconds: time.maxDeltaSeconds,
      }),
    );
  }

  for (const [token, schedule] of world._getSchedules()) {
    const mismatch = validateScheduleReferences(world, token, schedule);
    if (mismatch) return err(mismatch);
  }

  const measured = Math.min(deltaSeconds, time.maxDeltaSeconds);
  time.delta = measured;
  time.elapsed += measured;
  // Accumulate the measured frame delta. maxDeltaSeconds bounds Time's public
  // delta, while the fixed cap makes oversized host gaps observable via metrics.
  const accumulator = { value: world._getFixedAccumulator() + measured };
  const update = world._getSchedule(Update);
  if (!update) return err(new ScheduleScopeMismatchError('World', Update.name));

  if (update.dirty) buildSchedule(update);
  const order = update.sortedOrder;
  const anchor = order.indexOf(FIXED_ANCHOR_NAME);
  const fixedSchedule = world._getSchedule(FixedUpdate);
  const hasFixedSystems = (fixedSchedule?.systems.size ?? 0) > 0;
  if (anchor < 0 || !hasFixedSystems) {
    runSchedule(
      update,
      world,
      world._getErrorHandler(),
      order.filter((name) => name !== FIXED_ANCHOR_NAME),
    );
    if (measured > 0) discardFixedOverflow(fixed, accumulator);
  } else {
    const updateCommands = new Map<string, CommandBufferImpl>();
    runSchedule(
      update,
      world,
      world._getErrorHandler(),
      order.slice(0, anchor),
      updateCommands,
      false,
    );
    if (measured > 0) runFixed(world, fixed, accumulator);
    runSchedule(update, world, world._getErrorHandler(), order.slice(anchor + 1), updateCommands);
  }
  world._setFixedAccumulator(accumulator.value);
  fixed.overstep = accumulator.value;
  const frameEnd = world._getSchedule(FrameEnd);
  if (frameEnd && frameEnd.systems.size > 0) {
    runSchedule(frameEnd, world, world._getErrorHandler());
  }
  return ok(undefined);
}

export function worldInsertResource<T>(world: World, key: ResourceKey, value: T): void {
  const name = resourceName(key);
  if (name === TIME_RESOURCE_KEY || name === FIXED_TIME_RESOURCE_KEY) {
    throw new ProtectedResourceError(name, 'insert');
  }
  resInsert(world._getResources(), name, value, world._nextMutationEpoch());
}

export function worldGetResource<T>(world: World, key: ResourceKey): T {
  return resGet<T>(world._getResources(), resourceName(key));
}

export function worldHasResource(world: World, key: ResourceKey): boolean {
  return resHas(world._getResources(), resourceName(key));
}

export function worldRemoveResource(world: World, key: ResourceKey): void {
  const name = resourceName(key);
  if (name === TIME_RESOURCE_KEY || name === FIXED_TIME_RESOURCE_KEY) {
    throw new ProtectedResourceError(name, 'remove');
  }
  if (resHas(world._getResources(), name)) {
    resRemove(world._getResources(), name);
    world._nextMutationEpoch();
  }
}

export function worldInspect(world: World): WorldInspection {
  const graph = world._getGraph();
  const resources = world._getResources();
  let entityCount = 0;
  const archetypes: WorldInspection['archetypes'] = [];
  const activeComponentSet = new Set<string>();
  for (const arch of graph.archetypes) {
    if (!arch) continue;
    entityCount += arch.size;
    const componentNames = arch.components.map((component) => component.name);
    archetypes.push({
      key: arch.key,
      componentNames,
      entityCount: arch.size,
      tableId: arch.tableId,
    });
    if (arch.size > 0) for (const name of componentNames) activeComponentSet.add(name);
  }

  const schedules = [...world._getSchedules()].map(([token, schedule]) => {
    const systems = [...schedule.systems.entries()]
      .filter(([name]) => name !== FIXED_ANCHOR_NAME)
      .map(([name]) => ({
        name,
        sets: [...schedule.sets].flatMap(([setName, record]) =>
          record.members.has(name) ? [setName] : [],
        ),
      }));
    return { schedule: token, systems };
  });
  const systems = schedules.flatMap((entry) => entry.systems);
  const tables = graph.tables.map((table) => ({
    id: table.id,
    key: table.key,
    componentNames: table.components.map((component) => component.name),
    entityCount: table.size,
    capacity: table.capacity,
  }));
  return {
    entityCount,
    archetypeCount: archetypes.length,
    archetypes,
    tableCount: tables.length,
    tables,
    activeComponents: [...activeComponentSet],
    systemCount: systems.length,
    systems,
    resourceKeys: [...resources.entries.keys()],
    schedules,
    scheduleSystemCount(token: ScheduleToken): number {
      return schedules.find((entry) => entry.schedule === token)?.systems.length ?? 0;
    },
  };
}

function referenceName(reference: string | ScheduleToken): string {
  return typeof reference === 'string' ? reference : reference.name;
}

function componentNames(components: readonly { readonly name: string }[] | undefined): string[] {
  return (components ?? []).map((component) => component.name);
}

function queryData(query: QueryDescriptor): WorldScheduleQueryData {
  return {
    with: componentNames(query.with),
    without: componentNames(query.without),
    optional: componentNames(query.optional),
    changed: componentNames(query.changed),
    added: componentNames(query.added),
  };
}

/** Project schedule registration into a JSON-safe graph for tooling and AI inspection. */
export function worldScheduleData(world: World): ReadonlyArray<WorldScheduleData> {
  return [...world._getSchedules()].map(([token, schedule]) => {
    if (schedule.dirty) buildSchedule(schedule);

    const systems: WorldScheduleSystemData[] = [...schedule.systems.entries()]
      .filter(([name]) => name !== FIXED_ANCHOR_NAME)
      .map(([name, record]) => {
        const descriptor = record.descriptor;
        const params = (descriptor.params ?? []) as ReadonlyArray<{
          readonly queries?: readonly QueryDescriptor[];
          readonly resources?: readonly string[];
        }>;
        const queries = [
          ...descriptor.queries,
          ...params.flatMap((param) => param.queries ?? []),
        ].map(queryData);
        const resources = [
          ...(descriptor.resources ?? []),
          ...params.flatMap((param) => param.resources ?? []),
        ];
        return {
          name,
          sets: [...schedule.sets].flatMap(([setName, set]) =>
            set.members.has(name) ? [setName] : [],
          ),
          before: (descriptor.before ?? []).map((reference) => referenceName(reference)),
          after: (descriptor.after ?? []).map((reference) => referenceName(reference)),
          queries,
          resources: [...new Set(resources)],
        };
      });

    const systemSets = [...schedule.sets].map(([name, set]) => ({
      name,
      members: [...set.members].filter((member) => schedule.systems.has(member)),
      before: [...set.before],
      after: [...set.after],
      chained: set.chained,
    }));
    const dependencies = [...schedule.predecessors].flatMap(([target, predecessors]) =>
      [...predecessors].map((source) => [source, target] as const),
    );

    return { name: token.name, systems, systemSets, dependencies };
  });
}

export function worldAllocUniqueRef<Target extends string, T>(
  world: World,
  target: Target,
  payload: T,
  onRelease?: (payload: T) => void,
): Handle<Target, 'unique'> {
  return world._getUniqueRefs().alloc(target, payload, onRelease);
}

export function worldAllocSharedRef<Target extends string, T>(
  world: World,
  target: Target,
  payload: T,
  onLastRelease?: (payload: T) => void,
): Handle<Target, 'shared'> {
  return world._getSharedRefs().alloc(target, payload, onLastRelease);
}
