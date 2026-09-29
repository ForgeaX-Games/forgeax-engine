/** Stage progress goes to stderr; the final SDK JSON remains machine-readable. */
export async function sdkStage(label, operation) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  console.error(`[sdk] start ${label}`);
  const heartbeat = setInterval(() => {
    console.error(`[sdk] running ${label} elapsedMs=${elapsed()}`);
  }, 30_000);
  heartbeat.unref();
  try {
    const result = await operation();
    console.error(`[sdk] complete ${label} elapsedMs=${elapsed()}`);
    return result;
  } catch (error) {
    console.error(
      `[sdk] failed ${label} elapsedMs=${elapsed()} code=${error?.code ?? error?.name ?? typeof error} signal=${error?.signal ?? 'none'}`,
    );
    for (const channel of ['stdout', 'stderr']) {
      if (error?.[channel])
        console.error(`[sdk] ${channel} tail:\n${String(error[channel]).slice(-8000)}`);
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
