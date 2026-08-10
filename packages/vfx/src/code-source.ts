import { err, ok, type Result } from '@forgeax/engine-types';

/** Engine-owned seed module used by newly-authored particle effects. */
export const PARTICLE_CODE_DEFAULT_MODULE_ID = 'forgeax_vfx::default' as const;

export type ParticleBoundsSource =
  | {
      readonly kind: 'aabb';
      readonly min: readonly [number, number, number];
      readonly max: readonly [number, number, number];
    }
  | {
      readonly kind: 'sphere';
      readonly center: readonly [number, number, number];
      readonly radius: number;
    };

export type ParticleRendererOverflowPolicy = 'drop-newest' | 'drop-oldest';
export type ParticleRendererSorting = 'none' | 'emitter' | 'back-to-front';

export interface ParticleTextureSheetSource {
  readonly columns: number;
  readonly rows: number;
  readonly frameRate: number;
  readonly frameCount?: number;
}

export interface ParticleSoftParticleSource {
  readonly fadeDistance: number;
}

export type ParticleRendererSource =
  | {
      readonly kind: 'billboard';
      readonly material: string;
      readonly blend?: 'additive' | 'alpha' | 'opaque-cutout';
      readonly enabled?: boolean;
      readonly capacity?: number;
      readonly overflow?: ParticleRendererOverflowPolicy;
      readonly textureSheet?: ParticleTextureSheetSource;
      readonly pivot?: readonly [number, number];
      readonly softParticle?: ParticleSoftParticleSource;
      readonly sorting?: ParticleRendererSorting;
    }
  | {
      readonly kind: 'mesh';
      readonly material: string;
      readonly mesh: string;
      readonly submesh?: number;
      readonly enabled?: boolean;
    }
  | {
      readonly kind: 'ribbon';
      readonly material: string;
      readonly stripKey: 'alive-index';
      readonly capacity: number;
      readonly overflow?: ParticleRendererOverflowPolicy;
      readonly enabled?: boolean;
      readonly width?: number;
    }
  | {
      readonly kind: 'trail';
      readonly material: string;
      readonly historyLength: number;
      readonly capacity: number;
      readonly overflow?: ParticleRendererOverflowPolicy;
      readonly enabled?: boolean;
      readonly width?: number;
    }
  | {
      readonly kind: 'beam';
      readonly material: string;
      readonly endpointField: 'velocity';
      readonly capacity: number;
      readonly overflow?: ParticleRendererOverflowPolicy;
      readonly enabled?: boolean;
      readonly width?: number;
    };

export type ParticleChannelOverflowPolicy = 'drop-newest' | 'drop-oldest';

export type ParticleStageDomain = 'particle';
export type ParticleStageResourceAccess = 'read' | 'write' | 'read-write';

export interface ParticleStageResourceSource {
  readonly name: string;
  readonly access: ParticleStageResourceAccess;
}

export interface ParticleStageSource {
  readonly id: string;
  readonly entry: string;
  readonly domain: ParticleStageDomain;
  readonly resources: readonly ParticleStageResourceSource[];
  readonly dependsOn: readonly string[];
  readonly iterationBudget: number;
}

export const PARTICLE_STAGE_RESOURCE_NAMES = Object.freeze([
  'particles',
  'runtime',
  'aliveIndices',
  'counters',
  'indirect',
  'scratch',
  'billboardInstances',
  'channelInputs',
  'events',
  'eventCounters',
] as const);

export interface ParticleChannelSource {
  readonly id: string;
  readonly payload?: 'impact';
  readonly capacity: number;
  readonly overflow: ParticleChannelOverflowPolicy;
}

export interface ParticleEventSource {
  readonly id: string;
  readonly channel: string;
  readonly subEmitter: string;
  readonly fanOut: number;
  readonly recursionDepth: number;
}

export interface ParticleEmitterSourceV2 {
  readonly id: string;
  readonly capacity: number;
  readonly backend: { readonly required: 'gpu' };
  readonly space: 'local' | 'world';
  readonly bounds: ParticleBoundsSource;
  readonly schedule: {
    readonly rate: number;
    readonly bursts?: readonly { readonly time: number; readonly count: number }[];
    readonly loopDuration?: number;
  };
  readonly program: { readonly module: string };
  readonly renderers: readonly ParticleRendererSource[];
  readonly channels?: readonly ParticleChannelSource[];
  readonly events?: readonly ParticleEventSource[];
  readonly simulationWhenCulled?: 'continue' | 'pause' | 'restart-on-visible';
}

export interface ParticleEffectRootSourceV2 {
  readonly schemaVersion: 2;
  readonly emitters: readonly ParticleEmitterSourceV2[];
}

export type ParticleEffectSourceV2 = ParticleEffectRootSourceV2;

export interface ParticleCodeSourceInvalidDetail {
  readonly path: string;
  readonly emitterId?: string;
  readonly stageId?: string;
  readonly resource?: string;
}

export interface ParticleCodeSourceError {
  readonly code:
    | 'vfx-source-invalid'
    | 'vfx-source-version-unsupported'
    | 'vfx-source-channel-invalid'
    | 'vfx-source-event-invalid'
    | 'vfx-source-stage-invalid'
    | 'vfx-source-renderer-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: ParticleCodeSourceInvalidDetail;
}

function invalid(
  path: string,
  expected: string,
  emitterId?: string,
  code: ParticleCodeSourceError['code'] = 'vfx-source-invalid',
): Result<never, ParticleCodeSourceError> {
  return err({
    code,
    expected,
    hint: `repair ${path} and recook the particle effect`,
    detail: emitterId === undefined ? { path } : { path, emitterId },
  });
}

function eventInvalid(
  code: 'vfx-source-channel-invalid' | 'vfx-source-event-invalid',
  path: string,
  expected: string,
  emitterId?: string,
): Result<never, ParticleCodeSourceError> {
  return invalid(path, expected, emitterId, code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value >= 0;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function vector(value: unknown, size: number): value is readonly number[] {
  return Array.isArray(value) && value.length === size && value.every(finite);
}

function allowed(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const set = new Set(keys);
  return Object.keys(value).find((key) => !set.has(key));
}

function stageInvalid(
  path: string,
  expected: string,
  stageId?: string,
  resource?: string,
): Result<never, ParticleCodeSourceError> {
  return err({
    code: 'vfx-source-stage-invalid',
    expected,
    hint: `repair stage ${path} and recook the stage declaration`,
    detail: {
      path,
      ...(stageId === undefined ? {} : { stageId }),
      ...(resource === undefined ? {} : { resource }),
    },
  });
}

const STAGE_FIELDS = ['entry', 'domain', 'resources', 'dependsOn', 'iterationBudget'] as const;
const STAGE_RESOURCE_NAMES = new Set<string>(PARTICLE_STAGE_RESOURCE_NAMES);

function parseStageResources(
  value: string,
  path: string,
  stageId: string,
): Result<readonly ParticleStageResourceSource[], ParticleCodeSourceError> {
  if (value.length === 0)
    return stageInvalid(path, 'at least one explicit stage resource', stageId);
  const resources: ParticleStageResourceSource[] = [];
  const names = new Set<string>();
  for (const item of value.split(',')) {
    const [name, access, extra] = item.split(':');
    if (
      name === undefined ||
      access === undefined ||
      extra !== undefined ||
      !STAGE_RESOURCE_NAMES.has(name) ||
      (access !== 'read' && access !== 'write' && access !== 'read-write') ||
      names.has(name)
    ) {
      return stageInvalid(
        path,
        'known resources with unique read, write, or read-write access',
        stageId,
        name,
      );
    }
    names.add(name);
    resources.push({ name, access });
  }
  return ok(Object.freeze(resources));
}

/** Parse compiler-owned stage metadata from authored WGSL comments. */
export function parseVfxStageDeclarations(
  source: string,
): Result<readonly ParticleStageSource[], ParticleCodeSourceError> {
  const stages: ParticleStageSource[] = [];
  const ids = new Set<string>();
  const pattern = /^\s*\/\/\s*#vfx\s+stage\s+([^\s]+)\s+(.+)$/gm;
  for (const match of source.matchAll(pattern)) {
    const id = match[1];
    const fieldsText = match[2];
    if (id === undefined || fieldsText === undefined || !/^[A-Za-z_]\w*$/.test(id) || ids.has(id)) {
      return stageInvalid(
        `stage.${id ?? 'unknown'}`,
        'a unique stage id and supported stage declaration',
        id,
      );
    }
    const fields: Record<string, string> = {};
    for (const token of fieldsText.trim().split(/\s+/)) {
      const separator = token.indexOf('=');
      const key = separator < 0 ? undefined : token.slice(0, separator);
      const value = separator < 0 ? undefined : token.slice(separator + 1);
      if (
        key === undefined ||
        value === undefined ||
        !STAGE_FIELDS.includes(key as (typeof STAGE_FIELDS)[number]) ||
        fields[key] !== undefined
      ) {
        return stageInvalid(
          `stage.${id}`,
          'a supported stage declaration with entry, domain, resources, dependsOn, and iterationBudget fields',
          id,
        );
      }
      fields[key] = value;
    }
    const entry = fields.entry;
    const domain = fields.domain;
    const resourcesValue = fields.resources;
    const dependsOnValue = fields.dependsOn;
    const budgetValue = fields.iterationBudget;
    if (
      entry === undefined ||
      !/^[A-Za-z_]\w*$/.test(entry) ||
      entry.startsWith('forgeax_vfx_') ||
      domain !== 'particle' ||
      resourcesValue === undefined ||
      dependsOnValue === undefined ||
      budgetValue === undefined
    ) {
      return stageInvalid(
        `stage.${id}`,
        'a particle-domain stage with an author entry and explicit fields',
        id,
      );
    }
    const resources = parseStageResources(resourcesValue, `stage.${id}.resources`, id);
    if (!resources.ok) return resources;
    const iterationBudget = Number(budgetValue);
    if (!Number.isInteger(iterationBudget) || iterationBudget < 1 || iterationBudget > 64) {
      return stageInvalid(
        `stage.${id}.iterationBudget`,
        'an integer iteration budget from 1 through 64',
        id,
      );
    }
    const dependsOn =
      dependsOnValue === 'none'
        ? []
        : dependsOnValue.split(',').filter((dependency) => dependency.length > 0);
    if (dependsOn.some((dependency) => !/^[A-Za-z_]\w*$/.test(dependency))) {
      return stageInvalid(`stage.${id}.dependsOn`, 'stage identifiers or none', id);
    }
    ids.add(id);
    stages.push({
      id,
      entry,
      domain: 'particle',
      resources: resources.value,
      dependsOn: Object.freeze(dependsOn),
      iterationBudget,
    });
  }
  return ok(Object.freeze(stages));
}

function parseEmitter(
  value: unknown,
  index: number,
  ids: Set<string>,
): Result<ParticleEmitterSourceV2, ParticleCodeSourceError> {
  const path = `emitters[${index}]`;
  if (!record(value)) return invalid(path, 'a v2 emitter object');
  const extra = allowed(value, [
    'id',
    'capacity',
    'backend',
    'space',
    'bounds',
    'schedule',
    'program',
    'renderers',
    'channels',
    'events',
    'simulationWhenCulled',
  ]);
  if (extra !== undefined) return invalid(`${path}.${extra}`, 'a v2 emitter field');
  if (!text(value.id) || ids.has(value.id)) return invalid(`${path}.id`, 'a unique non-empty id');
  const id = value.id;
  ids.add(id);
  if (!positiveInteger(value.capacity))
    return invalid(`${path}.capacity`, 'a positive integer', id);
  if (!record(value.backend) || value.backend.required !== 'gpu') {
    return invalid(`${path}.backend`, "the explicit policy { required: 'gpu' }", id);
  }
  const backendExtra = allowed(value.backend, ['required']);
  if (backendExtra !== undefined) {
    return invalid(`${path}.backend.${backendExtra}`, 'the required GPU policy', id);
  }
  if (value.space !== 'local' && value.space !== 'world') {
    return invalid(`${path}.space`, 'local or world', id);
  }
  if (!record(value.bounds)) return invalid(`${path}.bounds`, 'fixed aabb or sphere bounds', id);
  const boundsExtra = allowed(
    value.bounds,
    value.bounds.kind === 'aabb'
      ? ['kind', 'min', 'max']
      : value.bounds.kind === 'sphere'
        ? ['kind', 'center', 'radius']
        : ['kind'],
  );
  if (boundsExtra !== undefined) {
    return invalid(`${path}.bounds.${boundsExtra}`, 'a supported bounds field', id);
  }
  const boundsOk =
    (value.bounds.kind === 'aabb' && vector(value.bounds.min, 3) && vector(value.bounds.max, 3)) ||
    (value.bounds.kind === 'sphere' &&
      vector(value.bounds.center, 3) &&
      finite(value.bounds.radius) &&
      value.bounds.radius > 0);
  if (!boundsOk) return invalid(`${path}.bounds`, 'valid fixed aabb or sphere bounds', id);
  if (!record(value.schedule) || !finite(value.schedule.rate) || value.schedule.rate < 0) {
    return invalid(`${path}.schedule`, 'a non-negative spawn schedule', id);
  }
  const scheduleExtra = allowed(value.schedule, ['rate', 'bursts', 'loopDuration']);
  if (scheduleExtra !== undefined) {
    return invalid(`${path}.schedule.${scheduleExtra}`, 'a supported schedule field', id);
  }
  if (
    value.schedule.bursts !== undefined &&
    (!Array.isArray(value.schedule.bursts) ||
      value.schedule.bursts.some(
        (burst) =>
          !record(burst) || !finite(burst.time) || burst.time < 0 || !positiveInteger(burst.count),
      ))
  ) {
    return invalid(`${path}.schedule.bursts`, 'non-negative timed positive bursts', id);
  }
  if (Array.isArray(value.schedule.bursts)) {
    for (const [burstIndex, burst] of value.schedule.bursts.entries()) {
      if (!record(burst)) continue;
      const burstExtra = allowed(burst, ['time', 'count']);
      if (burstExtra !== undefined) {
        return invalid(
          `${path}.schedule.bursts[${burstIndex}].${burstExtra}`,
          'a supported burst field',
          id,
        );
      }
    }
  }
  if (
    value.schedule.loopDuration !== undefined &&
    (!finite(value.schedule.loopDuration) || value.schedule.loopDuration <= 0)
  ) {
    return invalid(`${path}.schedule.loopDuration`, 'a positive finite duration', id);
  }
  if (!record(value.program) || !text(value.program.module)) {
    return invalid(`${path}.program.module`, 'a WGSL module identity', id);
  }
  const programExtra = allowed(value.program, ['module']);
  if (programExtra !== undefined) {
    return invalid(`${path}.program.${programExtra}`, 'a supported program field', id);
  }
  if (!Array.isArray(value.renderers) || value.renderers.length === 0) {
    return invalid(`${path}.renderers`, 'at least one renderer', id);
  }
  for (const [rendererIndex, renderer] of value.renderers.entries()) {
    const rendererPath = `${path}.renderers[${rendererIndex}]`;
    if (!record(renderer) || !text(renderer.material) || !text(renderer.kind))
      return invalid(
        rendererPath,
        'a supported renderer object',
        id,
        'vfx-source-renderer-invalid',
      );
    const common = ['kind', 'material', 'enabled', 'capacity', 'overflow', 'width'] as const;
    const rendererExtra = allowed(
      renderer,
      renderer.kind === 'billboard'
        ? [...common, 'blend', 'textureSheet', 'pivot', 'softParticle', 'sorting']
        : renderer.kind === 'mesh'
          ? ['kind', 'material', 'mesh', 'submesh', 'enabled']
          : renderer.kind === 'ribbon'
            ? [...common, 'stripKey']
            : renderer.kind === 'trail'
              ? [...common, 'historyLength']
              : renderer.kind === 'beam'
                ? [...common, 'endpointField']
                : ['kind'],
    );
    if (rendererExtra !== undefined)
      return invalid(
        `${rendererPath}.${rendererExtra}`,
        'a supported renderer field',
        id,
        'vfx-source-renderer-invalid',
      );
    if (renderer.kind === 'mesh') {
      if (
        !text(renderer.mesh) ||
        (renderer.submesh !== undefined && !nonNegativeInteger(renderer.submesh))
      )
        return invalid(
          rendererPath,
          'a mesh renderer with a non-negative submesh',
          id,
          'vfx-source-renderer-invalid',
        );
      continue;
    }
    if (renderer.enabled !== undefined && typeof renderer.enabled !== 'boolean')
      return invalid(
        `${rendererPath}.enabled`,
        'a boolean enabled flag',
        id,
        'vfx-source-renderer-invalid',
      );
    if (
      renderer.capacity !== undefined &&
      (!positiveInteger(renderer.capacity) || renderer.capacity > 65536)
    )
      return invalid(
        `${rendererPath}.capacity`,
        'a positive capacity no greater than 65536',
        id,
        'vfx-source-renderer-invalid',
      );
    if (
      renderer.overflow !== undefined &&
      renderer.overflow !== 'drop-newest' &&
      renderer.overflow !== 'drop-oldest'
    )
      return invalid(
        `${rendererPath}.overflow`,
        'drop-newest or drop-oldest',
        id,
        'vfx-source-renderer-invalid',
      );
    if (renderer.width !== undefined && (!finite(renderer.width) || renderer.width <= 0))
      return invalid(
        `${rendererPath}.width`,
        'a positive finite width',
        id,
        'vfx-source-renderer-invalid',
      );
    if (renderer.kind === 'billboard') {
      if (
        renderer.blend !== undefined &&
        renderer.blend !== 'additive' &&
        renderer.blend !== 'alpha' &&
        renderer.blend !== 'opaque-cutout'
      )
        return invalid(
          `${rendererPath}.blend`,
          'additive, alpha, or opaque-cutout',
          id,
          'vfx-source-renderer-invalid',
        );
      if (
        renderer.sorting !== undefined &&
        renderer.sorting !== 'none' &&
        renderer.sorting !== 'emitter' &&
        renderer.sorting !== 'back-to-front'
      )
        return invalid(
          `${rendererPath}.sorting`,
          'none, emitter, or back-to-front',
          id,
          'vfx-source-renderer-invalid',
        );
      if (
        renderer.pivot !== undefined &&
        (!vector(renderer.pivot, 2) || renderer.pivot.some((value) => value < -1 || value > 1))
      )
        return invalid(
          `${rendererPath}.pivot`,
          'two finite values in the -1..1 range',
          id,
          'vfx-source-renderer-invalid',
        );
      if (renderer.textureSheet !== undefined && !record(renderer.textureSheet))
        return invalid(
          `${rendererPath}.textureSheet`,
          'a texture sheet object',
          id,
          'vfx-source-renderer-invalid',
        );
      if (renderer.textureSheet !== undefined && record(renderer.textureSheet)) {
        const sheet = renderer.textureSheet;
        const sheetExtra = allowed(sheet, ['columns', 'rows', 'frameRate', 'frameCount']);
        if (
          sheetExtra !== undefined ||
          !positiveInteger(sheet.columns) ||
          !positiveInteger(sheet.rows) ||
          sheet.columns > 64 ||
          sheet.rows > 64 ||
          !finite(sheet.frameRate) ||
          sheet.frameRate < 0 ||
          (sheet.frameCount !== undefined &&
            (!positiveInteger(sheet.frameCount) || sheet.frameCount > sheet.columns * sheet.rows))
        )
          return invalid(
            `${rendererPath}.textureSheet`,
            'a bounded texture sheet declaration',
            id,
            'vfx-source-renderer-invalid',
          );
      }
      if (renderer.softParticle !== undefined && !record(renderer.softParticle))
        return invalid(
          `${rendererPath}.softParticle`,
          'a soft-particle object',
          id,
          'vfx-source-renderer-invalid',
        );
      if (renderer.softParticle !== undefined && record(renderer.softParticle)) {
        const softExtra = allowed(renderer.softParticle, ['fadeDistance']);
        if (
          softExtra !== undefined ||
          !finite(renderer.softParticle.fadeDistance) ||
          renderer.softParticle.fadeDistance <= 0
        )
          return invalid(
            `${rendererPath}.softParticle`,
            'a positive scene-depth fade distance',
            id,
            'vfx-source-renderer-invalid',
          );
      }
    } else if (renderer.kind === 'ribbon') {
      if (renderer.stripKey !== 'alive-index' || !positiveInteger(renderer.capacity))
        return invalid(
          rendererPath,
          "stripKey 'alive-index' and positive capacity",
          id,
          'vfx-source-renderer-invalid',
        );
    } else if (renderer.kind === 'trail') {
      if (
        !positiveInteger(renderer.historyLength) ||
        renderer.historyLength > 256 ||
        !positiveInteger(renderer.capacity)
      )
        return invalid(
          rendererPath,
          'a bounded trail historyLength and positive capacity',
          id,
          'vfx-source-renderer-invalid',
        );
    } else if (renderer.kind === 'beam') {
      if (renderer.endpointField !== 'velocity' || !positiveInteger(renderer.capacity))
        return invalid(
          rendererPath,
          "endpointField 'velocity' and positive capacity",
          id,
          'vfx-source-renderer-invalid',
        );
    } else {
      return invalid(
        rendererPath,
        'billboard, mesh, ribbon, trail, or beam',
        id,
        'vfx-source-renderer-invalid',
      );
    }
  }
  if (value.channels !== undefined) {
    if (!Array.isArray(value.channels) || value.channels.length === 0) {
      return eventInvalid(
        'vfx-source-channel-invalid',
        `${path}.channels`,
        'a non-empty bounded channel list',
        id,
      );
    }
    const channelIds = new Set<string>();
    for (const [channelIndex, channel] of value.channels.entries()) {
      const channelPath = `${path}.channels[${channelIndex}]`;
      if (!record(channel)) {
        return eventInvalid('vfx-source-channel-invalid', channelPath, 'a channel object', id);
      }
      const channelExtra = allowed(channel, ['id', 'payload', 'capacity', 'overflow']);
      if (channelExtra !== undefined) {
        return eventInvalid(
          'vfx-source-channel-invalid',
          `${channelPath}.${channelExtra}`,
          'a supported channel field',
          id,
        );
      }
      if (!text(channel.id) || channelIds.has(channel.id)) {
        return eventInvalid(
          'vfx-source-channel-invalid',
          `${channelPath}.id`,
          'a unique non-empty channel id',
          id,
        );
      }
      if (
        !positiveInteger(channel.capacity) ||
        channel.capacity > 65536 ||
        (channel.payload !== undefined && channel.payload !== 'impact') ||
        (channel.overflow !== 'drop-newest' && channel.overflow !== 'drop-oldest')
      ) {
        return eventInvalid(
          'vfx-source-channel-invalid',
          channelPath,
          'an impact channel with capacity 1..65536 and explicit overflow policy',
          id,
        );
      }
      channelIds.add(channel.id);
    }
  }
  if (value.events !== undefined) {
    if (!Array.isArray(value.events)) {
      return eventInvalid('vfx-source-event-invalid', `${path}.events`, 'an event list', id);
    }
    const eventIds = new Set<string>();
    for (const [eventIndex, event] of value.events.entries()) {
      const eventPath = `${path}.events[${eventIndex}]`;
      if (!record(event)) {
        return eventInvalid('vfx-source-event-invalid', eventPath, 'an event object', id);
      }
      const eventExtra = allowed(event, [
        'id',
        'channel',
        'subEmitter',
        'fanOut',
        'recursionDepth',
      ]);
      if (eventExtra !== undefined) {
        return eventInvalid(
          'vfx-source-event-invalid',
          `${eventPath}.${eventExtra}`,
          'a supported event field',
          id,
        );
      }
      if (!text(event.id) || eventIds.has(event.id)) {
        return eventInvalid('vfx-source-event-invalid', `${eventPath}.id`, 'a unique event id', id);
      }
      if (
        !text(event.channel) ||
        !text(event.subEmitter) ||
        !positiveInteger(event.fanOut) ||
        event.fanOut > 16 ||
        !positiveInteger(event.recursionDepth) ||
        event.recursionDepth > 8
      ) {
        return eventInvalid(
          'vfx-source-event-invalid',
          eventPath,
          'an event with bounded fanOut 1..16 and recursionDepth 1..8',
          id,
        );
      }
      eventIds.add(event.id);
    }
  }
  if (
    value.simulationWhenCulled !== undefined &&
    value.simulationWhenCulled !== 'continue' &&
    value.simulationWhenCulled !== 'pause' &&
    value.simulationWhenCulled !== 'restart-on-visible'
  ) {
    return invalid(`${path}.simulationWhenCulled`, 'continue, pause, or restart-on-visible', id);
  }
  return ok(value as unknown as ParticleEmitterSourceV2);
}

export function parseParticleEffectSourceV2(
  value: unknown,
): Result<ParticleEffectSourceV2, ParticleCodeSourceError> {
  if (!record(value)) return invalid('$', 'a particle effect source object');
  if (value.schemaVersion !== 2) {
    return err({
      code: 'vfx-source-version-unsupported',
      expected: 'ParticleEffectSource schemaVersion 2',
      hint: 'migrate code behavior to WGSL and recook; v1 is not interpreted at runtime',
      detail: { path: 'schemaVersion' },
    });
  }
  const extra = allowed(value, ['schemaVersion', 'emitters']);
  if (extra !== undefined) return invalid(extra, 'a root field: emitters');
  if (!Array.isArray(value.emitters) || value.emitters.length === 0) {
    return invalid('emitters', 'at least one v2 emitter');
  }
  const ids = new Set<string>();
  const emitters: ParticleEmitterSourceV2[] = [];
  for (const [index, emitter] of value.emitters.entries()) {
    const parsed = parseEmitter(emitter, index, ids);
    if (!parsed.ok) return parsed;
    emitters.push(parsed.value);
  }
  const emitterIds = new Set(emitters.map((emitter) => emitter.id));
  for (const emitter of emitters) {
    const channels = new Set((emitter.channels ?? []).map((channel) => channel.id));
    for (const event of emitter.events ?? []) {
      if (!channels.has(event.channel)) {
        return eventInvalid(
          'vfx-source-event-invalid',
          `emitters[${emitters.indexOf(emitter)}].events.${event.id}.channel`,
          'the id of a channel declared on the same emitter',
          emitter.id,
        );
      }
      if (!emitterIds.has(event.subEmitter)) {
        return eventInvalid(
          'vfx-source-event-invalid',
          `emitters[${emitters.indexOf(emitter)}].events.${event.id}.subEmitter`,
          'the id of an emitter in the same cooked effect',
          emitter.id,
        );
      }
    }
  }
  return ok(
    Object.freeze({
      schemaVersion: 2,
      emitters: Object.freeze(emitters),
    }),
  );
}

export function defineParticleEffectSourceV2<T extends ParticleEffectSourceV2>(source: T): T {
  const parsed = parseParticleEffectSourceV2(source);
  if (!parsed.ok) throw new TypeError(`${parsed.error.code}: ${parsed.error.expected}`);
  return source;
}
