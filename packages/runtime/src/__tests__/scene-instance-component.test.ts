// feat-20260608-scene-nesting-ecs-fication M2 / w15 (red phase) — SceneInstance
// component definition + vocab validation.
//
// Confirms:
//   - `defineComponent('SceneInstance', { source: 'shared<SceneAsset>',
//      mapping: 'array<entity>', state: 'unique<SceneInstanceState>' })` registers
//      via the global `resolveComponent` index (single ECS schema vocab path)
//   - schema reads back exactly the 3 D-2 fields (source / mapping / state)
//   - SceneInstanceState interface is a runtime-only TS interface (no ECS
//     schema vocab entry); the ref<SceneInstanceState> field stores a u32
//     handle, the payload is held in the World's UniqueRefStore
//
// Plan anchor: plan-strategy §D-2 (single ref wraps SceneInstanceState
// dynamic structure); plan-tasks §M2 / w15.

import { resolveComponent } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { SceneInstance } from '../components/scene-instance';

describe('SceneInstance component (w15)', () => {
  it('registers via the global resolveComponent index', () => {
    const token = resolveComponent('SceneInstance');
    expect(token).toBeDefined();
    expect(token).toBe(SceneInstance);
  });

  it('has the D-2 3-field schema', () => {
    const schema = SceneInstance.schema as Record<string, unknown>;
    const fieldNames = Object.keys(schema).sort();
    expect(fieldNames).toEqual(['mapping', 'source', 'state']);
  });

  it('source field is shared<SceneAsset>', () => {
    const schema = SceneInstance.schema as Record<string, string>;
    expect(schema.source).toBe('shared<SceneAsset>');
  });

  it('mapping field is array<entity>', () => {
    const schema = SceneInstance.schema as Record<string, string>;
    expect(schema.mapping).toBe('array<entity>');
  });

  it('state field is ref<SceneInstanceState>', () => {
    const schema = SceneInstance.schema as Record<string, string>;
    expect(schema.state).toBe('unique<SceneInstanceState>');
  });

  it('component name is "SceneInstance" (not "SceneInstanceComponent")', () => {
    expect(SceneInstance.name).toBe('SceneInstance');
  });
});
