# Dani-Free external inference: evidence and launch gate

Evidence collected 2026-09-20 UTC. This is a research result, not a release or a claim that the current gateway is production-ready.

## Decision

The user requires **both Kilo and OpenCode before launch**, and permits **public/non-sensitive data only**. Do not silently deliver Kilo-only as the completed product. Do not change current harness settings or restart legacy services as part of this investigation.

**Launch is blocked on authorized external access to OpenCode's free tier.** OpenCode's repository collaborator explicitly says that free-tier use in other harnesses is not permitted. A working CLI or session bridge is not equivalent to an independently usable inference API.

## Provider evidence

### Kilo: direct free inference is documented, but limited

[Official authentication documentation](https://kilo.ai/docs/gateway/authentication) documents anonymous access for free models, identified by IP and limited to **200 requests per hour per IP**. It also gives an external AI SDK integration. The API base is `https://api.kilo.ai/api/gateway`.

Consequences:

- Kilo does not require its agent harness for this documented HTTP access.
- One shared deployment shares an egress-IP allowance; multiple local subagents do not create extra quota. Tool-result continuation is another model request.
- This is not unlimited inference, a production availability commitment, or proof of permission to redistribute a commercial multi-tenant service.
- Anonymous mode must not forward user Authorization headers or read account credentials. Kilo documents that configured BYOK keys are automatically used and billed by the upstream provider even when the Kilo usage cost is zero. A reported `cost: 0` alone does not prove no billing.
- Documentation examples are not an up-to-date free-model allowlist.

### Fresh catalogue observation

A fresh anonymous GET of the [official model catalogue](https://api.kilo.ai/api/gateway/models) during this investigation returned all 19 previously specified candidate IDs. All 19 reported zero prompt/completion prices and zero other returned price dimensions excluding the non-price `discount` field. All 19 advertised tools. **All 19 also had `mayTrainOnYourPrompts: true`.**

This is catalogue evidence only: it does not establish live inference availability, tool reliability, context limits in practice, or a quality ranking. No production user prompts were sent in this investigation. The user's public/non-sensitive-only decision is material: free access must not silently become private-repository or customer-data inference.

Opaque routers such as `kilo-auto/free` and `openrouter/free` are not the same as choosing a vetted concrete model: their internal model choices can change. NVIDIA entries explicitly carry trial-use and no-personal/confidential-data warnings in the catalogue. Exclude these routes by default under the selected policy; do not treat an allowlist entry as blanket terms acceptance.

### OpenCode: generic Zen API support is not free-tier authorization

[Zen documentation](https://opencode.ai/docs/zen) describes external API endpoints, keys, prices, and multiple wire formats. Some models use `/responses`; others use `/chat/completions`. Generic API documentation does not establish authorization for every free offering.

In [issue 49621](https://github.com/anomalyco/opencode/issues/49621), a user reports HTTP 403 `FreeTierError` for third-party stacks while the genuine OpenCode client succeeds. The decisive primary-source evidence is the [repository collaborator's response](https://github.com/anomalyco/opencode/issues/49621#issuecomment-5723383322):

> We've been tightening our logic to fight abuse You cannot use the free tier in other harnesses (this is only a limitation for the free tier nothing else).

The issue's speculation about TLS fingerprints is not established fact. There is no reason to implement identity spoofing, session replay, or transport impersonation. A paid Zen key does not establish external access to the restricted free tier. `opencode serve` executes an OpenCode agent session; using it as an inference substitute changes ownership of the agent loop and fails the stated independence requirement.

## Current implementation audit

These findings describe the current source, not desired behavior:

| Finding | Evidence |
| --- | --- |
| Free admission checks IDs, not prices | `src/adapters/kilo.ts`, `KiloAdapter.listModels`: parse catalogue, then canonical-ID membership filter. |
| Capability metadata does not match the live catalogue schema | An injected row advertising `architecture.input_modalities: [text,image]` and `supported_parameters: [tools]` was reduced to `[text]`. |
| Health does not prove inference works | `KiloAdapter.health` only requests `/models`. |
| Stream timeout ends too soon | `src/router.ts`, `invokeWithTimeout` cancels its timer when the Response is returned, before streamed body consumption finishes. |
| The 90-second auto budget excludes discovery | `complete` starts the deadline after `resolveAutoWithTimeout`. |
| Downstream cancellation is not wired through | `handle` passes the parsed body to `complete`, not the incoming Request signal. |
| HTTP failure classes are lost | Kilo throws `KiloBackendError`; auto routing catches general errors as network failures, including non-retryable HTTP failures. |
| Automatic selection is preference ordering, not quality verification | `resolveAuto` selects healthy rows; it does not filter by request capability. |
| Current Kilo entrypoint is not a separate source boundary | `src/kilo-only.ts` imports the shared adapter and server modules. Changes there can affect legacy behavior on a later restart. |

### Executed isolated reproduction

A throwaway Bun program instantiated `KiloAdapter` with an injected fetcher. No network inference, account key, live service mutation, or harness invocation occurred. The catalogue fixture used an allowed ID with **nonzero** prompt/completion prices, image input, and tool support. Output:

```json
{"paidFixtureAdmitted":true,"advertisedCapabilities":["text"]}
```

Exit code 0. The temporary program was removed. This proves two audit defects; it does not claim they were repaired. Earlier reports claiming implemented zero-price validation or a full-stream request deadline are superseded by this evidence.

## Smallest correct product boundary

Externally: one provider named `dani-free`, one model named `auto`, an OpenAI Chat Completions base URL, and no extra agent harness. OMP's `dani-free/auto` notation combines provider and model; a generic OpenAI client normally sends `model: "auto"` to that configured provider URL.

Internally:

1. Admit only authorized concrete candidates in the explicit allowlist whose current pricing is verified zero; fail closed when price or required capability evidence is missing. Never fall back to a paid model or BYOK.
2. Match text/image/tool requirements before selecting a route. Do not strip tool schemas or transform tool calls into prose. Treat a coding-priority list as a hypothesis until measured against public coding workloads.
3. Pass messages and native streaming responses through. The calling product executes tools and sends tool results; the gateway must not execute workspace tools, spawn provider CLI sessions, or own subagents.
4. Bound discovery, attempts, and streaming; propagate cancellation; do not retry after response bytes have been emitted. Distinguish rate limits from authentication, unsupported requests, transport errors, and availability failures.
5. A 429 is a quota/availability signal, not permission to rotate identities. Respect retry guidance and report exhausted capacity clearly.
6. Enforce the public/non-sensitive use policy explicitly. Content inspection cannot prove data is non-sensitive; caller/operator attestation is a policy boundary, not automatic anonymization.
7. A remotely shared endpoint needs authenticated access and encrypted transport. Local loopback and internet multi-tenancy are separate deployment scopes. Do not expose the current local listener publicly.

Chat Completions compatibility does not automatically cover clients requiring OpenAI Responses, Anthropic Messages, or proprietary APIs. A routing layer cannot make every model equally capable or every client wire format interchangeable.

## Launch acceptance

Do not launch until all are satisfied:

- OpenCode supplies an authorized external free-inference path, with documented conditions, and direct inference works without its agent harness.
- Both providers pass independent no-paid-fallback and current-pricing checks.
- Isolated public-data scenarios prove text completion, native SSE termination, structured tool call, caller-side tool execution, tool-result continuation, and final answer.
- Cancellation, stalled streaming, non-retryable errors, quota exhaustion, and capability mismatch have observable bounded behavior.
- An actual client integration proves the caller retains its tools and agent loop; a single greeting or tool-call response is insufficient.
- Existing harness settings and legacy services remain unchanged unless the user explicitly requests a cutover.

No runtime source, service configuration, or harness configuration was changed by this investigation. The outstanding prerequisite is provider authorization, not another local proxy adapter.
