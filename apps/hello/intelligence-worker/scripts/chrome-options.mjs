export function chromeLaunchOptions() {
  return {
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
  };
}
