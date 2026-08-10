import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  extractFrames,
  MeshFilter,
  MeshRenderer,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render/internal';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';

const ENTITY_COUNT = 10_000;
const SAMPLE_COUNT = 101;

function buildWorld(inherited: boolean, withHierarchy: boolean): World {
  const world = new World();
  const parent = withHierarchy
    ? world
        .spawn(
          { component: Transform, data: {} },
          ...(inherited
            ? [{ component: Visibility, data: { state: VisibilityStateValue.visible } }]
            : []),
        )
        .unwrap()
    : undefined;

  for (let index = 0; index < ENTITY_COUNT; index++) {
    world
      .spawn(
        { component: Transform, data: {} },
        ...(parent === undefined ? [] : [{ component: ChildOf, data: { parent } }]),
        ...(inherited
          ? [{ component: Visibility, data: { state: VisibilityStateValue.inherited } }]
          : []),
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
  }
  return world;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measureWorldSamples(worlds: readonly World[]): number[][] {
  for (const world of worlds) extractFrames([world], 0);
  const samples = worlds.map(() => [] as number[]);
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    const firstWorldIndex = sample % worlds.length;
    for (let offset = 0; offset < worlds.length; offset++) {
      const worldIndex = (firstWorldIndex + offset) % worlds.length;
      const world = worlds[worldIndex];
      if (world === undefined) continue;
      const start = performance.now();
      extractFrames([world], 0);
      samples[worldIndex]?.push(performance.now() - start);
    }
  }
  return samples;
}

function measureWorlds(worlds: readonly World[]): number[] {
  return measureWorldSamples(worlds).map((values) => median(values));
}

describe('visibility extraction performance (10k)', () => {
  it('keeps inherited hierarchy extraction within the 10 percent budget', () => {
    const flat = buildWorld(false, false);
    const hierarchy = buildWorld(false, true);
    const inherited = buildWorld(true, true);
    const flatMedian = measureWorlds([flat])[0] ?? 0;
    const [hierarchyMedian = 0, inheritedMedian = 0] = measureWorlds([hierarchy, inherited]);
    const overhead = inheritedMedian / Math.max(hierarchyMedian, 0.001) - 1;
    // biome-ignore lint/suspicious/noConsole: retain benchmark profile evidence
    console.info(
      `[m3-b-performance] flat=${flatMedian.toFixed(3)}ms hierarchy=${hierarchyMedian.toFixed(3)}ms inherited=${inheritedMedian.toFixed(3)}ms overhead=${(overhead * 100).toFixed(2)}% samples=${SAMPLE_COUNT}`,
    );

    expect(overhead).toBeLessThanOrEqual(0.1);
  }, 60_000);
});
