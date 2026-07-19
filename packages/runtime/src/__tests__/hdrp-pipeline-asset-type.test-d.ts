// hdrp-pipeline-asset-type - feat-20260608-cluster-lighting
// M2 / w6 (TDD red): RenderPipelineAsset literal union narrowing typecheck.
//
// AC anchor: requirements AC-04 (RenderPipelineAsset TS type supports
// hdrp pipelineId + config.clusterGrid; compile-time narrowing on
// pipelineId === 'forgeax::hdrp' narrows config.clusterGrid type).
//
// Constraints from upstream:
//   D-naming-1: pipelineId literal union 'forgeax::urp' | 'forgeax::hdrp'

import type { RenderPipelineAsset } from '@forgeax/engine-types';
import { expectTypeOf, test } from 'vitest';

// AC-04: RenderPipelineAsset.pipelineId is a literal union that includes
// 'forgeax::urp' and 'forgeax::hdrp'. String-literal narrowing must work
// so that checking pipelineId === 'forgeax::hdrp' narrows config.
function consumePipelineId(id: RenderPipelineAsset['pipelineId']): string {
  if (id === 'forgeax::urp') return 'urp';
  if (id === 'forgeax::hdrp') return 'hdrp';
  return id;
}

test('pipelineId literal union narrows forgeax::urp and forgeax::hdrp', () => {
  expectTypeOf<'forgeax::urp'>().toMatchTypeOf<RenderPipelineAsset['pipelineId']>();
  expectTypeOf<'forgeax::hdrp'>().toMatchTypeOf<RenderPipelineAsset['pipelineId']>();
  void consumePipelineId;
});

// AC-04 narrowing: when pipelineId === 'forgeax::hdrp', config.clusterGrid
// type is narrowed to { x: number; y: number; z: number } | undefined
function useHdrpConfig(a: RenderPipelineAsset): { x: number; y: number; z: number } | undefined {
  if (a.pipelineId === 'forgeax::hdrp') {
    return a.config?.clusterGrid;
  }
  return undefined;
}

test('hdrp pipelineId narrows config.clusterGrid', () => {
  expectTypeOf<'forgeax::hdrp'>().toMatchTypeOf<RenderPipelineAsset['pipelineId']>();
  void useHdrpConfig;
});

// AC-04: URP pipelineId does NOT require clusterGrid
function useUrpConfig(a: RenderPipelineAsset): { readonly passCount?: number } | undefined {
  if (a.pipelineId === 'forgeax::urp') {
    return a.config;
  }
  return undefined;
}

test('urp pipelineId accepts config without clusterGrid', () => {
  expectTypeOf<'forgeax::urp'>().toMatchTypeOf<RenderPipelineAsset['pipelineId']>();
  void useUrpConfig;
});

// ── feat-20260612-hdrp-ssao M4 / w18: config.ssao type narrowing ──────────
//
// AC-01: config.ssao field is visible under pipelineId: 'forgeax::hdrp' narrowing.
// The type is { enabled: boolean; radius?: number; bias?: number; intensity?: number } | undefined.

function useSsaDisabled(a: RenderPipelineAsset): false | undefined {
  if (a.pipelineId === 'forgeax::hdrp') {
    const ssao = a.config?.ssao;
    if (ssao === undefined) return undefined;
    const enabled: boolean = ssao.enabled;
    if (enabled === false) return false;
    return undefined;
  }
  return undefined;
}

test('hdrp pipelineId narrows config.ssao (disabled path)', () => {
  expectTypeOf(useSsaDisabled).returns.toEqualTypeOf<false | undefined>();
  void useSsaDisabled;
});

// AC-01 core: literal object `config: { ssao: { enabled: true } }` compiles
// without `as` assertion under hdrp pipelineId.
function useSsaEnabledLiteral(): RenderPipelineAsset {
  return {
    kind: 'render-pipeline',
    pipelineId: 'forgeax::hdrp',
    config: {
      ssao: {
        enabled: true,
        radius: 0.5,
        bias: 0.025,
        intensity: 1.0,
      },
    },
  };
}

test('hdrp pipelineId literal config.ssao with all params compiles without as', () => {
  const asset = useSsaEnabledLiteral();
  expectTypeOf(asset.config?.ssao).toEqualTypeOf<
    | {
        readonly enabled: boolean;
        readonly radius?: number | undefined;
        readonly bias?: number | undefined;
        readonly intensity?: number | undefined;
      }
    | undefined
  >();
  void asset;
});

// AC-01: config.ssao radius/bias/intensity are optional
function useSsaMinimalLiteral(): RenderPipelineAsset {
  return {
    kind: 'render-pipeline',
    pipelineId: 'forgeax::hdrp',
    config: {
      ssao: { enabled: true },
    },
  };
}

test('hdrp pipelineId literal config.ssao minimal (enabled only) compiles without as', () => {
  const asset = useSsaMinimalLiteral();
  expectTypeOf(asset.config?.ssao?.enabled).toEqualTypeOf<boolean | undefined>();
  void asset;
});

// AC-01: config.ssao is in shared config (same pattern as clusterGrid).
// URP ignores it; HDRP consumes it. The field is visible on RenderPipelineAsset
// config regardless of pipelineId.
function useUrpSsaConfig(a: RenderPipelineAsset): undefined {
  if (a.pipelineId === 'forgeax::urp') {
    // ssao in shared config — URP ignores it, but the field exists
    const _ssao = a.config?.ssao;
    void _ssao;
  }
  return undefined;
}

test('urp pipelineId config.ssao is visible in shared config (URP ignores at runtime)', () => {
  void useUrpSsaConfig;
});
