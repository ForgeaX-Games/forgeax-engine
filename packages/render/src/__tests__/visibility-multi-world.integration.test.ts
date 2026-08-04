import { World } from '@forgeax/engine-ecs';
import {
  extractFrames,
  resolveVisibility,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render/internal';
import { ChildOf } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';

describe('visibility World isolation', () => {
  it('does not share intent or effective results for equal entity handles', () => {
    const hiddenWorld = new World();
    const visibleWorld = new World();
    const hidden = hiddenWorld
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.hidden } })
      .unwrap();
    const visible = visibleWorld
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.visible } })
      .unwrap();

    expect(hidden).toBe(visible);
    expect(resolveVisibility(hiddenWorld).get(hidden)?.effective).toBe('hidden');
    expect(resolveVisibility(visibleWorld).get(visible)?.effective).toBe('visible');
  });

  it('keeps hierarchy parent lookup and snapshots local to each World', () => {
    const first = new World();
    const second = new World();
    const firstParent = first
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.hidden } })
      .unwrap();
    const secondParent = second
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.visible } })
      .unwrap();
    const firstChild = first
      .spawn(
        { component: Visibility, data: { state: VisibilityStateValue.inherited } },
        { component: ChildOf, data: { parent: firstParent } },
      )
      .unwrap();
    const secondChild = second
      .spawn(
        { component: Visibility, data: { state: VisibilityStateValue.inherited } },
        { component: ChildOf, data: { parent: secondParent } },
      )
      .unwrap();
    const frame = extractFrames([first, second], 0);

    expect(frame.visibilitySnapshots).toHaveLength(2);
    expect(frame.visibilitySnapshots[0]?.get(firstChild)?.effective).toBe('hidden');
    expect(frame.visibilitySnapshots[1]?.get(secondChild)?.effective).toBe('visible');
  });
});
