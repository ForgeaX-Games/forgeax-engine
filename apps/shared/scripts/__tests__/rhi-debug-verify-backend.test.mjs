import { describe, expect, it } from 'vitest';
import {
  classifyBrowserWebGpuAlignment,
  resolveBrowserWebGpuLaunch,
  resolveDawnReplaySelection,
} from '../rhi-debug-verify.mjs';

describe('RHI-debug browser backend selection', () => {
  it('aligns the macOS default with the explicit Dawn Metal replay', () => {
    const launch = resolveBrowserWebGpuLaunch({ platform: 'darwin', backend: 'auto' });

    expect(launch.selectedBackend).toBe('metal');
    expect(launch.comparisonMode).toBe('browser-metal-vs-dawn-metal');
    expect(launch.args).toContain('--use-angle=metal');
    expect(launch.args).not.toContain('--use-vulkan=swiftshader');
  });

  it('keeps SwiftShader Vulkan available as an explicit negative control', () => {
    const launch = resolveBrowserWebGpuLaunch({
      platform: 'darwin',
      backend: 'swiftshader-vulkan',
    });

    expect(launch.selectedBackend).toBe('swiftshader-vulkan');
    expect(launch.comparisonMode).toBe('browser-swiftshader-vulkan-vs-dawn-metal');
    expect(launch.args).toContain('--use-vulkan=swiftshader');
    expect(launch.args).not.toContain('--use-angle=metal');
  });

  it('preserves the existing SwiftShader path on non-macOS hosts', () => {
    const launch = resolveBrowserWebGpuLaunch({ platform: 'linux', backend: 'auto' });

    expect(launch.selectedBackend).toBe('swiftshader-vulkan');
    expect(launch.comparisonMode).toBe('browser-swiftshader-vulkan-vs-dawn-default');
    expect(launch.args).toContain('--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer');
    expect(launch.args).toContain('--use-angle=swiftshader');
    expect(launch.args).not.toContain('--disable-vulkan-surface');
  });

  it('rejects an unsupported explicit Metal request instead of falling back', () => {
    expect(() => resolveBrowserWebGpuLaunch({ platform: 'linux', backend: 'metal' })).toThrow(
      'refusing an implicit backend fallback',
    );
    expect(() => resolveBrowserWebGpuLaunch({ platform: 'darwin', backend: 'unknown' })).toThrow(
      'expected auto, metal, or swiftshader-vulkan',
    );
  });

  it('keeps missing and mismatched adapter identity out of the confirmed state', () => {
    expect(
      classifyBrowserWebGpuAlignment({
        selectedBackend: 'metal',
        adapterInfo: null,
        adapterInfoSource: 'unavailable',
      }),
    ).toEqual({
      status: 'unverified',
      expectedBackend: 'metal',
      observedBackend: null,
      source: 'unavailable',
    });
    expect(
      classifyBrowserWebGpuAlignment({
        selectedBackend: 'metal',
        adapterInfo: { backendType: 'Vulkan' },
        adapterInfoSource: 'GPUAdapter.info',
      }).status,
    ).toBe('mismatch');
    expect(
      classifyBrowserWebGpuAlignment({
        selectedBackend: 'metal',
        adapterInfo: { backendType: 'Metal' },
        adapterInfoSource: 'GPUAdapter.info',
      }).status,
    ).toBe('confirmed');
    expect(
      classifyBrowserWebGpuAlignment({
        selectedBackend: 'metal',
        adapterInfo: { backendType: 'metal-angle' },
        adapterInfoSource: 'GPUAdapter.info',
      }).status,
    ).toBe('mismatch');
  });

  it('pins macOS Dawn replay to Metal independently of the Browser negative control', () => {
    expect(resolveDawnReplaySelection({ platform: 'darwin', requestedBackend: 'metal' })).toEqual({
      requestedBackend: 'metal',
      selectedBackend: 'metal',
      args: ['backend=metal'],
    });
    expect(resolveDawnReplaySelection({ platform: 'darwin', requestedBackend: 'default' })).toEqual(
      {
        requestedBackend: 'default',
        selectedBackend: 'dawn-default',
        args: [],
      },
    );
    expect(
      resolveDawnReplaySelection({ platform: 'linux', requestedBackend: 'default' })
        .selectedBackend,
    ).toBe('dawn-default');
    expect(() =>
      resolveDawnReplaySelection({ platform: 'linux', requestedBackend: 'metal' }),
    ).toThrow('refusing an implicit backend fallback');
  });
});
