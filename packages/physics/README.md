# @forgeax/engine-physics

Physics interface package: ECS component schemas, PhysicsWorld resource shape, error codes, and enum constants. Backend implementations live in `@forgeax/engine-physics-rapier3d` and `@forgeax/engine-physics-rapier2d`.

## Quick Start

Attach three components to an entity and the physics engine drives its position every frame:

```ts
import { Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-runtime';

// Dynamic body: falls under gravity, responds to forces.
world.spawn(
  { component: Transform, data: { pos: [0, 5, 0] } },
  { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 1 } },
  { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.5 } },
);

// Static body: immovable, ground/collision target.
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0] } },
  { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
  { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [5, 1, 5] } },
);
```

Enable physics by passing `physicsPlugin` to `createApp`:

```ts
import { physicsPlugin } from '@forgeax/engine-physics';

const app = await createApp(canvas, { plugins: [physicsPlugin('rapier-3d')] });
```

## Three-Phase Tick Pipeline

Three ECS systems run in order every frame (registered by `physicsPlugin` during `createApp`):

| Phase | System Name | Runs After | What It Does |
|:--|:--|:--|:--|
| 1. Sync | `physicsSyncBackend` | `propagateTransforms` | Iterates archetypes with (Transform, RigidBody, Collider); calls `ensureBody` to create Rapier bodies for new entities |
| 2. Step | `physicsStepSimulation` | `physicsSyncBackend` | Reads `Time.dt` resource; calls `PhysicsWorld.step()` to advance simulation (skips when dt <= 0 or > 0.1s) |
| 3. Writeback | `physicsWriteback` | `physicsStepSimulation` | Calls `writebackDynamicBodies()`; writes Rapier body positions back to ECS `Transform.pos` |

All three systems early-return safely when the `PhysicsWorld` resource is not yet available (WASM fire-and-forget load).

## Enum Constants and Narrowing Helpers

ECS `enum` fields map to `Uint32Array` numeric columns. Use named constants to avoid magic numbers:

### RigidBodyType

```ts
RigidBodyTypeValue.static    // 0
RigidBodyTypeValue.dynamic   // 1
RigidBodyTypeValue.kinematic // 2
```

Narrowing helper: `rigidBodyTypeFromF32(n: number): RigidBodyType` returns `'static' | 'dynamic' | 'kinematic'`.

### ColliderShape

```ts
ColliderShapeValue.cuboid  // 0
ColliderShapeValue.sphere  // 1
ColliderShapeValue.capsule // 2
```

Narrowing helper: `colliderShapeFromF32(n: number): ColliderShape` returns `'cuboid' | 'sphere' | 'capsule'`.

Backend implementations use the narrowing helpers in `switch` statements for exhaustive matching (no default arm).

## Component Schemas

### RigidBody

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `type` | `enum` | `0` (static) | `static` / `dynamic` / `kinematic` |
| `mass` | `f32` | `0` | Additional mass (dynamic only; collider mass comes from density) |
| `linearDamping` | `f32` | `0` | Velocity damping per second |
| `angularDamping` | `f32` | `0` | Angular velocity damping per second |
| `gravityScale` | `f32` | `1` | Multiplier for world gravity |
| `ccdEnabled` | `bool` | `false` | Continuous collision detection |

### Collider

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `shape` | `enum` | `0` (cuboid) | `cuboid` / `sphere` / `capsule` |
| `halfExtents` | `array<f32, 3>` | `[0.5, 0.5, 0.5]` | Cuboid half-width/height/depth |
| `radius` | `f32` | `0` | Sphere radius or capsule radius |
| `halfHeight` | `f32` | `0` | Capsule half-height (along Y) |
| `friction` | `f32` | `0.5` | Coulomb friction coefficient |
| `restitution` | `f32` | `0` | Bounciness (0 = inelastic, 1 = perfectly elastic) |
| `density` | `f32` | `1` | Mass per volume (affects dynamic body total mass) |
| `isSensor` | `bool` | `false` | Sensor-only collider (no contact response) |
| `collisionGroups` | `u32` | `0` | Rapier collision groups bitmask |
| `solverGroups` | `u32` | `0` | Rapier solver groups bitmask |

### CollidingEntities

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `entities` | `array<entity>` | `[]` | Set of entities currently colliding with the holder |

### CharacterController

Tuning + grounded output for the kinematic character movement primitive. Spawn
alongside `RigidBody({ type: 'kinematic' })` + `Collider` to opt an entity into
`moveAndSlide` (see below). Slope angles are in **degrees** (the backend converts
to radians). `autoStepMaxHeight === 0` disables auto-step; `snapToGroundDist === 0`
disables ground-snap — one field carries both the switch and the value. The same
component is used by 2D and 3D (every field is dimension-agnostic).

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `offset` | `f32` | `0.01` | Skin thickness; prevents penetration |
| `maxSlopeClimbDeg` | `f32` | `45` | Max climbable slope angle (degrees) |
| `minSlopeSlideDeg` | `f32` | `30` | Slope angle past which sliding starts (degrees) |
| `autoStepMaxHeight` | `f32` | `0.3` | Max auto-step height (`0` = off) |
| `autoStepMinWidth` | `f32` | `0.2` | Min step width to be steppable |
| `snapToGroundDist` | `f32` | `0.2` | Downhill ground-snap distance (`0` = off) |
| `grounded` | `bool` | `false` | **Engine-written** — true after the last `moveAndSlide` resolved a ground contact. Read-only for game code. |

> [!NOTE]
> `grounded` is a `bool` schema field; `world.get(e, CharacterController).value.grounded`
> materializes as a JS `boolean` (not `0`/`1`) — compare `=== true`, never `!== 0`.
> On a continuous slope Rapier reports `grounded === false` while sliding; the
> snap-to-ground effect shows in the resolved position (the character stays on the
> surface), not in the flag.

## Character Movement: `moveAndSlide`

`PhysicsWorld.moveAndSlide(entity, desiredDelta): Vec3` (and the symmetric
`PhysicsWorld2D.moveAndSlide(entity, desiredDelta: Vec2): Vec2`) is the engine's
unopinionated kinematic character primitive (modeled on Unity
`CharacterController.Move`). The game layer computes `desiredDelta` from input +
gravity + jump each frame; `moveAndSlide` resolves it against world geometry with
collision response, slope handling, auto-step, and ground-snap, then writes the
resolved position back to the entity's `Transform` and the contact state to
`CharacterController.grounded`. It returns the actual displacement applied.

```ts
import { CharacterController, Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';

const character = world.spawn(
  { component: Transform, data: { pos: [0, 0.45, 0] } },
  { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
  { component: Collider, data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 } },
  { component: CharacterController, data: {} },
).unwrap();

// Per frame (e.g. inside app.registerUpdate):
const pw = world.getResource('PhysicsWorld'); // PhysicsWorld | PhysicsWorld2D
const actual = pw.moveAndSlide(character, [dx, dy, dz]); // Transform + grounded written back
```

Requirements: the entity must carry a kinematic `RigidBody`, a `Collider`, and a
`CharacterController`. There is no per-call options object and no `dt` parameter —
tuning is read from the component each call, and the delta already encodes elapsed
time. Spawn the collider at its resting height (capsule center = ground top +
radius + halfHeight); a capsule penetrating the floor has a degenerate contact and
will not auto-step or report grounded correctly.

Character entities are routed exclusively through `moveAndSlide`: the
`physicsSyncBackend` kinematic mirror skips any archetype carrying
`CharacterController` so it does not double-write the body the primitive owns.

**Readiness contract**: the Rapier body is built asynchronously by the first
`physicsSyncBackend` tick after `app.start()` (WASM fire-and-forget load). Before
that tick, `PhysicsWorld.hasBody(entity)` returns `false`. Per-frame drivers must
guard with `if (!pw.hasBody(entity)) return;` before calling `moveAndSlide` --
do not rely on catching `body-not-found` as control flow.

## Error Codes

`PhysicsErrorCode` (9 members, closed union). Exhaustive `switch` without `default`. SSOT: `packages/physics/src/errors.ts`.

`moveAndSlide` throws `PhysicsError` with `controller-requires-kinematic` (body is
not kinematic), `body-not-found` (no Rapier body for the entity), or
`collider-not-found` (body has no collider).

## Architecture Notes

- **Not a backend**: this package defines interfaces and schemas only. Runtime simulation requires a backend (`@forgeax/engine-physics-rapier3d` or `@forgeax/engine-physics-rapier2d`).
- **ECS bridge**: backend packages call `registerPhysicsSystems(world, Transform)` to wire the three-phase tick pipeline into the ECS schedule.
- **Fire-and-forget**: WASM backends load asynchronously; entities spawned before load are picked up once the `PhysicsWorld` resource appears.
- **Component schemas SSOT**: `packages/physics/src/components.ts` is the authoritative definition for all physics component fields and types.
