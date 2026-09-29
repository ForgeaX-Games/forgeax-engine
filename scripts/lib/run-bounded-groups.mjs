// Worker pool shared by the split Vitest runners: groups start in the given
// order, at most `concurrency` run at once, and the first failure stops new
// launches while already running groups finish.
export async function runGroups({ groups, concurrency, runGroupImpl, order }) {
  const results = Array(groups.length);
  const schedule = order ?? groups.map((_group, index) => index);
  if (
    schedule.length !== groups.length ||
    schedule.some((index) => !Number.isInteger(index) || index < 0 || index >= groups.length) ||
    new Set(schedule).size !== groups.length
  ) {
    throw new Error('group schedule must contain every group index exactly once');
  }
  let nextIndex = 0;
  let firstError = null;

  async function worker() {
    while (firstError === null) {
      const scheduleIndex = nextIndex;
      nextIndex += 1;
      if (scheduleIndex >= schedule.length) return;
      const index = schedule[scheduleIndex];
      try {
        results[index] = await runGroupImpl(groups[index], index);
      } catch (error) {
        firstError ??= error;
      }
    }
  }

  const workerCount = Math.min(concurrency, groups.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError !== null) throw firstError;
  return results;
}
