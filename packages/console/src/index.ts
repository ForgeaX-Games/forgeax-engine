// @forgeax/engine-console - inspector P0 server + CLI dual-exit package.
//
// Single entry facade (charter proposition 1 progressive disclosure). The
// runtime server lives under the ./server sub-path; the standalone CLI binary
// ships via `bin.forgeax` -> dist/cli.mjs. AI users import the shared error
// model from this top entry:
//
//   import { InspectorError, type InspectorErrorCode } from '@forgeax/engine-console';
//
// The error model SSOT (6-member closed InspectorErrorCode union) lives in
// src/errors.ts and is also exposed via the ./errors sub-path for callers that
// want type-only imports without pulling the runtime surface (D-P4 bundle
// isolation + AGENTS.md "Inspector / Console" evolution contract minor
// add-only).
//
// T-01 baseline: re-exports the error model only. Server / sandbox / CLI
// modules land in later milestones (T-06 / T-08 / T-12).

export * from './errors';
export { Registry } from './registry';
export { MUTATION_BLACKLIST, wrapReadOnly } from './sandbox';
export type {
  WireDefaultInspectorsContext,
  WireDefaultInspectorsResult,
} from './wire-default-inspectors';
export { wireDefaultInspectors } from './wire-default-inspectors';
