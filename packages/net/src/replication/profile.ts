import type { Component, QueryDescriptor } from '@forgeax/engine-ecs';
import { validateProfileComponents } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
export interface ReplicationLimits {
  readonly maxMessageBytes: number;
  readonly maxEntities: number;
  readonly maxComponentOperations: number;
  readonly maxStringBytes: number;
  readonly maxBufferBytes: number;
  readonly maxArrayElements: number;
}
const DEFAULT_LIMITS: ReplicationLimits = {
  maxMessageBytes: 64 * 1024,
  maxEntities: 1024,
  maxComponentOperations: 4096,
  maxStringBytes: 4096,
  maxBufferBytes: 16 * 1024,
  maxArrayElements: 1024,
};

import { NetError } from './errors';

export interface ReplicationProfile {
  readonly name: string;
  readonly entities: QueryDescriptor;
  readonly components: readonly Component[];
  readonly limits: ReplicationLimits;
  readonly fingerprint: string;
}
export interface DefineReplicationOptions {
  readonly name: string;
  readonly entities: QueryDescriptor;
  readonly components: readonly Component[];
  readonly limits?: Partial<ReplicationLimits>;
}
function hash(text: string): string {
  let value = 2166136261;
  for (const char of text) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, '0');
}

function immutableProfile(
  options: DefineReplicationOptions,
  limits: ReplicationLimits,
  fingerprint: string,
): ReplicationProfile {
  const entities: QueryDescriptor = Object.freeze({
    with: Object.freeze([...options.entities.with]),
    ...(options.entities.without === undefined
      ? {}
      : { without: Object.freeze([...options.entities.without]) }),
    ...(options.entities.optional === undefined
      ? {}
      : { optional: Object.freeze([...options.entities.optional]) }),
  });
  return Object.freeze({
    name: options.name,
    entities,
    components: Object.freeze([...options.components]),
    limits: Object.freeze({ ...limits }),
    fingerprint,
  });
}

export function defineReplication(
  options: DefineReplicationOptions,
): Result<ReplicationProfile, NetError> {
  const portable = validateProfileComponents(options.components);
  if (!portable.valid) {
    const first = portable.errors[0];
    if (first === undefined) {
      return err(
        new NetError({
          code: 'schema-invalid',
          expected: 'portable replication components',
          hint: 'select only components accepted by the ECS externalization kernel',
          detail: { component: '', reason: 'portable validation failed without a diagnostic' },
        }),
      );
    }
    return err(
      new NetError({
        code: 'schema-invalid',
        expected: first.expected,
        hint: first.hint,
        detail: { component: first.component, reason: first.code },
      }),
    );
  }
  const limits: ReplicationLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const signature = JSON.stringify({
    name: options.name,
    query: options.entities,
    components: options.components.map((component) => ({
      name: component.name,
      schema: component.schema,
    })),
    limits,
  });
  return ok(immutableProfile(options, limits, hash(signature)));
}
