import { err, ok, type Result } from '@forgeax/engine-types';

/** A portable integer grid coordinate. */
export type VoxelCell = readonly [number, number, number];

/** A portable quaternion used by derived-physics inputs. */
export type PhysicsQuaternion = readonly [number, number, number, number];

/** A portable three-component vector used by derived-physics inputs. */
export type PhysicsVector = readonly [number, number, number];

/**
 * One local voxel shape. `cells` contains contiguous x/y/z triples. The
 * backend copies it while preparing a candidate, so callers may reuse their
 * scratch buffer after the call returns.
 */
export interface VoxelShapeInput {
  readonly kind?: 'voxel';
  readonly id: string;
  readonly revision: number;
  readonly cells: Int32Array | readonly VoxelCell[];
  readonly voxelSize: PhysicsVector;
  readonly origin?: PhysicsVector;
  readonly rotation?: PhysicsQuaternion;
  readonly friction?: number;
  readonly restitution?: number;
  readonly density?: number;
  readonly isSensor?: boolean;
  readonly collisionGroups?: number;
  readonly solverGroups?: number;
}

/** Finite column-major matrix, in the same bounded candidate transaction as voxels. */
export interface HeightfieldShapeInput
  extends Omit<VoxelShapeInput, 'kind' | 'cells' | 'voxelSize'> {
  readonly kind: 'heightfield';
  readonly rows: number;
  readonly columns: number;
  readonly heights: Float32Array;
  readonly scale: PhysicsVector;
}
export type DerivedShapeInput = VoxelShapeInput | HeightfieldShapeInput;
export type NormalizedDerivedShapeInput = DerivedShapeInput & {
  readonly origin: PhysicsVector;
  readonly rotation: PhysicsQuaternion;
};

/** Stable producer identity and revision for one constraint endpoint. */
export interface PhysicsConstraintBodyDependency {
  readonly sourceKey: string;
  readonly revision: number;
}

/** Explicit or density-derived rigid-body mass properties. */
export type PhysicsMassProperties =
  | {
      readonly mode: 'automatic';
      readonly density?: number;
    }
  | {
      readonly mode: 'explicit';
      readonly mass: number;
      readonly centerOfMass: PhysicsVector;
      readonly principalInertia: PhysicsVector;
      readonly principalInertiaLocalFrame?: PhysicsQuaternion;
    };

/** How a topology replacement carries the committed body's motion. */
export type PhysicsVelocityPolicy = 'preserve' | 'reset';

/**
 * Consumer-visible movement state for one committed derived body.
 *
 * `centerOfMass` is world-space (the same frame as the body's transform),
 * while both velocity vectors are world-space.  Keeping this as one POD
 * value makes snapshot/recovery carry the complete motion boundary instead
 * of exposing Rapier objects or asking consumers to infer velocity from
 * successive transforms.
 */
export interface DerivedPhysicsMotion {
  readonly centerOfMass: PhysicsVector;
  readonly linearVelocity: PhysicsVector;
  readonly angularVelocity: PhysicsVector;
  /** World-space xyzw orientation; omitted input preserves the native orientation. */
  readonly rotation?: PhysicsQuaternion;
}

/** Stable, consumer-owned constraint input. */
export type PhysicsConstraintInput =
  | {
      readonly id: string;
      readonly revision: number;
      readonly kind: 'spring';
      readonly bodyA: number;
      readonly bodyB: number;
      readonly bodyASource: PhysicsConstraintBodyDependency;
      readonly bodyBSource: PhysicsConstraintBodyDependency;
      readonly anchorA: PhysicsVector;
      readonly anchorB: PhysicsVector;
      readonly restLength: number;
      readonly stiffness: number;
      readonly damping: number;
    }
  | {
      readonly id: string;
      readonly revision: number;
      readonly kind: 'hinge';
      readonly bodyA: number;
      readonly bodyB: number;
      readonly bodyASource: PhysicsConstraintBodyDependency;
      readonly bodyBSource: PhysicsConstraintBodyDependency;
      readonly anchorA: PhysicsVector;
      readonly anchorB: PhysicsVector;
      readonly axis: PhysicsVector;
      readonly limits?: readonly [number, number];
    };

/** All data needed to prepare one body's derived shape replacement. */
export interface DerivedPhysicsCandidateInput {
  readonly entity: number;
  readonly revision: number;
  readonly sourceKey: string;
  /** Empty clears derived shapes; ordinary colliders and ECS body lifetime remain independent. */
  readonly shapes: readonly DerivedShapeInput[];
  readonly seams?: readonly DerivedShapeSeamInput[];
  readonly bodyType?: 'static' | 'dynamic' | 'kinematic';
  readonly massProperties?: PhysicsMassProperties;
  readonly velocityPolicy?: PhysicsVelocityPolicy;
  /** Optional committed motion to restore after native mass admission. */
  readonly motion?: DerivedPhysicsMotion;
  readonly constraints?: readonly PhysicsConstraintInput[];
  /** Optional World identity; it is checked when the backend is ECS-bound. */
  readonly worldIdentity?: object;
}

/** A same-body integer-grid seam maintained by the Rapier voxel backend. */
export interface DerivedShapeSeamInput {
  readonly shapeA: string;
  readonly shapeB: string;
  /** Grid-space origin of B relative to A; all components must be integers. */
  readonly offset: PhysicsVector;
}

/** Candidate lifecycle visible to a consumer. */
export type DerivedPhysicsCandidateState =
  | 'ready'
  | 'queued'
  | 'published'
  | 'cancelled'
  | 'invalidated'
  | 'failed';

/** Opaque-enough prepared candidate. Native handles never cross this type. */
export interface DerivedPhysicsCandidate {
  readonly candidateId: string;
  readonly generation: number;
  /** Per-PhysicsWorld owner identity; candidate IDs are not global. */
  readonly owner: object;
  readonly input: Readonly<DerivedPhysicsCandidateInput>;
  readonly state: DerivedPhysicsCandidateState;
}

/** Stable receipt emitted when a candidate becomes the committed shape set. */
export interface DerivedPhysicsPublication {
  readonly candidateId: string;
  readonly entity: number;
  readonly revision: number;
  readonly fixedStep: number;
  readonly shapeIds: readonly string[];
  readonly generation: number;
}

/** Structured admission failure that leaves the prior publication queryable. */
export interface DerivedPhysicsFailure {
  readonly candidateId: string;
  readonly entity: number;
  readonly revision: number;
  readonly fixedStep: number;
  readonly error: DerivedPhysicsError;
  readonly recovery: 'old-state-retained' | 'rebuild-required';
}

/** Public projection of an active local shape. */
export type DerivedShapeState = {
  readonly id: string;
  readonly revision: number;
  readonly entity: number;
  readonly origin: PhysicsVector;
  readonly rotation: PhysicsQuaternion;
  readonly generation: number;
} & (
  | { readonly voxelSize: PhysicsVector }
  | {
      readonly heightfield: {
        readonly rows: number;
        readonly columns: number;
        readonly scale: PhysicsVector;
      };
    }
);

/** Real backend contact observation, including stable shape identity when known. */
export interface PhysicsContactObservation {
  readonly phase: 'started' | 'stopped';
  readonly fixedStep: number;
  readonly entityA: number;
  readonly entityB: number;
  readonly shapeA?: string;
  readonly shapeB?: string;
  /** World-space contact sample from either surface, when available. */
  readonly point?: PhysicsVector;
  /** World-space normal oriented from entityA toward entityB, when available. */
  readonly normal?: PhysicsVector;
}

/** Portable recovery input produced from a committed derived state. */
export interface DerivedPhysicsSnapshot {
  readonly generation: number;
  readonly fixedStep: number;
  readonly bodies: readonly {
    readonly entity: number;
    readonly revision: number;
    readonly sourceKey: string;
    readonly shapes: readonly DerivedShapeInput[];
    readonly seams?: readonly DerivedShapeSeamInput[];
    readonly bodyType?: 'static' | 'dynamic' | 'kinematic';
    readonly massProperties?: PhysicsMassProperties;
    readonly velocityPolicy?: PhysicsVelocityPolicy;
    /** Committed world-space COM and velocities at capture time. */
    readonly motion?: DerivedPhysicsMotion;
    readonly constraints: readonly PhysicsConstraintInput[];
  }[];
}

export type DerivedPhysicsErrorCode =
  | 'derived-physics-disposed'
  | 'derived-body-not-found'
  | 'derived-world-mismatch'
  | 'derived-candidate-not-found'
  | 'derived-candidate-stale'
  | 'derived-candidate-pending'
  | 'derived-candidate-cancelled'
  | 'derived-candidate-invalid'
  | 'derived-candidate-budget-exceeded'
  | 'derived-shape-invalid'
  | 'derived-shape-duplicate'
  | 'derived-seam-invalid'
  | 'derived-mass-invalid'
  | 'derived-constraint-invalid'
  | 'derived-constraint-not-found'
  | 'derived-constraint-stale'
  | 'derived-backend-failed'
  | 'derived-recovery-invalid';

/** Bounded derived-physics preparation envelope. */
export const DERIVED_PHYSICS_LIMITS = Object.freeze({
  maxCandidates: 32,
  maxShapesPerCandidate: 64,
  maxConstraintsPerCandidate: 64,
  maxCellsPerCandidate: 262_144,
  maxCandidateBytes: 8 * 1024 * 1024,
});

export interface DerivedPhysicsErrorDetail {
  readonly code: DerivedPhysicsErrorCode;
  readonly entity?: number;
  readonly candidateId?: string;
  readonly shapeId?: string;
  readonly constraintId?: string;
  readonly expected?: string;
  readonly actual?: unknown;
  readonly reason?: string;
}

/** Closed, structured failure for the public derived-physics surface. */
export class DerivedPhysicsError extends Error {
  readonly code: DerivedPhysicsErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: DerivedPhysicsErrorDetail;

  constructor(
    code: DerivedPhysicsErrorCode,
    expected: string,
    hint: string,
    detail: Omit<DerivedPhysicsErrorDetail, 'code'> = {},
  ) {
    super(`${code}: ${expected}`);
    this.name = 'DerivedPhysicsError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = Object.freeze({ code, ...detail });
  }
}

const ID_RE = /\S/;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function vectorFinite(vector: readonly number[], length: number): boolean {
  return vector.length === length && vector.every(finite);
}

/** Rotate a local origin delta into the shared grid frame used by a seam. */
function rotateVectorByQuaternion(
  vector: readonly [number, number, number],
  rotation: readonly [number, number, number, number],
): [number, number, number] {
  const [x, y, z] = vector;
  const [qx, qy, qz, qw] = rotation;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

function normalizedQuaternion(rotation: PhysicsQuaternion): PhysicsQuaternion | undefined {
  if (!vectorFinite(rotation, 4)) return undefined;
  const length = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (!finite(length) || length < 1e-6) return undefined;
  return [rotation[0] / length, rotation[1] / length, rotation[2] / length, rotation[3] / length];
}

function copyCells(cells: Int32Array | readonly VoxelCell[]): Int32Array | undefined {
  if (cells instanceof Int32Array) return new Int32Array(cells);
  const result = new Int32Array(cells.length * 3);
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell === undefined || cell.length !== 3 || cell.some((value) => !Number.isInteger(value))) {
      return undefined;
    }
    result[index * 3] = cell[0] ?? 0;
    result[index * 3 + 1] = cell[1] ?? 0;
    result[index * 3 + 2] = cell[2] ?? 0;
  }
  return result;
}

/** Validate and snapshot one voxel input before native resources are created. */
export function normalizeVoxelShapeInput(input: VoxelShapeInput): Result<
  VoxelShapeInput & {
    readonly cells: Int32Array;
    readonly origin: PhysicsVector;
    readonly rotation: PhysicsQuaternion;
  },
  DerivedPhysicsError
> {
  if (typeof input.id !== 'string' || !ID_RE.test(input.id)) {
    return err(
      new DerivedPhysicsError(
        'derived-shape-invalid',
        'voxel shape id is a non-empty stable string',
        'provide a stable shape identity from the consumer state',
        { shapeId: input.id },
      ),
    );
  }
  if (!Number.isInteger(input.revision) || input.revision < 0) {
    return err(
      new DerivedPhysicsError(
        'derived-shape-invalid',
        'voxel shape revision is a non-negative integer',
        'increment the shape revision when its cells or transform changes',
        { shapeId: input.id, actual: input.revision },
      ),
    );
  }
  const cells = copyCells(input.cells);
  if (cells === undefined || cells.length === 0 || cells.length % 3 !== 0) {
    return err(
      new DerivedPhysicsError(
        'derived-shape-invalid',
        'voxel cells contain at least one complete integer x/y/z triple',
        'supply a non-empty Int32Array or cell tuple list',
        { shapeId: input.id, actual: cells?.length },
      ),
    );
  }
  const voxelSize = input.voxelSize;
  if (!vectorFinite(voxelSize, 3) || voxelSize.some((value) => value <= 0)) {
    return err(
      new DerivedPhysicsError(
        'derived-shape-invalid',
        'voxelSize contains finite positive components',
        'choose a finite positive voxel size for every axis',
        { shapeId: input.id, actual: voxelSize },
      ),
    );
  }
  for (const value of cells) {
    if (!Number.isInteger(value)) {
      return err(
        new DerivedPhysicsError(
          'derived-shape-invalid',
          'voxel coordinates are integers',
          'quantize cells before submitting a physics candidate',
          { shapeId: input.id, actual: value },
        ),
      );
    }
  }
  const origin = input.origin ?? [0, 0, 0];
  if (!vectorFinite(origin, 3)) {
    return err(
      new DerivedPhysicsError(
        'derived-shape-invalid',
        'voxel origin contains finite coordinates',
        'supply a finite local origin',
        { shapeId: input.id, actual: origin },
      ),
    );
  }
  const rotation = normalizedQuaternion(input.rotation ?? [0, 0, 0, 1]);
  if (rotation === undefined) {
    return err(
      new DerivedPhysicsError(
        'derived-shape-invalid',
        'voxel rotation is a finite non-degenerate quaternion',
        'normalize the local voxel orientation before submitting it',
        { shapeId: input.id, actual: input.rotation },
      ),
    );
  }
  for (const [name, value] of [
    ['friction', input.friction],
    ['restitution', input.restitution],
    ['density', input.density],
  ] as const) {
    if (value !== undefined && (!finite(value) || value < 0)) {
      return err(
        new DerivedPhysicsError(
          'derived-shape-invalid',
          `${name} is finite and non-negative`,
          `repair the ${name} input before native preparation`,
          { shapeId: input.id, actual: value },
        ),
      );
    }
  }
  return ok(
    Object.freeze({
      ...input,
      cells,
      voxelSize: [voxelSize[0], voxelSize[1], voxelSize[2]] as PhysicsVector,
      origin: [origin[0], origin[1], origin[2]] as PhysicsVector,
      rotation,
    }),
  );
}

/** Reject holes and malformed matrices before allocating any native collider. */
export function normalizeHeightfieldShapeInput(
  input: HeightfieldShapeInput,
): Result<NormalizedDerivedShapeInput, DerivedPhysicsError> {
  const invalid = (actual: unknown) =>
    err(
      new DerivedPhysicsError(
        'derived-shape-invalid',
        'finite hole-free column-major heightfield with positive dimensions and scale',
        'repair dimensions, samples and pose before candidate preparation',
        { shapeId: input.id, actual },
      ),
    );
  if (
    typeof input.id !== 'string' ||
    !ID_RE.test(input.id) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !Number.isSafeInteger(input.rows) ||
    !Number.isSafeInteger(input.columns) ||
    input.rows < 1 ||
    input.columns < 1 ||
    (input.rows + 1) * (input.columns + 1) > DERIVED_PHYSICS_LIMITS.maxCellsPerCandidate ||
    !(input.heights instanceof Float32Array) ||
    input.heights.length !== (input.rows + 1) * (input.columns + 1) ||
    input.heights.some((h) => !Number.isFinite(h)) ||
    !vectorFinite(input.scale, 3) ||
    input.scale.some((v) => v <= 0)
  )
    return invalid(input.id);
  const origin = input.origin ?? [0, 0, 0];
  const rotation = normalizedQuaternion(input.rotation ?? [0, 0, 0, 1]);
  if (!vectorFinite(origin, 3) || !rotation) return invalid(origin);
  for (const value of [input.friction, input.restitution, input.density])
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) return invalid(value);
  return ok(
    Object.freeze({
      ...input,
      heights: new Float32Array(input.heights),
      scale: [...input.scale] as PhysicsVector,
      origin: [...origin] as PhysicsVector,
      rotation,
    }),
  );
}

/** Validate explicit mass/inertia values before touching the backend. */
export function validateMassProperties(
  properties: PhysicsMassProperties | undefined,
): Result<PhysicsMassProperties | undefined, DerivedPhysicsError> {
  if (properties === undefined || properties.mode === 'automatic') {
    if (
      properties?.density !== undefined &&
      (!finite(properties.density) || properties.density <= 0)
    ) {
      return err(
        new DerivedPhysicsError(
          'derived-mass-invalid',
          'automatic density is finite and positive',
          'omit density to use backend density or provide a positive density',
          { actual: properties.density },
        ),
      );
    }
    return ok(properties);
  }
  if (
    !finite(properties.mass) ||
    properties.mass <= 0 ||
    !vectorFinite(properties.centerOfMass, 3) ||
    !vectorFinite(properties.principalInertia, 3) ||
    properties.principalInertia.some((value) => !finite(value) || value <= 0)
  ) {
    return err(
      new DerivedPhysicsError(
        'derived-mass-invalid',
        'explicit mass, center of mass, and principal inertia are finite and non-degenerate',
        'provide positive mass/inertia and a finite center of mass',
        { actual: properties },
      ),
    );
  }
  const frame = normalizedQuaternion(properties.principalInertiaLocalFrame ?? [0, 0, 0, 1]);
  if (frame === undefined) {
    return err(
      new DerivedPhysicsError(
        'derived-mass-invalid',
        'principal inertia local frame is a finite non-degenerate quaternion',
        'normalize the inertia frame before submitting it',
        { actual: properties.principalInertiaLocalFrame },
      ),
    );
  }
  return ok(
    Object.freeze({
      ...properties,
      centerOfMass: [...properties.centerOfMass] as PhysicsVector,
      principalInertia: [...properties.principalInertia] as PhysicsVector,
      principalInertiaLocalFrame: frame,
    }),
  );
}

/** The required linear velocity correction for a committed COM change. */
export function preserveCenterOfMassVelocity(
  linearVelocity: PhysicsVector,
  angularVelocity: PhysicsVector,
  previousWorldCom: PhysicsVector,
  nextWorldCom: PhysicsVector,
): PhysicsVector {
  const dx = nextWorldCom[0] - previousWorldCom[0];
  const dy = nextWorldCom[1] - previousWorldCom[1];
  const dz = nextWorldCom[2] - previousWorldCom[2];
  return [
    linearVelocity[0] + angularVelocity[1] * dz - angularVelocity[2] * dy,
    linearVelocity[1] + angularVelocity[2] * dx - angularVelocity[0] * dz,
    linearVelocity[2] + angularVelocity[0] * dy - angularVelocity[1] * dx,
  ];
}

/** Snapshot an input without retaining caller-owned typed-array references. */
export function cloneDerivedPhysicsInput(
  input: DerivedPhysicsCandidateInput,
): Result<DerivedPhysicsCandidateInput, DerivedPhysicsError> {
  if (!Number.isInteger(input.entity) || input.entity < 0) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'candidate entity is a non-negative ECS entity value',
        'submit a live entity from the same World',
        { entity: input.entity },
      ),
    );
  }
  if (!Number.isInteger(input.revision) || input.revision < 0) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'candidate revision is a non-negative integer',
        'advance the consumer topology revision monotonically',
        { entity: input.entity, actual: input.revision },
      ),
    );
  }
  if (typeof input.sourceKey !== 'string' || !ID_RE.test(input.sourceKey)) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'candidate sourceKey is a non-empty stable producer identity',
        'carry the producer sourceKey with every derived body revision',
        { entity: input.entity, actual: input.sourceKey },
      ),
    );
  }
  if (input.shapes.length > DERIVED_PHYSICS_LIMITS.maxShapesPerCandidate) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-budget-exceeded',
        `one candidate contains at most ${DERIVED_PHYSICS_LIMITS.maxShapesPerCandidate} derived shapes`,
        'split the consumer operation at a body boundary and retry',
        { entity: input.entity, actual: input.shapes.length },
      ),
    );
  }
  const seen = new Set<string>();
  const shapes: DerivedShapeInput[] = [];
  for (const shape of input.shapes) {
    if (seen.has(shape.id)) {
      return err(
        new DerivedPhysicsError(
          'derived-shape-duplicate',
          'one candidate has one identity per derived shape',
          'merge or rename duplicate shape inputs before preparation',
          { entity: input.entity, shapeId: shape.id },
        ),
      );
    }
    seen.add(shape.id);
    const normalized =
      shape.kind === 'heightfield'
        ? normalizeHeightfieldShapeInput(shape)
        : normalizeVoxelShapeInput(shape);
    if (!normalized.ok) return normalized;
    shapes.push(normalized.value);
  }
  const motionRotation =
    input.motion?.rotation === undefined ? undefined : normalizedQuaternion(input.motion.rotation);
  if (input.motion?.rotation !== undefined && motionRotation === undefined)
    return err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'optional motion rotation is a finite non-degenerate world-space quaternion',
        'supply a valid xyzw body orientation or omit it to preserve the native orientation',
        { entity: input.entity, actual: input.motion.rotation },
      ),
    );
  const mass = validateMassProperties(input.massProperties);
  if (!mass.ok) return mass;
  if (
    input.motion !== undefined &&
    (!vectorFinite(input.motion.centerOfMass, 3) ||
      !vectorFinite(input.motion.linearVelocity, 3) ||
      !vectorFinite(input.motion.angularVelocity, 3))
  ) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'optional movement state contains finite world-space COM and velocity vectors',
        'capture or provide three finite components for centerOfMass, linearVelocity, and angularVelocity',
        { entity: input.entity, actual: input.motion },
      ),
    );
  }
  const constraints = input.constraints ?? [];
  if (constraints.length > DERIVED_PHYSICS_LIMITS.maxConstraintsPerCandidate) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-budget-exceeded',
        `one candidate contains at most ${DERIVED_PHYSICS_LIMITS.maxConstraintsPerCandidate} constraint updates`,
        'submit a bounded constraint set for this body',
        { entity: input.entity, actual: constraints.length },
      ),
    );
  }
  const seams = input.seams ?? [];
  const shapeById = new Map(shapes.map((shape) => [shape.id, shape]));
  for (const seam of seams) {
    const shapeA = shapeById.get(seam.shapeA);
    const shapeB = shapeById.get(seam.shapeB);
    const a = shapeA?.kind === 'heightfield' ? undefined : shapeA;
    const b = shapeB?.kind === 'heightfield' ? undefined : shapeB;
    const aRotation = a?.rotation ?? [0, 0, 0, 1];
    const bRotation = b?.rotation ?? [0, 0, 0, 1];
    const aOrigin = a?.origin ?? [0, 0, 0];
    const bOrigin = b?.origin ?? [0, 0, 0];
    const quaternionDot = aRotation.reduce(
      (sum, value, index) => sum + value * (bRotation[index] ?? 0),
      0,
    );
    const localOriginDelta: [number, number, number] = [
      (bOrigin[0] ?? 0) - (aOrigin[0] ?? 0),
      (bOrigin[1] ?? 0) - (aOrigin[1] ?? 0),
      (bOrigin[2] ?? 0) - (aOrigin[2] ?? 0),
    ];
    // `origin` is expressed in the body's frame while Rapier's seam shift is
    // expressed in shape A's voxel frame. Move the body-local delta through
    // the inverse of A's local-to-body rotation before quantizing it.
    const sharedGridDelta = rotateVectorByQuaternion(localOriginDelta, [
      -aRotation[0],
      -aRotation[1],
      -aRotation[2],
      aRotation[3],
    ]);
    const alignedOrigins =
      a !== undefined &&
      b !== undefined &&
      seam.offset.every(
        (value, index) =>
          Math.abs((sharedGridDelta[index] ?? 0) / (a?.voxelSize[index] ?? 1) - value) <= 1e-5,
      );
    if (
      a === undefined ||
      b === undefined ||
      a.id === b.id ||
      !vectorFinite(seam.offset, 3) ||
      seam.offset.some((value) => !Number.isInteger(value)) ||
      a.voxelSize.some((value, index) => Math.abs(value - (b.voxelSize[index] ?? 0)) > 1e-6) ||
      Math.abs(Math.abs(quaternionDot) - 1) > 1e-5 ||
      !alignedOrigins
    ) {
      return err(
        new DerivedPhysicsError(
          'derived-seam-invalid',
          'a voxel seam joins same-grid shapes with integer offset in the shared rotated grid frame',
          'rotate the local origin delta into the shared grid frame and use an integer grid offset',
          { entity: input.entity, shapeId: seam.shapeA },
        ),
      );
    }
  }
  const seenConstraints = new Set<string>();
  for (const constraint of constraints) {
    if (seenConstraints.has(constraint.id)) {
      return err(
        new DerivedPhysicsError(
          'derived-constraint-invalid',
          'one candidate contains one update per constraint identity',
          'merge duplicate constraint updates before preparation',
          { entity: input.entity, constraintId: constraint.id },
        ),
      );
    }
    seenConstraints.add(constraint.id);
    for (const dependency of [constraint.bodyASource, constraint.bodyBSource]) {
      if (
        typeof dependency.sourceKey !== 'string' ||
        !ID_RE.test(dependency.sourceKey) ||
        !Number.isInteger(dependency.revision) ||
        dependency.revision < 0
      ) {
        return err(
          new DerivedPhysicsError(
            'derived-constraint-invalid',
            'constraint endpoint sourceKey and revision are stable and non-negative',
            'refresh both endpoint dependencies before preparing the constraint',
            { entity: input.entity, constraintId: constraint.id },
          ),
        );
      }
    }
  }
  const cellCount = shapes.reduce(
    (sum, shape) =>
      sum + (shape.kind === 'heightfield' ? shape.heights.length : shape.cells.length / 3),
    0,
  );
  if (cellCount > DERIVED_PHYSICS_LIMITS.maxCellsPerCandidate) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-budget-exceeded',
        `one candidate contains at most ${DERIVED_PHYSICS_LIMITS.maxCellsPerCandidate} cells`,
        'reduce the voxel input or split it at a body boundary',
        { entity: input.entity, actual: cellCount },
      ),
    );
  }
  if (
    estimateDerivedPhysicsInputBytes({ ...input, shapes, constraints, seams }) >
    DERIVED_PHYSICS_LIMITS.maxCandidateBytes
  ) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-budget-exceeded',
        `one candidate stages at most ${DERIVED_PHYSICS_LIMITS.maxCandidateBytes} bytes`,
        'reduce cells and constraint metadata before preparing the candidate',
        { entity: input.entity },
      ),
    );
  }
  return ok(
    Object.freeze({
      ...input,
      shapes: Object.freeze(shapes),
      seams: Object.freeze(
        seams.map((seam) => ({ ...seam, offset: [...seam.offset] as PhysicsVector })),
      ),
      ...(mass.value === undefined ? {} : { massProperties: mass.value }),
      ...(input.motion === undefined
        ? {}
        : {
            motion: Object.freeze({
              centerOfMass: [...input.motion.centerOfMass] as PhysicsVector,
              linearVelocity: [...input.motion.linearVelocity] as PhysicsVector,
              angularVelocity: [...input.motion.angularVelocity] as PhysicsVector,
              ...(motionRotation === undefined ? {} : { rotation: motionRotation }),
            }),
          }),
      constraints: Object.freeze([...constraints]),
      velocityPolicy: input.velocityPolicy ?? 'preserve',
    }),
  );
}

/** Estimate staged CPU/native input bytes for the bounded admission budget. */
export function estimateDerivedPhysicsInputBytes(input: DerivedPhysicsCandidateInput): number {
  const shapeBytes = input.shapes.reduce(
    (sum, shape) =>
      sum +
      (shape.kind === 'heightfield'
        ? shape.heights.length * 4
        : (shape.cells instanceof Int32Array ? shape.cells.length / 3 : shape.cells.length) * 32) +
      128,
    0,
  );
  const seamBytes = (input.seams?.length ?? 0) * 64;
  const constraintBytes = (input.constraints?.length ?? 0) * 192;
  return shapeBytes + seamBytes + constraintBytes + 256;
}
