/**
 * Nominal label for one of the World-owned schedules.
 *
 * Worlds expose exactly the two built-in tokens below. A token is both a
 * registration scope and, for FixedUpdate, the intrinsic Update ordering anchor.
 */
export interface ScheduleToken {
  readonly name: string;
}

function createScheduleToken(name: ScheduleToken['name']): ScheduleToken {
  return Object.freeze({ name });
}

/** Variable-rate World schedule. */
export const Update = createScheduleToken('Update');
/** Fixed-rate World schedule and the intrinsic Update ordering anchor. */
export const FixedUpdate = createScheduleToken('FixedUpdate');

export function isScheduleToken(value: unknown): value is ScheduleToken {
  return value === Update || value === FixedUpdate;
}
