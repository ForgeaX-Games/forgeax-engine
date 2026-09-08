export {
  assetAddCommand,
  assetInspectCommand,
  assetListCommand,
  assetVerifyCommand,
  browserCaptureCommand,
  buildCommand,
  createCliRhiDebugOperationContext,
  devCommand,
  doctorCommand,
  engineDoctorCommand,
  engineStatusCommand,
  engineUnlinkCommand,
  engineUseLocalCommand,
  initCommand,
  newCommand,
  packageCommand,
  pluginInstallCommand,
  pluginUninstallCommand,
  previewCommand,
  runRhiDebugCommand,
  sdkInstallCommand,
  shaderCheckCommand,
  skillInstallCommand,
  skillVerifyCommand,
  softwareCaptureCommand,
  testCommand,
} from './commands.js';
export { verifyDist, writeDistManifest } from './dist.js';
export type {
  EngineBinding,
  EngineBindingCommandOptions,
  EngineBindingMode,
  EnginePackageStatus,
  EngineStatusReport,
  EngineWorkspaceStatus,
} from './engine-binding.js';
export {
  ENGINE_BINDING_SCHEMA_VERSION,
  engineBindingFilePath,
  inspectEngineWorkspace,
  readEngineBinding,
} from './engine-binding.js';
export type { BootstrapRoot } from './host/base-host.js';
export type { ProjectBootstrapPlan } from './host/project-bootstrap.js';
export type {
  ResourceBootstrapPlan,
  ResourceBootstrapTrace,
} from './host/resource-bootstrap.js';
export { createInitPlan } from './init.js';
export { readProjectFacts } from './project.js';
export type {
  ArtifactRef,
  CapturedRhiTape,
  RhiCaptureFrameValue,
  RhiDebugOperationContext,
  RhiDebugOperationDescriptor,
  RhiDebugOperationInput,
  RhiDebugOperationName,
  RhiDebugOperationOutput,
  RhiInspectInput,
  RhiInspectOutput,
  RhiSummaryInput,
  RhiSummaryOutput,
} from './rhi-debug/operations.js';
export {
  createRhiDebugOperationContext,
  discoverRhiDebugOperations,
  RHI_DEBUG_OPERATION_MANIFEST,
  recoverRhiDebugError,
  renderRhiDebugHelp,
  runRhiDebugOperation,
} from './rhi-debug/operations.js';
export type {
  BrowserCapture,
  BrowserCaptureCheckpointOptions,
  BrowserCaptureOpenOptions,
  BrowserCaptureRecord,
  BrowserCaptureRunReport,
  BrowserCaptureRuntimeWitness,
  CapturePixelWitness,
  SoftwareBrowser,
  SoftwareBrowserOpenOptions,
  SoftwareBrowserSession,
  SoftwareCaptureCheckpointOptions,
  SoftwareCaptureRecord,
  SoftwareCaptureRunReport,
  SoftwareCaptureRuntimeWitness,
} from './software-capture.js';
export { createBrowserCapture, createSoftwareBrowser } from './software-capture.js';
export {
  type AdmissionThresholds,
  type BenchmarkAdmissionReport,
  type BenchmarkMeasurement,
  type BenchmarkRecipe,
  type BenchmarkSample,
  createAdmissionReport,
  DEFAULT_ADMISSION_THRESHOLDS,
  runBenchmarkAdmission,
  summarizeBenchmarkSamples,
} from './tools/benchmark/index.js';
export {
  bootstrapRealm,
  type RealmBootstrapInput,
  type RealmBootstrapResult,
  type RealmLifecycleAdapter,
  type RealmLifecycleHandle,
} from './tools/bootstrap.js';
export { createServiceCache, type ServiceCache, type ServiceCacheEntry } from './tools/cache.js';
export {
  createServiceCapability,
  type ServiceAdmissionExpectation,
  type ServiceAdmissionRef,
  type ServiceCapability,
} from './tools/capability.js';
export {
  type CarrierProvider,
  type CarrierProviderService,
  type CarrierProviderServiceOptions,
  createCarrierProvider,
  createCarrierProviderService,
} from './tools/carrier-provider.js';
export {
  type CarrierRendezvous,
  type CarrierRendezvousOptions,
  createCarrierRendezvous,
} from './tools/carrier-rendezvous.js';
export {
  describeTool,
  listTools,
  materializeToolCatalog,
  rebuildToolCatalog,
} from './tools/catalog.js';
export { runGenericTool, runNamedTool } from './tools/cli-adapter.js';
export {
  createToolClient,
  type ToolClient,
  type ToolClientOptions,
} from './tools/client.js';
export type { ForgeaXExecContext } from './tools/commands.js';
export {
  createAuthorContribution,
  createBuildContribution,
  createDefaultContributions,
} from './tools/contributions.js';
export { runLibraryTool } from './tools/library.js';
export {
  createCapabilityToken,
  createMigrationRecipe,
  createMigrationRoster,
  type MigrationCapabilityProbe,
  type MigrationOperation,
  type MigrationPath,
  type MigrationRecipe,
  type MigrationResolution,
  type MigrationResolutionResult,
  type MigrationRosterEntry,
  type MigrationTarget,
  probeMigrationTarget,
  resolveMigration,
} from './tools/migration.js';
export {
  analyzePreviewArtifacts,
  type OfflineAnalysisRequest,
  type OfflineAnalysisResult,
} from './tools/offline-analysis.js';
export {
  createDomainPreviewContributions,
  createOfflineAnalysisContribution,
  createPreviewContribution,
  createPreviewContributions,
} from './tools/preview-contributions.js';
export {
  type PreviewCarrierRoute,
  type PreviewHostRequest,
  type PreviewHostResult,
  type PreviewHostRunner,
  runCarrierPreviewRoute,
  runPreviewHost,
} from './tools/preview-host.js';
export { runPrivateTool } from './tools/private-executor.js';
export {
  createRealmCapabilityMatrix,
  createResourceProbe,
  type RealmCapability,
  type RealmCapabilityInput,
  type RealmCapabilityMatrix,
  type ResourceOwner,
  resolveRealmCapability,
} from './tools/realms.js';
export { createDevkitToolRuntime, createPreviewToolRuntime } from './tools/runtime.js';
export {
  createServiceExecutor,
  type ServiceExecutor,
  type ServiceExecutorOptions,
} from './tools/service.js';
export {
  type AuthenticatedLoopbackService,
  type AuthenticatedLoopbackServiceOptions,
  type AuthenticatedLoopbackTransport,
  type AuthenticatedLoopbackTransportOptions,
  createAuthenticatedLoopbackService,
  createAuthenticatedLoopbackTransport,
  type ServiceWireHandler,
  type ServiceWireRequest,
} from './tools/service-transport.js';
export type {
  AssetAddOptions,
  AssetInspectOptions,
  BrowserCaptureOptions,
  BuildOptions,
  CaptureBackend,
  CommandEnvelope,
  CommandError,
  CommandResult,
  ForgeaXCommand,
  InitOptions,
  NewOptions,
  PluginInstallOptions,
  PluginUninstallOptions,
  ProjectCommandOptions,
  ProjectFacts,
  ShaderCheckOptions,
  SoftwareCaptureOptions,
} from './types.js';
export { resolveProjectPort } from './types.js';
