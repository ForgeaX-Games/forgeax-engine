// schema.ts — GameProjectSchema + GuidString refinement (D-4, D-7)
//
// D-4 fields: id:string / name:string / schemaVersion:string / entry?:string /
// executionEntry?:string /
// defaultScene?:GuidString / physics?:union(enum+bool) / pointerLock?:bool /
// input?:string / preview?:nested-object. .strict() rejects unknown fields.
//
// D-7: GuidString refinement lives here (engine-project), calls
// AssetGuid.parse from engine-pack, translates PackError to zod error message.

import { AssetGuid } from '@forgeax/engine-pack/guid';
import { z } from 'zod';

// ── GuidString: zod refinement calling AssetGuid.parse (AC-04) ──────────────
export const GuidString = z.string().refine(
  (val) => AssetGuid.parse(val).ok,
  (val) => {
    const parsed = AssetGuid.parse(val);
    const message = !parsed.ok ? parsed.error.hint : `invalid GUID: ${val}`;
    return { message };
  },
);

// ── physics union: all 5 known values (D-4) ─────────────────────────────────
const PhysicsUnion = z.union([z.enum(['3d', '2d', 'rapier-3d', 'rapier-2d']), z.boolean()]);

// ── preview.skin nested object (D-4) ────────────────────────────────────────
const SkinSchema = z
  .object({
    sceneGuid: z.string().optional(),
    clipGuids: z.array(z.string()).optional(),
    clipDefault: z.string().optional(),
    scale: z.number().optional(),
    pos: z.array(z.number()).optional(),
  })
  .passthrough();

const PreviewSchema = z.object({ skin: SkinSchema }).passthrough();

// Digital Life NPC runtime policy embedded in forge.json. The Brain owns
// prompt/model execution; the game manifest only declares the bounded model
// and governor ceilings consumed by the server-side NPC adapter.
const NpcBudgetSchema = z
  .object({
    maxCallsPerMinute: z.number().int().positive().optional(),
    maxTokensPerMinute: z.number().int().positive().optional(),
    maxConcurrent: z.number().int().positive().optional(),
  })
  .strict();

const NpcConfigSchema = z
  .object({
    model: z.string().min(1).optional(),
    maxTokens: z.number().int().positive().optional(),
    budget: NpcBudgetSchema.optional(),
  })
  .strict();

export const PluginRealmSchema = z.enum(['host', 'engine', 'build']);

const PluginInjectSchema = z.union([
  z.array(z.string().min(1)),
  z.record(z.string().min(1), z.unknown()),
]);

const PluginEntryBase = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  disabled: z.boolean().nullable().optional(),
  inject: PluginInjectSchema.nullable().optional(),
  realm: PluginRealmSchema.optional(),
});

export interface GameProjectPluginEntry {
  readonly id: string;
  readonly name: string;
  readonly config?: unknown;
  readonly group?: boolean | null | undefined;
  readonly disabled?: boolean | null | undefined;
  readonly inject?: readonly string[] | Readonly<Record<string, unknown>> | null | undefined;
  readonly realm?: z.infer<typeof PluginRealmSchema> | undefined;
}

export const GameProjectPluginEntrySchema: z.ZodType<GameProjectPluginEntry> = z.lazy(() =>
  z.union([
    PluginEntryBase.extend({
      group: z.literal(true),
      config: z.array(GameProjectPluginEntrySchema),
    }).strict(),
    PluginEntryBase.extend({
      group: z.union([z.literal(false), z.null()]).optional(),
      config: z.unknown().optional(),
    }).strict(),
  ]),
);

export const GameProjectPluginsSchema = z
  .array(GameProjectPluginEntrySchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    const visit = (items: readonly GameProjectPluginEntry[]): void => {
      for (const entry of items) {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate plugin entry id: ${entry.id}`,
          });
        }
        seen.add(entry.id);
        if (entry.group === true) visit(entry.config as readonly GameProjectPluginEntry[]);
      }
    };
    visit(entries);
  });

// ── GameProjectSchema: strict zod object (AC-03, AC-05) ─────────────────────
// This schema is the authoritative field list for forge.json (charter P2) —
// read it instead of prose docs. Each field carries its contract inline.
export const GameProjectSchema = z
  .object({
    /** Stable game slug; matches the `.forgeax/games/<id>/` directory name. */
    id: z.string(),
    /** Human-facing display name (may contain any unicode). */
    name: z.string(),
    /** forge.json schema version, e.g. "1.0.0" — required so loaders can gate on format. */
    schemaVersion: z.string(),
    /** Optional bootstrap hook: entry module relative to game root (e.g. "main.ts", "src/main.ts"). */
    entry: z.string().optional(),
    /** Optional realm-local ExecutionBootstrapEntry module relative to game root. */
    executionEntry: z.string().optional(),
    /** Optional GUID of the scene to load first; must be a real scene asset GUID (GuidString-validated). */
    defaultScene: GuidString.optional(),
    /** Optional physics backend: enum tag ('3d'/'2d'/'rapier-3d'/'rapier-2d') or boolean on/off. */
    physics: PhysicsUnion.optional(),
    /** Optional flag requesting pointer-lock (FPS-style mouse capture) at play time. */
    pointerLock: z.boolean().optional(),
    /** Optional input scheme hint consumed by play-runtime (e.g. "fps"). */
    input: z.string().optional(),
    /** Optional editor preview config (skin scene/clips for the launcher card). */
    preview: PreviewSchema.optional(),
    /** Native DeepSeek Harness Entry tree, plus the ForgeaX build-only realm selector. */
    plugins: GameProjectPluginsSchema.optional(),
    /** Optional Digital Life NPC Brain policy consumed by the server adapter. */
    npc: NpcConfigSchema.optional(),
  })
  .strict();

// ── GameProject type: z.infer-derived (AC-02, AC-05) ────────────────────────
export type GameProject = z.infer<typeof GameProjectSchema>;
