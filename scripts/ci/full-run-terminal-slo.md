# Full-run terminal SLO and CI admission

## Proposition: admission fails closed

The admission projection is an evidence decision, not a claim that CI passed or that a
treatment improved anything. Missing, stale, foreign, contradictory, skipped, failed,
or nonterminal evidence is not success. `fallbackEligible` is `true` only when the
path-filter proof is explicitly bound to the same identity; every other path must
remain observable and recoverable. A comparison is non-comparable until repeated,
matched terminal evidence is available.

The projection is pure and read-only: it does not query GitHub, rerun a job, change a
timeout, infer physical capacity, or execute a rollback. Its three authorities are
linked here rather than copied:

- [Machine contract](./full-run-terminal-slo-contract.json) owns the envelope, timing
  threshold, identity/provenance fields, recovery shape, and virtual capacity pools.
- [Required-context manifest](./required-ci-checks.json) owns the exact logical roster.
- [Admission projection](./check-ci-admission.mjs) composes the roster classifier,
  packet normalizer, and terminal-SLO verifier.

This feature's immutable replan boundary is the harness authority snapshot
`7d5f525c8d91013aab82696fefefa33c97e293ef`. The older `218e60401` implementation is
archival evidence only. The snapshot values do not belong to a runtime packet or snapshot
producer, and neither is a claim about current main, a pull request, a merge, or CI
success. Later main drift is a separate fact and must not rewrite evidence collected at
the boundary.

## Read the result first

Call `projectCiAdmission(input)` with a local evidence object, or send the same JSON to
the module's stdin entry point. Read these properties directly; do not parse logs or
reconstruct a roster:

| Property | Use |
| --- | --- |
| `status` | The classifier's closed topology result (for example, path-filtered, ordinary, incomplete, or failed). It is not a pass verdict. |
| `fallbackEligible` | Whether an identity-bound path-filter proof permits the fallback path. A complete roster alone does not make this `true`. |
| `identity` | The projected run identity: `runId`, positive `runAttempt`, full `headSha`, and explicit `treatmentId`. |
| `roster` | Authority path plus expected/observed, missing, duplicate, extra, malformed, skipped, and failed context projections. |
| `evidence` | Source run/jobs/proof, terminality, packet projection, and optional matched comparison. |
| `recoveryAction` | The primary recovery envelope: the first action in dependency order, or `null` when no action exists. |
| `recoveryActions` | Every observed recovery envelope, deduplicated and ordered by `source`, `terminal`, `delivery`, then `comparison`. |

There are three conclusions, and they must not be collapsed: `status` is the topology
conclusion, packet `classification` is the terminal evidence conclusion, and comparison
`verdict` is the matched-pair conclusion. A normal run can have a healthy topology while
still lacking an admissible terminal packet; a `slo-pass` comparison is only emitted by
the matched-pair verifier.

For a no-run path-filter proof, the smallest valid input is:

```json
{
  "identity": { "headSha": "0123456789abcdef0123456789abcdef01234567" },
  "run": null,
  "jobs": null,
  "pathFiltered": true,
  "pathFilterProof": {
    "workflow": "ci.yml",
    "excluded": true,
    "headSha": "0123456789abcdef0123456789abcdef01234567"
  }
}
```

This form must not invent a run identity: the proof is eligible only when its full
`headSha` matches `identity.headSha`. Inputs with a run or packet still require the full
identity tuple: `runId`, positive `runAttempt`, full `headSha`, and `treatmentId`.

The same no-run fixture can be exercised through the stdin entry point:

```sh
printf '%s\n' '{"identity":{"headSha":"0123456789abcdef0123456789abcdef01234567"},"run":null,"jobs":null,"pathFiltered":true,"pathFilterProof":{"workflow":"ci.yml","excluded":true,"headSha":"0123456789abcdef0123456789abcdef01234567"}}' \
  | node scripts/ci/check-ci-admission.mjs \
  | jq '{status,fallbackEligible,recoveryAction,recoveryActions}'
```

The expected result is `status: path-filtered`, `fallbackEligible: true`, and an empty
recovery action list. The command is evidence-only: it does not query GitHub or rerun CI.

### Minimal raw packet fixture

The normalizer consumes a raw run packet with the run identity, jobs, and artifact
identity joined explicitly:

```json
{
  "schemaVersion": 1,
  "run": {
    "runId": 4101,
    "runAttempt": 2,
    "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "treatmentId": "baseline",
    "status": "completed",
    "conclusion": "success"
  },
  "jobs": [],
  "artifacts": [
    {
      "id": "artifact-core",
      "runId": 4101,
      "runAttempt": 2,
      "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "treatmentId": "baseline",
      "inputFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

This is a normalization shape fixture, not an admitted packet: the empty `jobs` array
intentionally leaves roster evidence incomplete. A terminal packet must additionally
carry the authoritative classifications, producer provenance, terminal clocks, and
job observations before `admitPacket` can classify it.

The topology conclusion has exactly eight statuses:

1. `path-filtered`
2. `ordinary-push-main`
3. `normal-ci-run`
4. `operational-skip`
5. `zero-job`
6. `api-error`
7. `partial-roster`
8. `genuine-failure`

The roster remains the exact 21-context set in the [required-context manifest](./required-ci-checks.json).
Do not infer completeness from job count, producer count, or payload count.

## Authoritative fields and clocks

Every consumed fact must retain one exact identity tuple and producer provenance:

- `identity.runId`, `identity.runAttempt`, `identity.headSha`, and
  `identity.treatmentId` identify the run, attempt, source, and treatment.
- `source.producerId` and `source.fingerprint` bind the evidence to its producer.
  Artifact and report joins must carry the same tuple; foreign or stale rows are not
  comparable.
- `rosterAuthority` points to the manifest and its fingerprint. The observed set must
  equal that authority; do not add a second list in a caller or in this guide.
- `terminal.createdAt` and `terminal.terminalAt` are same-run, same-attempt inputs for
  `terminalWallSeconds = terminalAt - createdAt`. The contract threshold is inclusive
  (at most 1,200 seconds). Job boundaries and `updatedAt` are diagnostic and cannot
  shorten the terminal wall or hide a reporting tail.
- Qualified job timing may retain pre-start, active, and total elapsed fields when
  their source timestamps and arithmetic are present. Pre-start elapsed time is not a
  claim of exact runner queue latency.
- Capacity keeps a declared virtual pool separate from an observed measurement and an
  unavailable reason. A runner label alone is not physical-capacity evidence.

An intentional skip remains a classification with its predicate, reason, and semantic
coverage fingerprint. It does not fabricate active time or turn a missing required
context into success.

## Comparison preconditions

Pass an array of `{ baseline, treatment }` packets as `pairs`. The existing
`compareMatchedPairs` owner admits each packet before comparing it. It requires all of
the following:

1. At least two distinct valid pairs are available; one fast run is
   `unknown-evidence`, not an improvement claim.
2. Baseline and treatment in each pair use the same full source head and one roster
   authority, but have distinct treatment identities. Repeated pairs must remain
   distinct observations.
3. Both sides preserve required-context correctness and intentional-skip semantics.
   A lost treatment context, changed skip, or treatment correctness regression is a
   protected failure.
4. Retry bounds and first-failure ordering do not worsen for the treatment. Capacity
   declarations remain matched and observations remain valid.
5. Each treatment terminal wall is within the contract and strictly lower than its
   matched baseline. Every pair must improve; an unrelated-run median cannot substitute.

The smallest JSON shape for the comparison boundary is a `pairs` array containing
distinct baseline and treatment packets:

```json
{
  "pairs": [
    {
      "baseline": {
        "schemaVersion": 1,
        "identity": {
          "runId": 4101,
          "runAttempt": 2,
          "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "treatmentId": "baseline"
        },
        "terminal": {
          "state": "completed",
          "createdAt": "2026-08-14T00:00:00.000Z",
          "terminalAt": "2026-08-14T00:15:00.000Z"
        }
      },
      "treatment": {
        "schemaVersion": 1,
        "identity": {
          "runId": 4102,
          "runAttempt": 2,
          "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "treatmentId": "treatment"
        },
        "terminal": {
          "state": "completed",
          "createdAt": "2026-08-14T00:00:00.000Z",
          "terminalAt": "2026-08-14T00:12:00.000Z"
        }
      }
    }
  ]
}
```

This one-pair fixture demonstrates input routing but remains `unknown-evidence` by
design. A comparison that can reach `slo-pass` needs complete packets on both sides,
the same head and roster authority, distinct treatment identities, and at least two
valid repeated pairs.

The deterministic precedence is: reject invalid or unknown packet evidence; reject a
baseline correctness failure; reject identity or roster mismatch; protect treatment
correctness and skip invariants; protect retry/first-failure stability and capacity;
then check terminal-wall breach and strict improvement. A protected treatment failure
is `rollback-required` even when its wall is faster. Fewer than two otherwise valid
pairs remains `unknown-evidence`. Only after every gate passes is the result `slo-pass`.

## Recovery is property-addressable

For every invalid, unknown, operational, or non-comparable result, read
`recoveryAction` as data:

```json
{
  "code": "roster-missing-context",
  "failureLayer": "source",
  "property": "roster.missing",
  "expected": "one classification object for every manifest context",
  "observed": ["smoke-fleet-1"],
  "detail": "A required context has no terminal classification",
  "action": "restore-roster-classification"
}
```

The fields are stable: `code`, `failureLayer`, `property`, `expected`, `observed`,
`detail`, and `action`. `failureLayer` is one of `source|terminal|delivery|comparison`.
When more than one layer is observable, `recoveryActions` retains every envelope in
the dependency order declared by the machine contract; `recoveryAction` is only the
first envelope for callers that need one primary next step. Later delivery evidence
must not replace an earlier source or terminal envelope:

- `source` identifies topology, identity, roster, or source-proof gaps.
- `terminal` identifies terminal state, clock, and terminal-wall gaps.
- `delivery` identifies producer, artifact, report, capacity, failure, retry, or
  normalization delivery gaps.
- `comparison` identifies matched-pair identity, correctness, stability, or improvement
  gaps.

The action is an evidence-only next step, such as recollecting the same identity,
waiting for terminality, restoring the authoritative roster classification, discarding
foreign evidence, or measuring capacity. It is never an instruction that the projection
itself performs. In particular, a recovery action does not execute `gh`, `fetch`,
`spawn`, a POST, a rerun, or a rollback.

Ownership stays single-source: the manifest owns the 21-context roster; the required-ci
classifier owns topology status; the terminal-SLO module owns
terminal, delivery, and comparison recovery factories; the admission module combines
those results; and the contract owns the required envelope fields, actions, and layers.
The required-ci-checks caller is not a recovery consumer.

### Topology and packet examples

| Observation | Result shape | Evidence-only next step |
| --- | --- | --- |
| Path filtering is asserted without an identity-matching proof | `status: path-filtered`, `fallbackEligible: false` | Recollect an identity-bound proof. |
| Ordinary push/main or a nonterminal run is supplied | The classifier status remains visible; no fallback | Recollect or wait for terminality as named by `recoveryAction`. |
| Required contexts are skipped, absent, duplicated, malformed, or extra | Non-success status with roster property paths | Restore the manifest classification; do not invent a substitute context. |
| No jobs or an API error is supplied | Non-success status with evidence property paths | Recollect readable run/job evidence. |
| A terminal packet has a foreign identity, provenance, clock, capacity, or schema | `invalid-evidence` or `unknown-evidence` | Discard foreign evidence, measure capacity, or recollect the named property. |
| A terminal wall exceeds the threshold | `slo-breach` at packet level | Keep the breach visible; policy decisions remain outside this projection. |

### Matched-pair examples

Pair recovery paths are prefixed with `pairs[<index>].baseline` or
`pairs[<index>].treatment` so an AI can route the next evidence operation without
string interpretation:

| Observation | Verdict | Recovery |
| --- | --- | --- |
| No pairs or only one valid pair | `unknown-evidence` | Recollect a second distinct exact-head pair. |
| Baseline and treatment heads or roster fingerprints differ | `invalid-evidence` | Discard foreign evidence and recollect the same head and authority. |
| Treatment loses a required context or changes an intentional skip | `rollback-required` | Restore the roster classification and exclude the treatment from the comparison. |
| Treatment introduces an earlier first failure or extra retry | `rollback-required` | Recollect the same attempt and inspect the named failure/retry property. |
| Treatment capacity changes or is label-only | `rollback-required` or `unknown-evidence` | Measure capacity; never infer it from a label. |
| Treatment is not strictly faster or breaches the terminal wall | `rollback-required` | Exclude the treatment; any policy rollback is delegated. |

## Local usage

```js
import { projectCiAdmission } from './check-ci-admission.mjs';

const result = projectCiAdmission(input);
console.log(result.status, result.fallbackEligible, result.recoveryAction, result.recoveryActions);
```

For matched evidence, provide `pairs` in the same input and read
`result.evidence.comparison.verdict`, `matchedPairs`, `pairs`, and its
`recoveryAction`. The projection is an evidence boundary: it reports what must be
recollected, restored, discarded, or measured, but it does not claim current CI
admission, treatment improvement, or rollback completion.
