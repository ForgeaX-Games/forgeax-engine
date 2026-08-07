// @forgeax/engine-rhi-debug/dev-routes -- node-free dev transport identity.

/** Canonical HTTP paths shared by the browser, CLI, and Vite dev adapter. */
export const RHI_DEBUG_DEV_ROUTES = {
  tape: '/__forgeax-debug/tape',
  trigger: '/__forgeax-debug/trigger',
  artifact: '/__forgeax-debug/artifact',
} as const;
