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
    readonly existingDigest?: string;
    readonly incomingDigest?: string;
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class MaterialArtifactRegistry {
  readonly #artifacts = new Map<string, MaterialRuntimeArtifact>();

  register(
    artifact: MaterialRuntimeArtifact,
  ): Result<MaterialRuntimeArtifact, MaterialArtifactConflictError> {
    const previous = this.#artifacts.get(artifact.key);
    if (previous !== undefined) {
      if (equalBytes(previous.bytes, artifact.bytes)) return ok(previous);
      return err({
        code: 'material-artifact-conflict',
        expected: 'one immutable artifact byte sequence per specialization key',
        hint: 're-cook the conflicting specialization and publish one artifact digest',
        detail: {
          key: artifact.key,
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
