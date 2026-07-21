// @forgeax/engine-ecs — externalization module public barrel.
//
// Pure ECS kernel: projection, portable validation, and entity remap.
// No network, peer, wire, profile, or codec policy.

export {
  isComponentFullyTransient,
  isComponentPortable,
  isFieldPortable,
  type ProfileComponentError,
  projectComponentData,
  validateProfileComponents,
} from './projection';

export {
  classifyEntityField,
  createEntityRemap,
  type EntityFieldKind,
  remapEntityFieldValue,
} from './remap';
