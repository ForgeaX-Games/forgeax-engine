import { REMOTE_ERROR_CODE_TO_JSONRPC, type RemoteErrorCode } from './errors';

export interface RemoteRootValues {
  readonly world: unknown;
  readonly renderer: unknown;
  readonly assets: unknown;
  readonly debugAdapter?: unknown;
  readonly profiler?: unknown;
}

type RootProjection = {
  readonly available: true;
  readonly type: string;
  readonly description: string;
  readonly capability?: string;
  readonly phaseCatalog?: unknown;
  readonly operations?: {
    readonly startCapture: string;
    readonly latestCapture: string;
  };
};

export function isProfilerRoot(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const root = value as {
    startCapture?: unknown;
    latestCapture?: unknown;
    activeSession?: unknown;
    phaseCatalog?: unknown;
  };
  return (
    typeof root.startCapture === 'function' &&
    typeof root.latestCapture === 'function' &&
    typeof root.activeSession === 'function' &&
    root.phaseCatalog !== undefined
  );
}

function profilerPhaseCatalog(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const catalog = (value as { phaseCatalog?: unknown }).phaseCatalog;
  return catalog === undefined ? undefined : catalog;
}

function projectRoot(name: string, value: unknown): RootProjection {
  const descriptions: Record<string, { type: string; description: string }> = {
    world: { type: 'World', description: 'The host World instance.' },
    renderer: { type: 'Renderer', description: 'The host Renderer instance.' },
    assets: { type: 'AssetRegistry', description: 'The host AssetRegistry instance.' },
    debugAdapter: {
      type: 'DebugRhiAdapter',
      description: 'The opt-in RHI debug adapter for frame and draw inspection.',
    },
    profiler: {
      type: 'Profiler',
      description: 'The opt-in CPU profiler for bounded App and Render capture.',
    },
  };
  const descriptor = descriptions[name] ?? { type: 'unknown', description: 'A live eval root.' };
  return {
    available: true,
    ...descriptor,
    ...(name === 'profiler'
      ? {
          capability: 'cpu-profile-v1',
          operations: {
            startCapture: 'profiler.startCapture({ frameLimit, eventLimit })',
            latestCapture: 'profiler.latestCapture() after the host reaches the frame boundary',
          },
          ...(profilerPhaseCatalog(value) === undefined
            ? {}
            : { phaseCatalog: profilerPhaseCatalog(value) }),
        }
      : {}),
  };
}

function projectRoots(roots: RemoteRootValues): Record<string, RootProjection> {
  const projected: Record<string, RootProjection> = {};
  for (const [name, value] of Object.entries(roots)) {
    if (value !== undefined && (name !== 'profiler' || isProfilerRoot(value))) {
      projected[name] = projectRoot(name, value);
    }
  }
  return projected;
}

function profilerCapability(roots: Record<string, RootProjection>): Record<string, unknown> {
  if (roots.profiler !== undefined) {
    return {
      enabled: true,
      capability: 'cpu-profile-v1',
      limits: {
        frameLimit: 'positive-safe-integer',
        eventLimit: 'positive-safe-integer',
      },
    };
  }
  return {
    enabled: false,
    code: 'profiler-not-enabled',
    expected: 'an explicitly opted-in profiler root',
    hint: 'Pass profiler: createProfiler() to createApp or startServer in development, then retry.',
    detail: { enabled: false },
    limits: {
      frameLimit: 'positive-safe-integer',
      eventLimit: 'positive-safe-integer',
    },
  };
}

function buildErrorProjection(): Record<string, { code: number; message: string }> {
  const messages: Record<RemoteErrorCode, string> = {
    'script-syntax-error': 'Script syntax error',
    'script-runtime-error': 'Script runtime error',
    'server-startup-failed': 'Server startup failed',
    'server-not-running': 'Server not reachable',
  };
  const errors: Record<string, { code: number; message: string }> = {};
  for (const [code, numericCode] of Object.entries(REMOTE_ERROR_CODE_TO_JSONRPC) as Array<
    [RemoteErrorCode, number]
  >) {
    errors[code] = { code: numericCode, message: messages[code] };
  }
  return errors;
}

export function buildIntrospectDoc(host: string, port: number, roots: RemoteRootValues): unknown {
  const projectedRoots = projectRoots(roots);
  const schemas: Record<string, unknown> = {
    World: { type: 'object', description: 'The host World instance.' },
    Renderer: { type: 'object', description: 'The host Renderer instance.' },
    Assets: { type: 'object', description: 'The host AssetRegistry instance.' },
  };
  for (const [name, root] of Object.entries(projectedRoots)) {
    schemas[root.type] = { type: 'object', description: root.description };
    if (name === 'profiler') {
      schemas.ProfilerCapture = {
        type: 'object',
        description: 'A bounded ProfileCapture v1 artifact returned through eval.',
      };
    }
  }
  return {
    openrpc: '1.3.2',
    info: {
      title: '@forgeax/engine-remote remote eval',
      version: '0.0.0',
      description:
        'Remote eval server. Methods: eval / introspect. Errors map to JSON-RPC -32001..-32006.',
    },
    servers: [{ name: 'in-process', url: `ws://${host}:${port}/inspector` }],
    methods: [
      {
        name: 'eval',
        summary: 'Evaluate a JavaScript script against live eval roots.',
        params: [
          {
            name: 'script',
            required: true,
            schema: { type: 'string' },
          },
        ],
        result: { name: 'value', schema: { type: 'object' } },
      },
      {
        name: 'introspect',
        summary: 'Return this OpenRPC L2 subset document.',
        params: [],
        result: { name: 'document', schema: { type: 'object' } },
      },
    ],
    roots: projectedRoots,
    capabilities: { profiler: profilerCapability(projectedRoots) },
    components: {
      schemas,
      errors: buildErrorProjection(),
    },
  };
}
