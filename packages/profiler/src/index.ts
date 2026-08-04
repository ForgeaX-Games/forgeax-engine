/** Monotonic clock contract used by deterministic capture tests and hosts. */
export type { ProfileClock } from './clock.js';
/** Creates the default monotonic microsecond clock. */
export { createProfileClock } from './clock.js';
/** Structured expected-failure vocabulary for profiler operations. */
export type { ProfilerError, ProfilerErrorCode } from './errors.js';
export type {
  ProfileFrameModel,
  ProfileModel,
  ProfilePhaseModel,
  ProfileSummaryModel,
} from './model.js';
/** Projects a validated capture into offline frame and phase summaries. */
export { buildProfileModel } from './model.js';
/** Bounded CPU profiler capability; it is inert until a host passes it to App or Render. */
export type { Profiler, ProfilerCatalogSource } from './profiler.js';
/** Creates an opt-in bounded profiler with optional sink and allocation evidence. */
export { createProfiler } from './profiler.js';
export type { RecorderLimits, RecorderPhaseCatalog, RecorderSession } from './recorder.js';
export type { ProfileArtifactError } from './schema.js';
/** Validates a persisted capture before model building or CLI-style analysis. */
export { validateProfileCapture } from './schema.js';
export type {
  ProfileAllocationReport,
  ProfileCapture,
  ProfileCompleteness,
  ProfileFrameToken,
  ProfilePhaseRecord,
  ProfileRecord,
  ProfileResult,
  ProfileSink,
  ProfileSkipRecord,
  ProfileSource,
} from './types.js';
