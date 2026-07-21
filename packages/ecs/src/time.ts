export interface TimeResource {
  delta: number;
  elapsed: number;
  maxDeltaSeconds: number;
}

export interface FixedTimeResource {
  delta: number;
  maxStepsPerUpdate: number;
  tick: number;
  droppedSeconds: number;
  droppedUpdates: number;
}

interface ResourceToken<T> {
  readonly name: string;
  readonly __resourceType?: T;
}

export type ResourceValue<Key> = Key extends ResourceToken<infer Value> ? Value : never;

export interface TimePolicy {
  readonly fixedDeltaSeconds?: number;
  readonly maxStepsPerUpdate?: number;
  readonly maxDeltaSeconds?: number;
}

export interface WorldOptions {
  readonly time?: TimePolicy;
}

/** World-owned variable-rate clock resource key. */
export const Time = Object.freeze({ name: 'Time' }) as ResourceToken<TimeResource> & TimeResource;
/** World-owned fixed-rate clock, policy, and catch-up metric resource key. */
export const FixedTime = Object.freeze({ name: 'FixedTime' }) as ResourceToken<FixedTimeResource> &
  FixedTimeResource;

export const TIME_RESOURCE_KEY = Time.name;
export const FIXED_TIME_RESOURCE_KEY = FixedTime.name;

export const DEFAULT_TIME_POLICY: Required<TimePolicy> = {
  fixedDeltaSeconds: 1 / 60,
  maxStepsPerUpdate: 4,
  maxDeltaSeconds: 0.1,
};

export function createTimeResource(policy: Required<TimePolicy>): TimeResource {
  return { delta: 0, elapsed: 0, maxDeltaSeconds: policy.maxDeltaSeconds };
}

export function createFixedTimeResource(policy: Required<TimePolicy>): FixedTimeResource {
  return {
    delta: policy.fixedDeltaSeconds,
    maxStepsPerUpdate: policy.maxStepsPerUpdate,
    tick: 0,
    droppedSeconds: 0,
    droppedUpdates: 0,
  };
}
