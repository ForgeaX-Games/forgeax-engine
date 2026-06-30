# @forgeax/engine-state

> Single-world typed-state machine: `defineState` + `setNextState` + state-scoped entity lifecycle (`despawnOnExit`/`despawnOnEnter`) + `OnEnter`/`OnExit` user schedule labels. Zero-intrusion on ECS -- consumes existing `defineComponent`/`addSystem`/Resource CRUD/`queryRun`/`despawn` primitives only.

## API surface

| Export | Kind | Purpose |
|:--|:--|:--|
| `defineState(name, variants as const)` | function | Define a typed state machine at module level; returns branded `StateToken` |
| `StateToken<N, V>` | interface | Branded token holding `name`, `variants` (readonly tuple), `nameToIdx` (Map), `defaultValue` |
| `StateTokenVariant<T>` | type | Extract the variant union from a `StateToken` |
| `StateTokenName<T>` | type | Extract the name literal from a `StateToken` |
| `getRegisteredTokens()` | function | Read-only snapshot of all globally registered tokens |
| `setNextState(world, token, variant)` | function | Request a state transition for next frame; returns `Result<void, StateError>` |
| `setNextStateForce(world, token, variant)` | function | Like `setNextState` but `force=true` (re-fires even same-state) |
| `getState(world, token)` | function | Read current state variant string; returns `Result<string, StateError>` |
| `getPreviousState(world, token)` | function | Read previous-frame state variant string; returns `Result<string, StateError>` |
| `registerStatesPlugin(world)` | function | Idempotent: inserts per-token Resources + registers `transitionStates` system |
| `despawnOnExit(world, entity, token, variant)` | function | Scope entity to auto-despawn when token leaves variant |
| `despawnOnEnter(world, entity, token, variant)` | function | Scope entity to auto-despawn when token enters variant |
| `OnEnter(token, variant)` | function | Return dispatch label string for enter callbacks |
| `OnExit(token, variant)` | function | Return dispatch label string for exit callbacks |
| `addOnEnter(token, variant, fn)` | function | Register callback for entering variant; returns `UnsubscribeHandle` |
| `addOnExit(token, variant, fn)` | function | Register callback for leaving variant; returns `UnsubscribeHandle` |
| `StateCallback` | type | `(world: World) => void` |
| `UnsubscribeHandle` | type | `() => void` |
| `stateResourceKey(token)` | function | Resource key string for per-token State |
| `nextStateResourceKey(token)` | function | Resource key string for per-token NextState |
| `previousStateResourceKey(token)` | function | Resource key string for per-token PreviousState |

## Error model

`StateErrorCode` is a 4-member closed union, order-locked:

| code | trigger | return style |
|:--|:--|:--|
| `'state-already-defined'` | `defineState()` called with a name already registered | throw (programmer error) |
| `'state-not-registered'` | `setNextState()` / `getState()` called before `registerStatesPlugin()` | `Result.err` |
| `'invalid-variant'` | `setNextState()` called with a variant string not in the token's variants tuple | `Result.err` |
| `'state-default-required'` | `defineState()` called with empty or duplicate variants array | throw (programmer error) |

All errors carry the standard 4-field surface: `.code` / `.expected` / `.hint` / `.detail`. The `detail` field is narrowed per `.code` via the `StateErrorDetail` discriminated union. SSOT at `packages/state/src/errors.ts`.

## Transition pipeline

Per-frame, per-token, the `transitionStatesSystem` (registered by `registerStatesPlugin`) executes 8 steps:

1. Read `NextState` Resource -- if undefined, skip (zero-cost continue)
2. If `prev === next` and `!force`, clear `NextState` and skip (same-state no-op)
3. Write `PreviousState = prev`, flip `State = next`
4. Despawn exit-scoped entities (`__scopedTo__<name>` with mode=0, value=prev)
5. Dispatch `OnExit` callbacks for prev variant (errors bubble -- see Constraints)
6. Despawn enter-scoped entities (mode=1, value=next)
7. Dispatch `OnEnter` callbacks for next variant (errors bubble -- see Constraints)
8. Clear `NextState = undefined` (unless callbacks wrote a new payload)

Schedule anchors: `after: ['input-frame-start-scan']`, `before: ['propagateTransforms']`.

## Constraints

- **Module-level definition**: `defineState` must be called at module level. It writes to a global registry; duplicate names throw.
- **One scoped component per entity per token**: `__scopedTo__<tokenName>` uses ECS default `exclusive=false`. Adding a second scoped marker on the same entity throws `ComponentAlreadyPresentError`.
- **Transition is deferred one frame**: `setNextState` writes `NextState` Resource; `getState` returns the current value until `transitionStatesSystem` flips it.
- **`force` flag**: `setNextStateForce` bypasses the same-state no-op guard. Use for restart/retry semantics.
- **Callback errors bubble**: `OnEnter`/`OnExit` callbacks are *not* wrapped in try-catch. A throwing callback aborts `transitionStatesSystem` and propagates to the ECS schedule (per requirements sec 7). The `State` flip in step 3 has already committed and is not rolled back; later tokens in the same frame do not transition. Keep callbacks total -- validate inside them and return rather than throw.
- **Despawn tolerance**: Entities already dead at scoped-despawn time are silently skipped (ECS `world.despawn` is idempotent on already-despawned entities).

## Auto-registration in createApp

Both `createApp` canvas and assemble forms call `registerStatesPlugin(world)` internally. State tokens defined with `defineState` before `createApp` are auto-wired. Manual `createRenderer` users must call `registerStatesPlugin(world)` before any state operation; otherwise `setNextState`/`getState` return `StateError { code: 'state-not-registered' }`.

## CLI plugin

`forgeax-engine-remote-state` is a kubectl-style plugin bin (4th-path discovery via `forgeax-engine-remote-` prefix scan). Two subcommands:

- `list` -- prints all registered tokens with name, current variant, and variants list
- `get <name>` -- prints the current variant string for a named token

Source: `packages/state/src/cli-state.ts`.

## Relationship to ECS

The state package has zero custom ECS primitives. It consumes only:

- `defineComponent` -- for `__scopedTo__<tokenName>` component schemas
- `world.addSystem` -- for `transitionStates` system registration
- `world.insertResource` / `world.getResource` / `world.hasResource` -- for per-token `State`/`NextState`/`PreviousState` Resource CRUD
- `createQueryState` + `queryRun` -- for collecting scoped entities
- `resolveComponent` -- for looking up scoped component schemas
- `world.despawn` -- for scoped entity teardown