import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type TemplateDescriptor,
  type TemplateDescriptorError,
  validateTemplateDescriptor,
} from './descriptor.js';

export { type TemplateDescriptor, validateTemplateDescriptor } from './descriptor.js';

export interface TemplateCatalogInput {
  readonly root: string;
  readonly descriptors?: readonly TemplateDescriptor[];
  readonly directories?: readonly string[];
}

export interface TemplateCatalog {
  readonly descriptors: readonly TemplateDescriptor[];
}

function catalogError(reason: string): Error & { readonly code: string; readonly detail: object } {
  const error = new Error(`template catalog invalid: ${reason}`) as Error & {
    code: string;
    detail: object;
  };
  error.code = 'template-catalog-invalid';
  error.detail = { reason };
  return error;
}

export async function discoverTemplateCatalog(
  input: TemplateCatalogInput,
): Promise<TemplateCatalog> {
  const descriptors = input.descriptors ?? (await readDescriptors(input.root));
  const ids = new Set<string>();
  for (const descriptor of descriptors) {
    if (ids.has(descriptor.id)) throw catalogError(`duplicate template id ${descriptor.id}`);
    ids.add(descriptor.id);
  }
  const directories = input.directories ?? (await templateDirectories(input.root));
  const descriptorDirectories = new Set(descriptors.map((descriptor) => descriptor.id));
  for (const directory of directories) {
    if (!descriptorDirectories.has(directory))
      throw catalogError(`orphan template directory ${directory}`);
  }
  for (const descriptor of descriptors) {
    if (!directories.includes(descriptor.id))
      throw catalogError(`missing template directory ${descriptor.id}`);
  }
  return { descriptors };
}

async function readDescriptors(root: string): Promise<TemplateDescriptor[]> {
  const directories = await templateDirectories(root);
  const descriptors: TemplateDescriptor[] = [];
  for (const directory of directories) {
    const parsed: unknown = JSON.parse(
      await readFile(join(root, directory, 'template.json'), 'utf8'),
    );
    const validated = validateTemplateDescriptor(parsed);
    if (!validated.ok) throw catalogError(formatDescriptorError(validated.error));
    if (validated.value.id !== directory)
      throw catalogError(`template id ${validated.value.id} does not match directory ${directory}`);
    descriptors.push(validated.value);
  }
  return descriptors;
}

async function templateDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function formatDescriptorError(error: TemplateDescriptorError): string {
  return `${error.code}: ${error.expected}`;
}
