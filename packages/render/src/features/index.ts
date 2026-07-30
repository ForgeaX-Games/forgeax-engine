/**
 * Public RenderFeature index. The three modules are the machine-readable
 * declaration route: graph contribution, prepared graphics, and lifecycle
 * types. Host construction remains outside this barrel.
 */
export type {
  RenderFeatureContributionPass,
  RenderFeatureContributionResource,
  RenderFeatureContributionStaging,
  RenderFeatureGraphComposition,
  RenderFeatureGraphContribution,
  RenderFeaturePassDependency,
  RenderFeaturePassOptions,
} from './graph-contribution';
export * from './prepared-graphics';
export * from './types';
