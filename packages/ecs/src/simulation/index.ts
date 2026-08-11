// @forgeax/engine-ecs — simulation subsystem boundary.
//
// World depends on this one seam instead of importing each simulation
// implementation file. Public package exports may still choose focused
// submodules; this boundary keeps the World facade's dependency fan-in small.

export { SimulationParticipantRegistry } from './coordinator';
export {
  captureSimulationRecord,
  restoreSimulationRecord,
  simulationWorldFingerprint,
} from './restore';
export type {
  SimulationError,
  SimulationParticipant,
  SimulationRecordContext,
  SimulationRecordV1,
  SimulationRestoreContext,
} from './types';
