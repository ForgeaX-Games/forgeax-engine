// parse-scene.ts — FBX JSON POD to ScenePod bridge (t29).

import type { SceneEntityPod, ScenePod } from '@forgeax/engine-types';

export interface FbxRawNode {
  readonly name: string;
  readonly transform: {
    readonly translation: [number, number, number];
    readonly rotation: [number, number, number, number];
    readonly scale: [number, number, number];
  };
  readonly meshIndex: number;
  readonly children: readonly number[];
}

export interface FbxRawNodes {
  readonly nodes?: readonly FbxRawNode[];
}

export function parseScene(rawNodes: FbxRawNodes): ScenePod {
  const nodes = rawNodes.nodes ?? [];
  const entities: SceneEntityPod[] = nodes.map((n) => ({
    name: n.name,
    transform: {
      translation: n.transform.translation,
      rotation: n.transform.rotation,
      scale: n.transform.scale,
    },
    meshIndex: n.meshIndex >= 0 ? n.meshIndex : null,
    children: n.children,
  }));

  return {
    entities,
    rootEntityIndex: 0,
  };
}
