# @forgeax/engine-project

Game-project SSOT — zod schema + injectable loader + resolve layer for `forge.json`, the authoritative game manifest contract.

See [`AGENTS.md`](../../AGENTS.md) § "Project model" for the conceptual model.

## Usage

`loadGameProject` is the primary entry point. Inject a reader so the loader stays free of `node:fs` / `fetch` (the same loader runs in server, editor, and tests):

```ts
import { loadGameProject, FORGE_JSON } from '@forgeax/engine-project';
import { readFile } from 'node:fs/promises';

const result = await loadGameProject((path) => readFile(`/games/my-game/${path}`, 'utf-8'));
if (result.ok) {
  const project = result.value;            // typed GameProject (z.infer)
  console.log(project.name, project.defaultScene);
} else {
  // structured, actionable failure (charter P3)
  console.error(result.error.code, result.error.hint);
}
```

Synchronous consumers (e.g. a sync `ContextSlot`) use the companion `loadGameProjectSync` — identical injection contract with a sync reader `(path) => string`:

```ts
import { loadGameProjectSync } from '@forgeax/engine-project';
import { readFileSync } from 'node:fs';

const r = loadGameProjectSync((path) => readFileSync(`/games/my-game/${path}`, 'utf-8'));
const name = r.ok ? r.value.name : null;
```

`resolveDefaultScene({ read, resolveGuid })` is the two-layer resolve path: it loads the project, then resolves `defaultScene` through an injected GUID resolver (asserting `kind === 'scene'`).

## Error codes

Every failure returns a `GameProjectError` with `.code` / `.expected` / `.hint` / `.detail`. Switch exhaustively on `.code` (closed union, no `default` needed):

| code | when |
|:--|:--|
| `forge-missing` | reader threw / forge.json not found |
| `forge-parse-failed` | invalid JSON |
| `forge-schema-invalid` | valid JSON, fails schema (missing / wrong-typed required field) |
| `forge-unknown-field` | `.strict()` rejected an unknown field (e.g. legacy `scenes[]`) |
| `forge-guid-malformed` | `defaultScene` present but not a valid GUID |
| `forge-scene-unresolved` | `resolveDefaultScene` could not resolve the GUID to a `kind: 'scene'` asset |

## Schema as contract

`GameProjectSchema` is the authoritative field list (charter P2) — read it instead of prose, and derive types via `import type { GameProject } from '@forgeax/engine-project'`.
