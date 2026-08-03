export const READINESS_FRAME_LIMIT = 60;

export function isRecoverableWarmupError(error) {
  return (
    error.code === 'render-feature-preparation-failed' &&
    error.detail?.stage === 'prepare' &&
    error.detail?.recovery === 'next-frame'
  );
}

export function classifyDawnErrors(errors, readinessFrame) {
  const warmupErrors = [];
  const persistentErrors = [];
  for (const error of errors) {
    const isBeforeReadiness = readinessFrame === undefined || error.frame <= readinessFrame;
    if (isRecoverableWarmupError(error) && isBeforeReadiness) warmupErrors.push(error);
    else persistentErrors.push(error);
  }
  return { warmupErrors, persistentErrors };
}
