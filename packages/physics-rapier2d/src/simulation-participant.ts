import {
  createSimulationError,
  type SimulationError,
  type SimulationParticipant,
  type SimulationParticipantStage,
  type SimulationRecordContext,
  type SimulationRestoreContext,
} from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { RapierPhysicsWorld2D } from './rapier-physics-world-2d';

export interface Rapier2DSimulationCollider {
  readonly shapeType: number;
  readonly halfExtents?: { readonly x: number; readonly y: number };
  readonly radius?: number;
  readonly halfHeight?: number;
  readonly translation: { readonly x: number; readonly y: number };
  readonly rotation: number;
  readonly density: number;
  readonly friction: number;
  readonly restitution: number;
  readonly sensor: boolean;
  readonly enabled: boolean;
  readonly collisionGroups: number;
  readonly solverGroups: number;
  readonly activeEvents: number;
  readonly activeCollisionTypes: number;
}

export interface Rapier2DSimulationBody {
  readonly entity: number;
  readonly bodyType: number;
  readonly translation: { readonly x: number; readonly y: number };
  readonly rotation: number;
  readonly nextTranslation: { readonly x: number; readonly y: number };
  readonly nextRotation: number;
  readonly linearVelocity: { readonly x: number; readonly y: number };
  readonly angularVelocity: number;
  readonly gravityScale: number;
  readonly linearDamping: number;
  readonly angularDamping: number;
  readonly ccdEnabled: boolean;
  readonly sleeping: boolean;
  readonly enabled: boolean;
  readonly userForce: { readonly x: number; readonly y: number };
  readonly userTorque: number;
  readonly colliders: readonly Rapier2DSimulationCollider[];
}

export interface Rapier2DSimulationJoint {
  readonly type: number;
  readonly body1Entity: number;
  readonly body2Entity: number;
  readonly anchor1: { readonly x: number; readonly y: number };
  readonly anchor2: { readonly x: number; readonly y: number };
  readonly contactsEnabled: boolean;
}

export interface Rapier2DKinematicControllerState {
  readonly entity: number;
  readonly offset: number;
}

export interface Rapier2DSimulationState {
  readonly version: 1;
  readonly gravity: { readonly x: number; readonly y: number };
  readonly bodies: readonly Rapier2DSimulationBody[];
  readonly joints: readonly Rapier2DSimulationJoint[];
  readonly kinematicControllers: readonly Rapier2DKinematicControllerState[];
  readonly pendingTeleports: readonly [
    number,
    { readonly x: number; readonly y: number; readonly rotation: number },
  ][];
  readonly collisionPairs: readonly [number, readonly number[]][];
  readonly collisionEvents: readonly unknown[];
  readonly pendingCollisionEvents: readonly unknown[];
}

export interface Rapier2DSimulationParticipantOptions {
  readonly isReady?: () => boolean;
  readonly version?: string;
  readonly schemaFingerprint?: string;
}

interface Rapier2DStageState {
  readonly candidate: RapierPhysicsWorld2D;
}

function unsupported(path: string): Result<never, SimulationError> {
  return err(createSimulationError('simulation-state-unsupported', { path }));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isState(value: unknown): value is Rapier2DSimulationState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<Rapier2DSimulationState>;
  return (
    state.version === 1 &&
    Array.isArray(state.bodies) &&
    Array.isArray(state.joints) &&
    Array.isArray(state.kinematicControllers) &&
    Array.isArray(state.pendingCollisionEvents)
  );
}

function isLocalEntity(value: unknown, context: SimulationRestoreContext | undefined): boolean {
  return (
    context === undefined ||
    (typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value < context.entityCount)
  );
}

function validateEntityReferences(
  state: Rapier2DSimulationState,
  context: SimulationRestoreContext | undefined,
): boolean {
  if (context === undefined) return true;
  const valid = (entity: unknown) => isLocalEntity(entity, context);
  return (
    state.bodies.every((body) => valid(body.entity)) &&
    state.joints.every((joint) => valid(joint.body1Entity) && valid(joint.body2Entity)) &&
    state.kinematicControllers.every((controller) => valid(controller.entity)) &&
    state.pendingTeleports.every(([entity]) => valid(entity)) &&
    state.collisionPairs.every(
      ([entity, others]) => valid(entity) && others.every((other) => valid(other)),
    ) &&
    [...state.collisionEvents, ...state.pendingCollisionEvents].every((event) => {
      if (typeof event !== 'object' || event === null) return false;
      const value = event as { entityA?: unknown; entityB?: unknown };
      return valid(value.entityA) && valid(value.entityB);
    })
  );
}

/** Adapt portable 2D physics state; Rapier objects remain private to the participant. */
export function createRapier2DSimulationParticipant(
  physics: RapierPhysicsWorld2D,
  options: Rapier2DSimulationParticipantOptions = {},
): SimulationParticipant {
  const id = 'forgeax.physics.rapier-2d';
  const version = options.version ?? '1';
  const schemaFingerprint = options.schemaFingerprint ?? 'rapier-2d-simulation-v1';
  const isReady = options.isReady ?? (() => true);
  return {
    id,
    version,
    schemaFingerprint,
    isReady,
    recordState: (context?: SimulationRecordContext) => {
      if (!isReady()) {
        return err(createSimulationError('simulation-participant-not-ready', { id }));
      }
      try {
        return ok(physics.captureSimulationState(context?.mapEntity));
      } catch {
        return unsupported('state');
      }
    },
    prepareRestore: (state, context?: SimulationRestoreContext) => {
      if (!isReady()) {
        return err(createSimulationError('simulation-participant-not-ready', { id }));
      }
      if (!isState(state)) return unsupported('state');
      if (!validateEntityReferences(state, context)) return unsupported('entity');
      if (state.bodies.some((body) => !isFiniteNumber(body.entity))) {
        return unsupported('bodies.entity');
      }
      if (
        state.kinematicControllers.some(
          (controller) => !isFiniteNumber(controller.entity) || !isFiniteNumber(controller.offset),
        )
      ) {
        return unsupported('kinematicControllers');
      }
      let candidate: RapierPhysicsWorld2D | undefined;
      try {
        candidate = physics.createRestoreCandidate();
        candidate.loadSimulationState(state);
        return ok({ state: { candidate } } satisfies SimulationParticipantStage);
      } catch {
        candidate?.dispose();
        return unsupported('bodies');
      }
    },
    commitRestore: (stage, context?: SimulationRestoreContext) => {
      physics.commitRestoreCandidate(
        (stage.state as Rapier2DStageState).candidate,
        context?.entityMap,
      );
    },
    disposeRestore: (stage) => {
      (stage.state as Rapier2DStageState).candidate.dispose();
    },
  };
}
