import browserLaunch from '../../../scripts/ci/browser-launch.json' with { type: 'json' };

/** Mac correctness uses native Metal; other hosts retain the CI software route. */
export function runtimeBrowserLaunchOptions() {
  const nativeMac = process.platform === 'darwin';
  return {
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE
      ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE }
      : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunch.channel }),
    headless: false,
    args: [
      '--no-sandbox',
      '--enable-unsafe-webgpu',
      nativeMac
        ? '--enable-features=UseSkiaRenderer,SharedArrayBuffer'
        : '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      ...(nativeMac
        ? []
        : [
            '--use-angle=swiftshader',
            '--use-vulkan=swiftshader',
            '--enable-unsafe-swiftshader',
            '--disable-vulkan-surface',
          ]),
      '--ignore-gpu-blocklist',
    ],
  };
}
