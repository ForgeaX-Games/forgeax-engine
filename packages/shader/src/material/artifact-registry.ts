import { err, ok, type Result } from '@forgeax/engine-types';

export interface MaterialRuntimeArtifact {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly digest?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MaterialArtifactInspection {
  readonly key: string;
  readonly digest?: string;
  readonly byteLength: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MaterialArtifactConflictError {
  readonly code: 'material-artifact-conflict';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly key: string;
    readonly dimension: 'bytes' | 'param-schema' | 'receipt';
    readonly existingDigest?: string;
    readonly incomingDigest?: string;
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  const length = left.length;
  if (length !== right.length) return false;
  // Preserve TypedArray.every's detached/out-of-bounds validation without a byte callback.
  Uint8Array.prototype.values.call(left);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function equalParamSchema(left: MaterialRuntimeArtifact, right: MaterialRuntimeArtifact): boolean {
  return JSON.stringify(left.metadata?.paramSchema) === JSON.stringify(right.metadata?.paramSchema);
}

function equalReceipt(left: MaterialRuntimeArtifact, right: MaterialRuntimeArtifact): boolean {
  return (
    JSON.stringify([left.metadata?.abi, left.metadata?.receipt]) ===
    JSON.stringify([right.metadata?.abi, right.metadata?.receipt])
  );
}

export class MaterialArtifactRegistry {
  readonly #artifacts = new Map<string, MaterialRuntimeArtifact>();

  register(
    artifact: MaterialRuntimeArtifact,
  ): Result<MaterialRuntimeArtifact, MaterialArtifactConflictError> {
    const previous = this.#artifacts.get(artifact.key);
    if (previous !== undefined) {
      if (equalBytes(previous.bytes, artifact.bytes)) {
        if (!equalParamSchema(previous, artifact)) {
          return err({
            code: 'material-artifact-conflict',
            expected: 'one immutable parameter schema per specialization key',
            hint: 're-cook the conflicting specialization with one canonical parameter schema',
            detail: {
              key: artifact.key,
              dimension: 'param-schema',
              ...(previous.digest ? { existingDigest: previous.digest } : {}),
              ...(artifact.digest ? { incomingDigest: artifact.digest } : {}),
            },
          });
        }
        if (equalReceipt(previous, artifact)) return ok(previous);
        return err({
          code: 'material-artifact-conflict',
          expected: 'one immutable ABI receipt per specialization key',
          hint: 're-cook the conflicting specialization with one canonical ABI receipt',
          detail: {
            key: artifact.key,
            dimension: 'receipt',
            ...(previous.digest ? { existingDigest: previous.digest } : {}),
            ...(artifact.digest ? { incomingDigest: artifact.digest } : {}),
          },
        });
      }
      return err({
        code: 'material-artifact-conflict',
        expected: 'one immutable artifact byte sequence per specialization key',
        hint: 're-cook the conflicting specialization and publish one artifact digest',
        detail: {
          key: artifact.key,
          dimension: 'bytes',
          ...(previous.digest ? { existingDigest: previous.digest } : {}),
          ...(artifact.digest ? { incomingDigest: artifact.digest } : {}),
        },
      });
    }
    const immutable = Object.freeze(artifact);
    this.#artifacts.set(artifact.key, immutable);
    return ok(immutable);
  }

  get(key: string): MaterialRuntimeArtifact | undefined {
    return this.#artifacts.get(key);
  }

  inspect(key: string): MaterialArtifactInspection | undefined {
    const artifact = this.#artifacts.get(key);
    if (artifact === undefined) return undefined;
    return {
      key: artifact.key,
      ...(artifact.digest === undefined ? {} : { digest: artifact.digest }),
      byteLength: artifact.bytes.byteLength,
      ...(artifact.metadata === undefined ? {} : { metadata: artifact.metadata }),
    };
  }
}
