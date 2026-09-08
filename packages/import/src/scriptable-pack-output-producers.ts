import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ScriptablePackSceneComponent } from '@forgeax/engine-pack/source';
import { externalizeSceneAsset } from '@forgeax/engine-scene';
import type {
  AnimationGraph,
  AssetGuid as AssetGuidType,
  AssetRef,
  AudioClipAsset,
  EquirectAsset,
  FontAsset,
  ImportedArtifactBody,
  MaterialAsset,
  MaterialTextureReference,
  MaterialTextureValue,
  MeshAsset,
  ParticleEffectAsset,
  RenderPipelineAsset,
  SamplerAsset,
  SceneAsset,
  SkeletonAsset,
  SkinAsset,
  TextureAsset,
  TilesetAsset,
  VideoAsset,
} from '@forgeax/engine-types';
import { err, ImportError, MATERIAL_TEXTURE_SLOTS, ok } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { packMeshBinV4 } from './mesh-bin.js';
import {
  type AssetOutputInput,
  type AssetOutputProducer,
  AssetOutputProducerRegistry,
  type AssetOutputProduct,
} from './scriptable-pack.js';

function producerError(input: AssetOutputInput, reason: unknown): ImportError {
  return new ImportError({
    code: 'import-internal-error',
    expected: `ScriptablePack ${input.asset.kind} output ${input.sourceKey} to satisfy its domain producer contract`,
    hint: 'fix the generated Asset payload and rebuild the ScriptablePack',
    detail: { reason: reason instanceof Error ? reason.message : String(reason) },
  });
}

function formatGuid(value: AssetGuidType | string): string {
  if (typeof value === 'string') {
    const parsed = AssetGuid.parse(value);
    if (!parsed.ok) throw parsed.error;
    return AssetGuid.format(parsed.value);
  }
  return AssetGuid.format(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function particleProgramArtifact(effect: ParticleEffectAsset): {
  readonly program: ParticleEffectAsset['program'];
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
} {
  const artifactProgram = { format: effect.program.format, emitters: effect.program.emitters };
  const bytes = new TextEncoder().encode(canonical(artifactProgram));
  const fingerprint = `sha256:${bytesToHex(sha256(bytes))}`;
  return {
    program: { ...effect.program, fingerprint },
    bytes,
    fingerprint,
  };
}

function materialProduct(input: AssetOutputInput): AssetOutputProduct {
  if (input.asset.kind !== 'material') throw new TypeError('expected MaterialAsset');
  const material = input.asset as MaterialAsset;
  const refs: AssetRef[] = [];
  const addRef = (
    guid: AssetGuidType | string,
    sourceField: NonNullable<AssetRef['sourceField']>,
  ): number => {
    refs.push({ guid: formatGuid(guid), sourceField });
    return refs.length - 1;
  };

  const addMaterialRef = (
    value: MaterialTextureReference,
    sourceField: NonNullable<AssetRef['sourceField']>,
  ): number => {
    if (typeof value === 'number') {
      throw new TypeError('material texture references must be GUIDs, not runtime handles');
    }
    return addRef(value, sourceField);
  };

  const textureFields =
    material.parameters === undefined
      ? new Set<string>(MATERIAL_TEXTURE_SLOTS)
      : new Set(
          material.parameters
            .filter((parameter) => parameter.type === 'texture')
            .map((parameter) => parameter.name),
        );

  const parent =
    material.parent === undefined ? undefined : addRef(material.parent, { fieldName: 'parent' });
  const values: Record<string, unknown> = {};
  for (const fieldName of Object.keys(material.values ?? {}).sort()) {
    const value = material.values?.[fieldName];
    if (typeof value === 'string' && textureFields.has(fieldName)) {
      values[fieldName] = addMaterialRef(value, { componentName: '<material>', fieldName });
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'texture' in value
    ) {
      const texture = value as MaterialTextureValue;
      values[fieldName] = {
        ...texture,
        texture: addMaterialRef(texture.texture, { componentName: '<material>', fieldName }),
        ...(texture.sampler === undefined
          ? {}
          : {
              sampler: addMaterialRef(texture.sampler, {
                componentName: '<material>',
                fieldName: `${fieldName}.sampler`,
              }),
            }),
      };
    } else {
      values[fieldName] = value;
    }
  }

  const { parent: _parent, values: _values, ...materialShape } = material;
  return {
    payload: {
      ...materialShape,
      ...(parent === undefined ? {} : { parent }),
      ...(material.values === undefined ? {} : { values }),
    },
    refs,
    artifacts: {},
  };
}

function meshProduct(input: AssetOutputInput): AssetOutputProduct {
  if (input.asset.kind !== 'mesh') throw new TypeError('expected MeshAsset');
  const mesh = input.asset as MeshAsset;
  const refs: AssetRef[] = [];
  for (let slotIndex = 0; slotIndex < mesh.materialSlots.length; slotIndex++) {
    const defaultMaterial = mesh.materialSlots[slotIndex]?.defaultMaterial;
    if (defaultMaterial === undefined) continue;
    refs.push({
      guid: formatGuid(defaultMaterial),
      sourceField: { fieldName: 'materialSlots', arrayIndex: slotIndex },
    });
  }
  return {
    payload: mesh,
    refs,
    artifacts: {
      body: {
        mediaType: 'application/x-forgeax-mesh',
        assetCodec: { name: 'mesh-binary', version: '4' },
        bytes: (() => {
          const packed = packMeshBinV4(
            mesh,
            input.sourceKey,
            refs.map((reference) => reference.guid),
          );
          if (!packed.ok) {
            throw packed.error;
          }
          return packed.value;
        })(),
      },
    },
  };
}

function sceneProduct(
  input: AssetOutputInput,
  components: ReadonlyMap<string, Readonly<Record<string, string>>>,
): AssetOutputProduct {
  if (input.asset.kind !== 'scene') throw new TypeError('expected SceneAsset');
  const externalized = externalizeSceneAsset(input.asset as SceneAsset, (componentName) => {
    const schema = components.get(componentName);
    if (schema === undefined) {
      throw new TypeError(
        `ScriptablePack scene component ${componentName} is missing from sceneComponents`,
      );
    }
    return schema;
  });
  if (!externalized.ok) throw new TypeError(`scene field ${externalized.error.field} is invalid`);
  return {
    payload: { kind: 'scene', ...externalized.value.payload },
    refs: externalized.value.refs,
    artifacts: {},
  };
}

function createSafeProducer(
  kind: AssetOutputProducer['kind'],
  version: string,
  product: (input: AssetOutputInput) => AssetOutputProduct,
): AssetOutputProducer {
  return {
    kind,
    version,
    produce(input) {
      try {
        return ok(product(input));
      } catch (error) {
        return err(producerError(input, error));
      }
    },
  };
}

function jsonArtifact(value: unknown): ImportedArtifactBody {
  return {
    mediaType: 'application/json',
    assetCodec: { name: 'forgeax-json', version: '1' },
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function ref(guid: AssetGuidType, fieldName: string, arrayIndex?: number): AssetRef {
  return {
    guid: formatGuid(guid),
    sourceField: { fieldName, ...(arrayIndex === undefined ? {} : { arrayIndex }) },
  };
}

function bytes(value: Uint8Array | Uint8ClampedArray): Uint8Array {
  return Uint8Array.from(value);
}

function ordinaryPodProduct(input: AssetOutputInput): AssetOutputProduct {
  const asset = input.asset;
  switch (asset.kind) {
    case 'texture': {
      const texture = asset as TextureAsset;
      return {
        payload: texture,
        refs: [],
        artifacts: {
          body: {
            mediaType: 'image/raw',
            assetCodec: { name: 'raw-image', version: '1' },
            bytes: bytes(texture.data),
          },
        },
      };
    }
    case 'equirect': {
      const equirect = asset as EquirectAsset;
      return {
        payload: equirect,
        refs: [],
        artifacts: {
          body: {
            mediaType: 'image/raw',
            assetCodec: { name: 'raw-image', version: '1' },
            bytes: bytes(equirect.data),
          },
        },
      };
    }
    case 'sampler': {
      const sampler = asset as SamplerAsset;
      return { payload: sampler, refs: [], artifacts: { body: jsonArtifact(sampler) } };
    }
    case 'font': {
      const font = asset as FontAsset;
      const atlas = ref(font.atlas, 'atlas');
      const sampler = ref(font.sampler, 'sampler');
      return {
        payload: {
          kind: font.kind,
          glyphs: font.glyphs,
          common: font.common,
          atlasGuid: atlas.guid,
          samplerGuid: sampler.guid,
        },
        refs: [atlas, sampler],
        artifacts: { body: jsonArtifact(font) },
      };
    }
    case 'render-pipeline': {
      const pipeline = asset as RenderPipelineAsset;
      return {
        payload: pipeline,
        refs: [],
        artifacts: { body: jsonArtifact(pipeline) },
      };
    }
    case 'tileset': {
      const tileset = asset as TilesetAsset;
      const refs = tileset.atlases.map((atlas, index) => {
        const parsed = AssetGuid.parse(atlas);
        if (!parsed.ok) throw parsed.error;
        return ref(parsed.value, 'atlases', index);
      });
      return {
        payload: { ...tileset, atlases: refs.map((_entry, index) => index) },
        refs,
        artifacts: { body: jsonArtifact(tileset) },
      };
    }
    case 'video': {
      const video = asset as VideoAsset;
      try {
        const url = new URL(video.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
          throw new Error('unsupported URL scheme');
      } catch (error) {
        throw new TypeError(
          `video URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { payload: video, refs: [], artifacts: {} };
    }
    case 'skeleton': {
      const skeleton = asset as SkeletonAsset;
      return {
        payload: skeleton,
        refs: [],
        artifacts: { body: jsonArtifact(skeleton) },
      };
    }
    case 'skin': {
      const skin = asset as SkinAsset;
      const skeletonGuid = AssetGuid.parse(skin.skeletonGuid);
      if (!skeletonGuid.ok) throw skeletonGuid.error;
      return {
        payload: skin,
        refs: [ref(skeletonGuid.value, 'skeletonGuid')],
        artifacts: { body: jsonArtifact(skin) },
      };
    }
    case 'animation-clip':
      return {
        payload: asset,
        refs: [],
        artifacts: { body: jsonArtifact(asset) },
      };
    case 'animation-graph': {
      const graph = asset as AnimationGraph;
      const refs: AssetRef[] = [];
      const nodes = graph.nodes.map((node, index) => {
        if (node.type !== 'clip') return node;
        const parsed = AssetGuid.parse(node.clip);
        if (!parsed.ok) throw parsed.error;
        const referenceIndex = refs.push(ref(parsed.value, 'nodes', index)) - 1;
        return { ...node, clip: referenceIndex };
      });
      return {
        payload: { kind: graph.kind, root: graph.root, nodes },
        refs,
        artifacts: { body: jsonArtifact(graph) },
      };
    }
    case 'audio': {
      const audio = asset as AudioClipAsset;
      return {
        payload: {
          kind: audio.kind,
          sourceKey: audio.sourceKey,
          mediaType: audio.mediaType,
          bytes: audio.bytes.slice(),
        },
        refs: [],
        artifacts: {
          source: {
            mediaType: audio.mediaType,
            assetCodec: { name: 'browser-audio', version: '1' },
            bytes: audio.bytes.slice(),
          },
        },
      };
    }
    case 'particle-effect': {
      const effect = asset as ParticleEffectAsset;
      const cooked = particleProgramArtifact(effect);
      return {
        payload: { ...effect, programFingerprint: cooked.fingerprint, program: cooked.program },
        refs: [],
        artifacts: {
          'particle-effect/program.json': {
            mediaType: 'application/json',
            assetCodec: { name: 'forgeax-vfx-program', version: effect.program.format },
            bytes: cooked.bytes,
          },
        },
      };
    }
    case 'material':
    case 'mesh':
    case 'scene':
      throw new TypeError(`ordinary producer received already-owned ${asset.kind} asset`);
  }
}

export const materialAssetOutputProducer = createSafeProducer(
  'material',
  'material-pack/1',
  materialProduct,
);
export const meshAssetOutputProducer = createSafeProducer('mesh', 'mesh-binary/4', meshProduct);

export function createSceneAssetOutputProducer(
  sceneComponents: readonly ScriptablePackSceneComponent[] = [],
): AssetOutputProducer {
  const schemas = new Map(
    sceneComponents.map((component) => [component.name, component.fields] as const),
  );
  return createSafeProducer('scene', 'scene-pack/3', (input) => sceneProduct(input, schemas));
}

export function createStandardAssetOutputProducerRegistry(
  sceneComponents: readonly ScriptablePackSceneComponent[] = [],
): AssetOutputProducerRegistry {
  const registry = new AssetOutputProducerRegistry();
  registry.register(materialAssetOutputProducer);
  registry.register(meshAssetOutputProducer);
  registry.register(createSceneAssetOutputProducer(sceneComponents));
  for (const kind of [
    'texture',
    'equirect',
    'sampler',
    'font',
    'render-pipeline',
    'tileset',
    'video',
    'skeleton',
    'skin',
    'animation-clip',
    'animation-graph',
    'audio',
    'particle-effect',
  ] as const) {
    registry.register(createSafeProducer(kind, 'ordinary-pod/1', ordinaryPodProduct));
  }
  return registry;
}
