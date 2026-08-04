import { defineComponent, getRegisteredComponents } from '@forgeax/engine-ecs';
import { Visibility } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { projectComponentIntrospection } from '../internal/component-introspection';

const Probe = defineComponent(
  'ComponentIntrospectionProbe',
  {
    mode: {
      type: 'enum',
      default: 0,
      labels: { first: 0, second: 1 },
    },
    name: {
      type: 'string',
      meta: { purpose: 'reflection-test' },
    },
  },
  { meta: { owner: 'app-test' } },
);

describe('component introspection projection', () => {
  it('derives Visibility schema, labels, and metadata from the registered token', () => {
    const descriptors = projectComponentIntrospection(getRegisteredComponents());
    const descriptor = descriptors.find((entry) => entry.name === Visibility.name);

    expect(descriptor).toBeDefined();
    expect(descriptor?.schema).toEqual(Visibility.schema);
    expect(descriptor?.fields.state?.labels).toEqual(Visibility.fields.state?.labels);
    expect(descriptor?.fields.state?.type).toBe('enum');
  });

  it('projects field and component metadata without leaking component tokens', () => {
    const descriptors = projectComponentIntrospection(getRegisteredComponents());
    const descriptor = descriptors.find((entry) => entry.name === Probe.name);

    expect(descriptor).toMatchObject({
      name: Probe.name,
      schema: Probe.schema,
      fields: {
        mode: { type: 'enum', labels: Probe.fields.mode?.labels },
        name: { type: 'string' },
      },
      meta: Probe.meta,
    });
    expect(descriptor).not.toHaveProperty('id');
    expect(descriptor).not.toHaveProperty('validate');
    expect(descriptor).not.toHaveProperty('toSchemaJSON');
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
  });
});
