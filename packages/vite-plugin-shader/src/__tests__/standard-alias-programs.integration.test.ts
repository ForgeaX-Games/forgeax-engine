import { resolve } from 'node:path';
import {
  GPU_DRIVEN_MATERIAL_ROW_BYTES,
  readShaderManifestPublication,
} from '@forgeax/engine-shader';
import { derive, type ParamSchemaEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { forgeaxShader } from '../index.js';

const root = resolve(import.meta.dirname, '../../../..');

describe('Standard template alias publication', () => {
  it.each([
    ['standard-clearcoat-factor-r', false],
    ['skin-clearcoat-factor-r', true],
  ] as const)(
    'retains the template geometry ABI: %s',
    async (file, skinned) => {
      const plugin = forgeaxShader({
        engineEntries: false,
        materialPackages: [resolve(root, `apps/hello/physical-material/src/${file}.pack.json`)],
      });
      const assets: { fileName: string; source: string }[] = [];
      const context = {
        emitFile(asset: { fileName: string; source: string }) {
          assets.push(asset);
          return asset.fileName;
        },
      };
      await plugin.buildStart?.call(context as never);
      plugin.generateBundle?.call(context as never);
      const emitted = assets.find((asset) => asset.fileName === 'shaders/manifest.json');
      expect(emitted).toBeDefined();
      if (emitted === undefined) throw new Error('Alias manifest missing');
      const manifest = (await readShaderManifestPublication(JSON.parse(emitted.source))) as {
        materialShaders: {
          paramSchema: string;
          variants: {
            defines: Record<string, boolean>;
            composedWgsl: string;
            receipt?: {
              directEntry: string;
              sceneIndexEntry?: string;
              materialRow: { byteLength: number };
              skinPaletteAddress?: { group: number; binding: number; stride: number };
              vertexInputs: { semantic: string }[];
            };
          }[];
        }[];
      };
      expect(manifest.materialShaders).toHaveLength(1);
      const entry = manifest.materialShaders[0];
      if (entry === undefined) throw new Error('Alias material missing');
      const schema = JSON.parse(entry.paramSchema) as readonly ParamSchemaEntry[];
      const variants = entry.variants;
      expect(variants).toHaveLength(6);
      for (const variant of variants ?? []) {
        expect(variant.receipt?.directEntry).toBe('vs_main');
        const sceneEntry = /@vertex\s+fn\s+vs_scene_index\s*\(/.test(variant.composedWgsl);
        if (variant.defines.STORAGE_BUFFER_AVAILABLE) {
          expect(variant.receipt?.sceneIndexEntry).toBe('vs_scene_index');
          expect(variant.receipt?.materialRow.byteLength).toBe(GPU_DRIVEN_MATERIAL_ROW_BYTES);
          expect(sceneEntry).toBe(variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE);
        } else {
          expect(variant.receipt?.sceneIndexEntry).toBeUndefined();
          expect(variant.receipt?.materialRow.byteLength).toBe(derive(schema).totalBytes);
          expect(sceneEntry).toBe(false);
        }
        expect(variant.receipt?.skinPaletteAddress).toEqual(
          skinned ? { group: 2, binding: 1, stride: 64 } : undefined,
        );
        expect(variant.receipt?.vertexInputs.some((input) => input.semantic === 'skinIndex')).toBe(
          skinned,
        );
        expect(variant.receipt?.vertexInputs.some((input) => input.semantic === 'skinWeight')).toBe(
          skinned,
        );
        expect(variant.receipt?.vertexInputs.some((input) => input.semantic === 'color')).toBe(
          variant.defines.VERTEX_COLOR_AVAILABLE,
        );
      }
    },
    60_000,
  );
});
