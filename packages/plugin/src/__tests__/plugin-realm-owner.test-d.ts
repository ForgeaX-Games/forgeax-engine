import type { ToolRealm } from '@forgeax/engine-tool-runtime';
import { expectTypeOf, it } from 'vitest';
import type { PluginRealm } from '../loader.js';

const expectedPluginRealms = ['build', 'host', 'engine'] as const;
type ExpectedPluginRealm = (typeof expectedPluginRealms)[number];

it('derives PluginRealm from the public ToolRealm vocabulary', () => {
  expectTypeOf<PluginRealm>().toEqualTypeOf<ToolRealm>();
  expectTypeOf<ToolRealm>().toEqualTypeOf<PluginRealm>();
  expectTypeOf<PluginRealm>().toEqualTypeOf<ExpectedPluginRealm>();
  expectTypeOf<ExpectedPluginRealm>().toEqualTypeOf<PluginRealm>();

  const acceptPluginRealm = (realm: PluginRealm): PluginRealm => realm;
  for (const realm of expectedPluginRealms) acceptPluginRealm(realm);

  // @ts-expect-error unknown physical realms remain outside the closed vocabulary.
  acceptPluginRealm('worker');
});
