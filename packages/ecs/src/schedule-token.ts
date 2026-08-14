/**
 * Nominal label for one of the World-owned schedules.
 *
 * Worlds expose the built-in tokens below. A token is both a registration
 * scope and, for FixedUpdate, the intrinsic Update ordering anchor.
 */
export interface ScheduleToken {
  readonly name: string;
}

export type ScheduleName = 'Update' | 'FixedUpdate' | 'FrameEnd';

function createScheduleToken(name: ScheduleName): ScheduleToken {
  return Object.freeze({ name });
}

/** Variable-rate World schedule. */
export const Update = createScheduleToken('Update');
/** Fixed-rate World schedule and the intrinsic Update ordering anchor. */
export const FixedUpdate = createScheduleToken('FixedUpdate');
/** End-of-outer-update schedule, after fixed steps and deferred commands. */
export const FrameEnd = createScheduleToken('FrameEnd');
export function isScheduleToken(value: unknown): value is ScheduleToken {
  return value === Update || value === FixedUpdate || value === FrameEnd;
}
