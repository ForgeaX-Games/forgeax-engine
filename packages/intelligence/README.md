# @forgeax/engine-intelligence

Provider-neutral asynchronous work for ForgeaX Engine. The public concept is an
`Activity`: submit bounded input, poll ordered bounded events, cancel it, and
retain only its provider-scoped `SessionRef` when conversation continuity is
needed. The package does not define prompts, agents, tools, skills, memory, or
gameplay components.

```ts
const started = intelligence.submit({ input: playerText, session: savedSession });
if (!started.ok) return;

for (const event of intelligence.poll()) {
  if (event.type === 'text-delta') dialogue.append(event.text);
  if (event.type === 'completed') savedSession = event.session;
}
```

`submit`, `poll`, and `cancel` never wait for provider work. Providers run
outside the frame loop and can receive no `World`, `Renderer`, or asset-writing
authority through this contract. A game must explicitly interpret and accept a
terminal result before mutating authoritative state.

## Realm boundary

`createIntelligencePortClient()` and `bindIntelligencePort()` carry only
structured-cloneable commands, identities, sessions, text, and structured
failures over an App `bootstrapPort`. The engine realm polls once per frame;
the Host owns provider SDKs, credentials, and subprocesses.

`IntelligencePortBinding.close()` is the Host-side terminal transition. It
shares one idempotent close task, closes the runtime before publishing
`intelligence-closed`, and then releases the port. A synchronous publication
fault is contained so physical release still runs and is awaited. When the
notification is delivered, the client treats it as terminal: it clears active
activities, rejected results, buffered events, and outstanding poll credit; late realm messages are ignored; later
`submit` and `cancel` return structured `intelligence-closed`, and `poll`
returns an empty list. A client-side `close()` is also idempotent and reuses
the same Promise, including when Host cleanup wins the race.

## Lifecycle

`intelligencePlugin(service)` provides the optional Cordis service and closes
it when the Fiber is disposed. Disposal is terminal and best-effort: a provider
close failure cannot strand the realm transport, and callbacks from the closed
provider are ignored. Output and concurrency bounds are explicit in
`IntelligenceLimits`; streamed output is counted cumulatively and completion
payloads are checked independently. Either output-character bound terminates
the affected Activity with one `intelligence-output-overflow` terminal whose
`detail.bound` is `'output-chars'` and whose `detail.limit` is the
configured limit, instead of growing an unbounded queue.
